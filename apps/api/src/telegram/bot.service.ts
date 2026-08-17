import { Injectable, Logger } from '@nestjs/common';
import {
  ChatService,
  NotificationService,
  ParticipationService,
  ReferralService,
  UserService,
} from '@payetam/domain';
import {
  JOBS,
  QUEUES,
  QueueService,
  RATE_LIMITS,
  RateLimitService,
  jobId,
} from '@payetam/platform';
import { AppError, ERROR_MESSAGES_FA, ErrorCode } from '@payetam/shared';
import {
  TEMPLATES,
  parseChatCallback,
  type BotInboundText,
  type BotSender,
  type ParsedUpdate,
} from '@payetam/telegram';

/**
 * What a reply interpolates.
 *
 * JSON scalars only, and stated as a type rather than as `Record<string, unknown>`
 * with a cast at the Prisma boundary: a notification payload is rendered into a
 * message body, so the shape that reaches it should be the shape a template can
 * read (invariant 7 — public ids and numbers, never an object somebody spread).
 */
type ReplyPayload = Record<string, string | number | boolean>;

/** The sender, resolved. Both ids, because the rate limiter is keyed on the public one. */
interface BotUser {
  id: string;
  publicId: string;
}

/**
 * The bot's receiving half (plan §6: `/start`, `callback_query`, `message:text`,
 * `edited_message`, `my_chat_member`).
 *
 * Outstanding since M2 named `/start` in its acceptance criteria, and deferred with
 * a note in M13: *"M13 builds the outbound half… The inbound half needs a webhook
 * handler wired to grammY, and M8's release gate therefore remains open."* This is
 * that handler.
 *
 * Three properties shape everything below.
 *
 * **It calls the same services the Mini App does.** Nothing here decides who may
 * accept a request, whether a chat is live, or whether a phone number is masked —
 * `ParticipationService` and `ChatService` do, and a rule enforced in one surface
 * protects one surface. That is what makes plan §3.3's "the bot and the Mini App
 * behave identically" true by construction rather than by two implementations being
 * kept in step.
 *
 * **It never calls Telegram.** Every reply is a row plus an enqueue, which is
 * ADR-0004's "validate, persist, enqueue" and ADR-0005's "all outbound Telegram
 * calls happen in the worker". A reply sent from here would also bypass the global
 * rate limiter, and that limiter's headroom is what keeps a notification backlog
 * from starving somebody who is watching a spinner.
 *
 * **A reply is a `notification` row.** Not a fire-and-forget send: it is deduped by
 * a UNIQUE index on a key derived from Telegram's own `update_id`, so a redelivered
 * update produces one message; it goes out through the same renderer, the same rate
 * limiter and the same block detection as every other message; and it answers "did
 * we tell them?" six weeks later, which a log line cannot.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly users: UserService,
    private readonly chats: ChatService,
    private readonly participation: ParticipationService,
    private readonly referrals: ReferralService,
    private readonly notifications: NotificationService,
    private readonly queues: QueueService,
    private readonly limiter: RateLimitService,
  ) {}

  /**
   * Handle one update.
   *
   * Every failure is caught here. The webhook answers 200 by contract (ADR-0004),
   * so a throw escaping this method would become an unhandled rejection and nothing
   * else — and an `AppError` is not a bug in any case: it is the product refusing
   * something, and the refusal has already been relayed in Persian by whoever
   * caught it closer to the action.
   */
  async dispatch(update: ParsedUpdate): Promise<void> {
    try {
      await this.route(update);
    } catch (error) {
      if (error instanceof AppError) {
        this.logger.log(`Update ${String(update.updateId)} refused: ${error.code}`);
        return;
      }
      // The message is logged; the update is not. It carries a Telegram id and a
      // message body, and neither belongs in a log line (invariant 7, T15).
      this.logger.error(
        `Update ${String(update.updateId)} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async route(update: ParsedUpdate): Promise<void> {
    const intent = update.intent;

    switch (intent.kind) {
      // `/start` is the one surface that may *create* an account, which is what
      // makes it the only entry point: everything else requires having met.
      case 'START':
        return this.onStart(update.updateId, intent.from, intent.payload);

      case 'BLOCK_CHANGED':
        // No reply, for the obvious reason. The flag is what stops the sender
        // retrying against somebody who is gone; unblocking clears it, and so does
        // any later `/start`.
        await this.users.markBotBlocked(intent.from.telegramUserId, intent.blocked);
        return;

      case 'CALLBACK':
        return this.onCallback(intent.from, intent.callbackQueryId, intent.data);

      default: {
        const user = await this.knownUser(intent.from);
        if (user === null) return;

        switch (intent.kind) {
          case 'TEXT':
            return this.onText(update.updateId, user, intent.message, intent.replyToMessageId);

          case 'EDITED_TEXT':
            return this.onEdit(update.updateId, user, intent.message);

          /** Criterion 11, through the bot: a Persian refusal, and nothing stored. */
          case 'UNSUPPORTED':
            return this.notice(
              update.updateId,
              user,
              ERROR_MESSAGES_FA[ErrorCode.CHAT_MEDIA_UNSUPPORTED],
            );

          case 'COMMAND':
            return this.notice(
              update.updateId,
              user,
              'این فرمان را نمی‌شناسم. برای شروع /start را بفرستید.',
            );
        }
      }
    }
  }

  /**
   * `/start [payload]` — M2's acceptance criterion: it creates exactly one user.
   *
   * The idempotency is `UserService`'s and it is the database's: two simultaneous
   * taps race to insert against a UNIQUE `telegram_user_id`, and the loser re-reads
   * rather than creating a second account.
   *
   * The payload is a referral code (T6). A failed claim **does not stop the
   * welcome**: somebody arriving on a stale invite link should be greeted by a
   * product rather than by an error, and `ALREADY_REFERRED` — which is what pressing
   * a start link twice produces — is not something to apologise for.
   */
  private async onStart(updateId: number, from: BotSender, payload: string | null): Promise<void> {
    const created = await this.users.findOrCreateByTelegram(from);
    const userId = await this.users.resolveInternalId(created.publicId);

    if (payload !== null) {
      try {
        const claim = await this.referrals.claim(userId, stripReferralPrefix(payload));
        await this.reply(updateId, userId, TEMPLATES.BOT_REFERRAL_ACCEPTED, {
          pendingCoins: claim.pendingCoins,
        });
        return;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        this.logger.log(`Referral payload on /start was refused: ${error.code}`);
      }
    }

    await this.reply(updateId, userId, TEMPLATES.BOT_WELCOME, {});
  }

  /**
   * Plain text in the bot's DM, relayed into a conversation.
   *
   * **Which conversation is the whole difficulty.** A user holds one Telegram chat
   * with the bot and may hold several anonymous chats behind it, and a typed message
   * names none of them. Two answers, in order:
   *
   *  1. **A reply** quotes a message we sent, and `notification.telegram_message_id`
   *     records what Telegram called it. That is exact, and the lookup is scoped to
   *     the sender's own rows — so a forged `reply_to_message` cannot address a
   *     stranger's conversation.
   *  2. **Exactly one live chat** needs no ceremony, and is the common case.
   *
   * With two live chats and no reply the answer is genuinely unknown, and the only
   * safe action is to say so. Delivering a private message to the wrong stranger is
   * the single worst thing this relay could do.
   */
  private async onText(
    updateId: number,
    user: BotUser,
    message: BotInboundText,
    replyToMessageId: number | null,
  ): Promise<void> {
    // The same bucket the Mini App's send spends from, keyed on the same subject: a
    // limit enforced on one of two surfaces is not a limit (T12).
    const verdict = await this.limiter.consume('CHAT_SEND', user.publicId, RATE_LIMITS.CHAT_SEND);
    if (!verdict.allowed) {
      await this.notice(updateId, user, ERROR_MESSAGES_FA[ErrorCode.RATE_LIMITED]);
      return;
    }

    const quoted =
      replyToMessageId === null
        ? null
        : await this.notifications.chatOfDeliveredMessage(user.id, replyToMessageId);
    const chatPublicId = quoted ?? (await this.chats.singleLiveChatFor(user.id));

    if (chatPublicId === null) {
      await this.notice(updateId, user, await this.ambiguityAdvice(user.id));
      return;
    }

    try {
      await this.chats.send(user.id, chatPublicId, message);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * The sender edited something they had already sent (D10).
   *
   * `NOT_FOUND` is silence rather than a notice. Telegram sends an `edited_message`
   * for every edit in the bot's DM, including edits to messages that were never
   * relayed anywhere, and answering «پیدا نشد» to those would have the bot arguing
   * with people about their own typing.
   */
  private async onEdit(updateId: number, user: BotUser, message: BotInboundText): Promise<void> {
    if (message.telegramMessageId === undefined) return;

    try {
      await this.chats.editBySourceMessage(user.id, message.telegramMessageId, message);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === ErrorCode.NOT_FOUND) return;
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * An inline-keyboard tap: `chat:accept|reject|close:<id>`.
   *
   * The toast is the *only* reply, and it is enqueued rather than sent. Accepting
   * and rejecting already notify the other party through the outbox, so a second
   * message to the person who pressed the button would be the product telling
   * somebody what they had just done.
   *
   * Authorisation is entirely the services': `accept` and `reject` verify that the
   * caller hosts the event, `close` verifies membership. A tampered button therefore
   * names a resource somebody does not own and is refused with the same Persian
   * sentence the API would return (T3.2) — the button carries no authority.
   */
  private async onCallback(from: BotSender, callbackQueryId: string, data: string): Promise<void> {
    const user = await this.knownUser(from);
    if (user === null) {
      await this.answer(callbackQueryId, 'برای شروع /start را بفرستید.');
      return;
    }

    const callback = parseChatCallback(data);
    if (callback === null) {
      // An old build's button, or a tampered one. Indistinguishable to the person
      // who pressed it, and the same sentence serves both.
      await this.answer(callbackQueryId, 'این دکمه دیگر کار نمی‌کند.');
      return;
    }

    try {
      switch (callback.action) {
        case 'accept':
          await this.participation.accept(user.id, callback.id);
          await this.answer(callbackQueryId, 'پذیرفته شد ✅');
          return;

        case 'reject':
          await this.participation.reject(user.id, callback.id);
          await this.answer(callbackQueryId, 'رد شد');
          return;

        case 'close':
          await this.chats.close(user.id, callback.id);
          await this.answer(callbackQueryId, 'گفتگو بسته شد 🔒');
          return;
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.answer(callbackQueryId, ERROR_MESSAGES_FA[error.code]);
    }
  }

  // ── replying ────────────────────────────────────────────────────────────────

  /**
   * Queue one reply and ask the worker to send it.
   *
   * The dedupe key is Telegram's `update_id`, which is monotonic and unique per
   * bot: a redelivered update — Telegram retries any webhook call that did not
   * answer 200 — produces the same key, the UNIQUE index absorbs the second
   * attempt, and the deterministic BullMQ job id makes the enqueue idempotent as
   * well. ADR-0005's two layers, applied to an inbound cause instead of an outbox
   * row.
   */
  private async reply(
    updateId: number,
    userId: string,
    templateKey: string,
    payload: ReplyPayload,
  ): Promise<void> {
    const queued = await this.notifications.queue({
      userId,
      templateKey,
      dedupeKey: `bot:${String(updateId)}`,
      payload,
    });
    // Already queued by an earlier delivery of this same update. Enqueueing again
    // would be harmless — the job id is the same — but saying so is clearer.
    if (!queued.created) return;

    await this.queues.enqueue(
      QUEUES.TELEGRAM_SEND,
      JOBS.SEND_NOTIFICATION,
      jobId('notify', queued.id),
      { notificationId: queued.id },
    );
  }

  /** A one-sentence reply in the bot's own voice, rather than about an event. */
  private async notice(updateId: number, user: BotUser, text: string): Promise<void> {
    await this.reply(updateId, user.id, TEMPLATES.BOT_NOTICE, { text });
  }

  private async answer(callbackQueryId: string, text: string): Promise<void> {
    await this.queues.enqueue(
      QUEUES.TELEGRAM_SEND,
      JOBS.BOT_CALLBACK_ANSWER,
      // Telegram's callback query id is unique per tap, so it is the job id: a
      // redelivered update answers the same query once.
      jobId('callback', callbackQueryId),
      { callbackQueryId, text },
    );
  }

  // ── resolving ───────────────────────────────────────────────────────────────

  /**
   * The sender, or null when we have never met them or they may not be here.
   *
   * **Null is silence, not a prompt.** Replying "press /start" needs a notification
   * row and there is no user to hang one on; the alternative — a job carrying a raw
   * Telegram id — would put an identifier into Redis to deliver a sentence almost
   * nobody will see. Telegram's own clients send `/start` on first contact and
   * `/start` creates the account, so the case this drops is a user whose account has
   * been anonymised (M15) writing again, and their next `/start` works normally.
   *
   * A banned or deleted account is silence for the same reason it is a 403 in the
   * API: `assertUsable` in `UserService` is the rule, and repeating it here keeps the
   * bot from becoming the one surface that forgot.
   */
  private async knownUser(from: BotSender): Promise<BotUser | null> {
    const user = await this.users.findByTelegramId(from.telegramUserId);
    if (!user || user.status === 'BANNED' || user.status === 'DELETED') return null;

    return { id: await this.users.resolveInternalId(user.publicId), publicId: user.publicId };
  }

  /**
   * What to say when a plain message could belong to any of several conversations.
   *
   * Two situations, two answers, and telling them apart matters: somebody with no
   * live chat has nothing to reply *to*, so advising them to press "reply" would be
   * instructions they cannot follow.
   */
  private async ambiguityAdvice(userId: string): Promise<string> {
    const live = (await this.chats.listForUser(userId)).filter(
      (chat) => chat.status === 'ANONYMOUS' || chat.status === 'OPEN',
    );

    return live.length === 0
      ? 'گفتگوی بازی ندارید. از برنامه یک فعالیت انتخاب کنید و درخواست پیوستن بفرستید.'
      : 'چند گفتگوی باز دارید. روی پیام همان نفر «Reply» بزنید تا بدانم پاسخ برای کدام گفتگو است.';
  }
}

/**
 * `/start ref_ABCD2345` and `/start ABCD2345` are the same invitation.
 *
 * A prefix is what a link generator naturally adds. `normalizeCode` in the domain
 * strips whitespace and hyphens but not this, and it is stripped here — where the
 * link format is known — rather than by loosening a validator the API also uses.
 */
function stripReferralPrefix(payload: string): string {
  return payload.replace(/^ref[_-]/i, '');
}
