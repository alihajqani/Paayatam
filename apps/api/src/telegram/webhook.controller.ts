import { timingSafeEqual } from 'node:crypto';
import {
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
import { Public } from '../auth/auth.guard';

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

  constructor(@Inject(ENV) private readonly env: Env) {}

  @Public()
  @Post('webhook/:secretPath')
  @HttpCode(HttpStatus.OK)
  handleUpdate(
    @Param('secretPath') secretPath: string,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string | undefined,
  ): { ok: true } {
    if (!this.isAuthentic(secretPath, secretToken)) {
      // Logged without the offered values: they are attacker-controlled and one of
      // them is a near-miss of a real credential (T15).
      this.logger.warn('Rejected a webhook request that failed secret verification');
      return { ok: true };
    }

    // Update dispatch to the grammY bot lands with the /start handler. Returning
    // 200 already is correct: Telegram only needs to know we received it.
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
