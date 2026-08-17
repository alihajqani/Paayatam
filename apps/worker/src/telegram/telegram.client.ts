import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { autoRetry } from '@grammyjs/auto-retry';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';
import type { InlineKeyboard } from '@payetam/telegram';

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
  private readonly channelId: string | undefined;
  readonly botUsername: string;

  constructor(@Inject(ENV) env: Env) {
    this.channelId = env.TELEGRAM_CHANNEL_ID;
    // Only used to build the deep link in a channel post. A wrong value produces a
    // broken link rather than a wrong destination, so it is not worth failing over.
    this.botUsername = env.TELEGRAM_BOT_USERNAME ?? 'payetam_bot';
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
  /**
   * Post to the channel.
   *
   * A separate method from `send` because the failure modes differ: a channel post
   * that fails is not "this user blocked us", it is "the bot is not an admin of
   * the channel" or "the channel id is wrong" — configuration problems that a
   * retry will not fix but which must be loud rather than silently marking
   * somebody undeliverable.
   */
  async postToChannel(text: string): Promise<SendOutcome> {
    if (!this.bot) return { kind: 'RETRY', reason: 'TELEGRAM_BOT_TOKEN is not configured' };
    if (this.channelId === undefined || this.channelId === '') {
      return { kind: 'RETRY', reason: 'TELEGRAM_CHANNEL_ID is not configured' };
    }

    try {
      const message = await this.bot.api.sendMessage(this.channelId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return { kind: 'SENT', messageId: message.message_id };
    } catch (error) {
      return classify(error);
    }
  }

  /**
   * Take a channel post down.
   *
   * A message that is already gone counts as success: the goal is "this is not in
   * the channel", and something else having removed it first satisfies that. Any
   * other reading would retry forever against a message that does not exist.
   */
  async deleteChannelPost(messageId: number): Promise<boolean> {
    if (!this.bot || this.channelId === undefined || this.channelId === '') return false;

    try {
      await this.bot.api.deleteMessage(this.channelId, messageId);
      return true;
    } catch (error) {
      const outcome = classify(error);
      if (outcome.kind === 'SENT') return true;
      if (outcome.kind === 'BLOCKED') return true;
      // Telegram refuses to delete anything older than 48 hours in some chats.
      // Treated as done for the same reason a missing message is: retrying cannot
      // change it, and the row must stop being reconsidered on every sweep.
      return /message to delete not found|message can't be deleted/i.test(outcome.reason);
    }
  }

  async send(chatId: bigint, text: string, keyboard?: InlineKeyboard): Promise<SendOutcome> {
    if (!this.bot) return { kind: 'RETRY', reason: 'TELEGRAM_BOT_TOKEN is not configured' };

    try {
      const message = await this.bot.api.sendMessage(Number(chatId), text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard !== undefined ? { reply_markup: toReplyMarkup(keyboard) } : {}),
      });
      return { kind: 'SENT', messageId: message.message_id };
    } catch (error) {
      return classify(error);
    }
  }

  /**
   * Answer an inline-keyboard tap.
   *
   * **Failure is not worth retrying.** A callback query id is valid for a few
   * seconds; by the time a backoff has elapsed, answering it can only fail again,
   * and the *work* the tap asked for was committed before this was ever enqueued.
   * The visible consequence of losing this is a spinner that times out on a
   * decision that was in fact recorded — which is why the toast is a courtesy and
   * the notification the other party receives is the real confirmation.
   *
   * Text is plain, not HTML: Telegram renders a callback answer as a toast and
   * ignores `parse_mode` entirely. It is truncated to Telegram's 200-character
   * limit rather than sent and refused.
   */
  async answerCallback(callbackQueryId: string, text: string): Promise<boolean> {
    if (!this.bot) return false;

    try {
      await this.bot.api.answerCallbackQuery(callbackQueryId, { text: text.slice(0, 200) });
      return true;
    } catch (error) {
      const outcome = classify(error);
      this.logger.warn(
        `Could not answer a callback query: ${outcome.kind === 'SENT' ? 'unknown' : outcome.reason}`,
      );
      return false;
    }
  }
}

/**
 * Our keyboard shape → Telegram's.
 *
 * The translation lives here because this is the file that already knows the wire
 * format; `packages/telegram` builds keyboards as plain data so the message
 * catalogue stays testable with no bot instance and no token.
 */
function toReplyMarkup(keyboard: InlineKeyboard): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) =>
        button.url !== undefined
          ? { text: button.text, url: button.url }
          : { text: button.text, callback_data: button.callbackData ?? '' },
      ),
    ),
  };
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
