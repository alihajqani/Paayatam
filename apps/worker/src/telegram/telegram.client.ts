import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, GrammyError, HttpError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';

/** What a send attempt produced, classified so the caller can decide what to do. */
export type SendOutcome =
  | { kind: 'SENT'; messageId: number }
  /** The bot is blocked or the chat is gone. Terminal — never retry (ADR-0005). */
  | { kind: 'BLOCKED'; reason: string }
  /** Anything else. The queue's backoff applies. */
  | { kind: 'RETRY'; reason: string };

/**
 * The one place in the product that calls Telegram (plan §3.2, invariant 11).
 *
 * Two behaviours matter more than the sending:
 *
 * **429 is handled beneath this method, by `auto-retry`.** grammY's plugin reads
 * `retry_after` from the response and sleeps for exactly that long before trying
 * again, which is the only correct response to a rate limit — a fixed backoff
 * either wastes time or comes back too early and earns a longer penalty.
 *
 * **403 is terminal and is not a failure.** A blocked bot has nobody to deliver
 * to, and retrying burns the global rate budget that other users' notifications
 * need. It comes back as `BLOCKED` rather than as a thrown error precisely so the
 * caller cannot accidentally treat it as something to retry.
 */
@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);
  private readonly bot: Bot | null;

  constructor(@Inject(ENV) env: Env) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (token === undefined || token === '') {
      // Development and CI have no token. Failing at construction would stop the
      // worker booting at all, which would take every sweep down with it — so the
      // client reports the absence per send instead.
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set — sends will be reported as retryable.');
      this.bot = null;
      return;
    }

    this.bot = new Bot(token);
    // `maxDelaySeconds` bounds how long one job may sit inside a single attempt.
    // Past that the queue's own backoff is the better place to wait, because a job
    // sleeping inside the worker holds a concurrency slot and a queued one does
    // not.
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 30 }));
  }

  /**
   * Send one message.
   *
   * `link_preview_options.is_disabled` is not cosmetic: a preview would make
   * Telegram fetch whatever URL a user pasted into a chat message, turning the
   * relay into a request-forger on their behalf (T11 refuses exactly this for
   * `external_link`).
   */
  async send(chatId: bigint, text: string): Promise<SendOutcome> {
    if (!this.bot) return { kind: 'RETRY', reason: 'TELEGRAM_BOT_TOKEN is not configured' };

    try {
      const message = await this.bot.api.sendMessage(Number(chatId), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return { kind: 'SENT', messageId: message.message_id };
    } catch (error) {
      return classify(error);
    }
  }
}

/**
 * Which failures are worth another attempt.
 *
 * 403 and "chat not found" are the same situation from the product's side —
 * there is no longer anybody at the other end — so both are terminal. 400 is a
 * malformed request, which retrying cannot fix either, but it is *our* bug rather
 * than the user's, so it stays retryable-and-loud: it will exhaust into
 * `job_failure` where somebody can see it, instead of being silently swallowed as
 * "undeliverable" and marking an innocent account as having blocked the bot.
 */
export function classify(error: unknown): SendOutcome {
  if (error instanceof GrammyError) {
    if (error.error_code === 403) return { kind: 'BLOCKED', reason: error.description };
    if (error.error_code === 400 && /chat not found/i.test(error.description)) {
      return { kind: 'BLOCKED', reason: error.description };
    }
    return { kind: 'RETRY', reason: `${String(error.error_code)}: ${error.description}` };
  }

  if (error instanceof HttpError)
    return { kind: 'RETRY', reason: 'network error reaching Telegram' };
  return { kind: 'RETRY', reason: error instanceof Error ? error.message : 'unknown error' };
}
