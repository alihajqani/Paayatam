import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
} from '@nestjs/common';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';
import { parseUpdate } from '@payetam/telegram';
import { Public } from '../auth/auth.guard';
import { BotService } from './bot.service';

/**
 * Telegram webhook receiver (ADR-0004).
 *
 * Three properties this endpoint must have, in order of importance:
 *
 * 1. **It always returns 200.** Whatever it decides internally — bad secret, unknown
 *    user, malformed update — the response is identical. A 401 here would let an
 *    attacker probe for valid secrets, and a 500 would make Telegram retry an update
 *    we have already rejected.
 *
 * 2. **Both secrets are compared in constant time.** The path segment and the
 *    `X-Telegram-Bot-Api-Secret-Token` header are independent; either alone would do,
 *    and having both means a leak of the URL (proxy logs, browser history) is not on
 *    its own enough.
 *
 * 3. **It does the minimum synchronous work.** Updates are handed to the bot and the
 *    response returns; no outbound Telegram call happens on this path (ADR-0005).
 */
@Controller('telegram')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly bot: BotService,
  ) {}

  @Public()
  @Post('webhook/:secretPath')
  @HttpCode(HttpStatus.OK)
  async handleUpdate(
    @Param('secretPath') secretPath: string,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (!this.isAuthentic(secretPath, secretToken)) {
      // Logged without the offered values: they are attacker-controlled and one of
      // them is a near-miss of a real credential (T15).
      this.logger.warn('Rejected a webhook request that failed secret verification');
      // **Returned before the body is parsed at all.** Criterion 16 is "rejected
      // without processing", and that is a property of this ordering rather than of
      // a comment: nothing below this line runs for a request with a wrong secret.
      return { ok: true };
    }

    const update = parseUpdate(body);
    // Null is ordinary: Telegram sends updates for things this product has no
    // opinion about — a post in our own channel, a poll answer — and every one of
    // them is ignored quietly.
    if (update === null) return { ok: true };

    /**
     * Awaited, not fired and forgotten.
     *
     * The tempting alternative is to return immediately and let the handler run on,
     * and it is wrong twice over: an update whose work is still in flight when the
     * process is replaced is lost with no record anywhere, and Telegram's
     * *sequential* delivery per chat is what keeps two quick messages in the order
     * they were typed. `dispatch` is bounded — a few indexed queries, one
     * transaction, one enqueue — and does no outbound Telegram call at all
     * (ADR-0004: validate, persist, enqueue).
     *
     * It cannot throw: `dispatch` catches everything, precisely so this stays a 200
     * whatever happens inside.
     */
    await this.bot.dispatch(update);
    return { ok: true };
  }

  private isAuthentic(secretPath: string, secretToken: string | undefined): boolean {
    const expectedPath = this.env.TELEGRAM_WEBHOOK_SECRET_PATH;
    const expectedToken = this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;

    // Unconfigured means nothing can be authentic. Never fall through to "allow".
    if (!expectedPath || !expectedToken) {
      this.logger.error('Telegram webhook secrets are not configured; rejecting all updates');
      return false;
    }

    return (
      constantTimeEquals(secretPath, expectedPath) && constantTimeEquals(secretToken, expectedToken)
    );
  }
}

/** Length-safe constant-time compare; `timingSafeEqual` throws on differing lengths. */
function constantTimeEquals(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
