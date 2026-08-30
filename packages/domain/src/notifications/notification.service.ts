import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { isUniqueViolation } from '../identity/user.service';

export interface QueuedNotification {
  id: string;
  /** False when this key had already been queued — a redelivery, not a new one. */
  created: boolean;
}

export interface NotificationToSend {
  id: string;
  userId: string;
  templateKey: string;
  payload: Prisma.JsonValue;
  attempts: number;
  /** Null when the account has no Telegram link, which should not happen. */
  telegramUserId: bigint | null;
  botBlocked: boolean;
}

/**
 * The notification ledger (ADR-0005, plan §4.6).
 *
 * **The exactly-once *effect* lives here**, and it is the second of two
 * independent layers. BullMQ's deterministic `jobId` is the first: re-adding an
 * existing id is a no-op. `dedupe_key` is this one: a UNIQUE index in Postgres,
 * so a queue that was flushed, replayed or migrated still cannot produce a second
 * message. Either would cover most failure modes; both are cheap and they fail
 * independently, which is the whole reason for having two.
 *
 * The row is also the answer to "did we tell them?" — a question support gets
 * constantly and which a log line cannot answer six weeks later.
 */
@Injectable()
export class NotificationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Record a notification, or recognise that it already exists.
   *
   * The insert is attempted and the unique violation is caught, rather than
   * reading first: a read-then-write has a window between the two, and two relay
   * passes racing over the same outbox row is exactly the case this exists for.
   */
  async queue(input: {
    userId: string;
    templateKey: string;
    dedupeKey: string;
    payload: Prisma.InputJsonValue;
  }): Promise<QueuedNotification> {
    try {
      const created = await this.prisma.notification.create({
        data: {
          userId: input.userId,
          templateKey: input.templateKey,
          dedupeKey: input.dedupeKey,
          payload: input.payload,
          createdAt: this.clock.now(),
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const existing = await this.prisma.notification.findUniqueOrThrow({
        where: { dedupeKey: input.dedupeKey },
        select: { id: true },
      });
      return { id: existing.id, created: false };
    }
  }

  /**
   * Everything the sender needs, including whether there is anybody to send to.
   *
   * `telegram_user_id` is read **here and nowhere else outside `identity`** — this
   * is the one path that legitimately needs it, because it is the path that
   * actually talks to Telegram. It goes to the Telegram client and never into a
   * payload, a log line or a response (invariant 7).
   */
  async load(id: string): Promise<NotificationToSend | null> {
    const row = await this.prisma.notification.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        templateKey: true,
        payload: true,
        attempts: true,
        status: true,
        user: {
          select: { telegramAccount: { select: { telegramUserId: true, botBlocked: true } } },
        },
      },
    });
    if (!row) return null;
    // Already delivered. A redelivered job finds this and stops, which is the
    // dedupe key doing its job on the *send* side rather than the queue side.
    if (row.status === 'SENT' || row.status === 'UNDELIVERABLE') return null;

    return {
      id: row.id,
      userId: row.userId,
      templateKey: row.templateKey,
      payload: row.payload,
      attempts: row.attempts,
      telegramUserId: row.user.telegramAccount?.telegramUserId ?? null,
      botBlocked: row.user.telegramAccount?.botBlocked ?? false,
    };
  }

  /**
   * "Which conversation is this a reply to?"
   *
   * The bot's relay needs it. A user with several live chats types into one Telegram
   * conversation, so a plain message names no chat — but a *reply* does, implicitly:
   * it quotes a message this product sent, and `markSent` recorded what Telegram
   * called that message. Looking the id up in the recipient's own rows turns a reply
   * into a chat id with no state to keep and nothing to trust from the client.
   *
   * Scoped to `userId`, which is the authorisation: an id from somebody else's
   * conversation finds nothing here, so a forged `reply_to_message` cannot address a
   * chat the sender is not in. Membership is still checked by `ChatService.send`.
   *
   * Returns null for a reply to something that is not a relayed message — a
   * welcome, a review reminder, or a message the user wrote themselves.
   */
  /**
   * Where to reach a user on Telegram, for a send that is not a notification.
   *
   * ── Why this is here and not in the job payload ─────────────────────────────
   *
   * A wizard redraw (ADR-0017) is addressed by `(chat_id, message_id)`, and the
   * obvious shortcut is to put the chat id in the job. That would make Redis the
   * one place outside `identity` holding a `telegram_user_id`, which invariant 7
   * exists to prevent — and it would be the only such place, so nothing else
   * would ever remind anybody it was there.
   *
   * Instead the job carries the internal `user_id` and the worker resolves it
   * here at delivery, which is exactly what `load` already does for every
   * notification. Same rule, same module, one resolution path.
   *
   * `botBlocked` comes back with it because the caller must not send to somebody
   * who has blocked the bot: retrying burns rate budget other users need.
   */
  async telegramTargetFor(
    userId: string,
  ): Promise<{ telegramUserId: bigint; botBlocked: boolean } | null> {
    const account = await this.prisma.telegramAccount.findUnique({
      where: { userId },
      select: { telegramUserId: true, botBlocked: true },
    });
    return account === null
      ? null
      : { telegramUserId: account.telegramUserId, botBlocked: account.botBlocked };
  }

  async chatOfDeliveredMessage(userId: string, telegramMessageId: number): Promise<string | null> {
    const row = await this.prisma.notification.findFirst({
      where: { userId, telegramMessageId },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    if (!row) return null;

    const payload = row.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

    const chatPublicId = (payload as Record<string, unknown>)['chatPublicId'];
    return typeof chatPublicId === 'string' && chatPublicId !== '' ? chatPublicId : null;
  }

  async markSent(id: string, telegramMessageId: number | null): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'SENT',
        sentAt: this.clock.now(),
        telegramMessageId,
        attempts: { increment: 1 },
      },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: 'FAILED',
        // Truncated: an error string is written by a library and a whole stack
        // trace in a column nobody reads is a column nobody reads.
        lastError: error.slice(0, 500),
        attempts: { increment: 1 },
      },
    });
  }

  /**
   * The bot is blocked, so there is nobody to deliver to.
   *
   * Terminal, and **not** a failure to retry: retrying a block burns the global
   * rate budget that other users' notifications need (ADR-0005). The flag on
   * `telegram_account` is what the Mini App reads to show its re-start banner —
   * the only fix is the user's, and the product cannot make it for them (§12.6).
   */
  /**
   * The recipient asked not to receive this category (v0.6.1).
   *
   * Terminal, and it touches nothing but this row: an opt-out is not a block,
   * and `markUndeliverable`'s `bot_blocked` write would suppress every category
   * rather than one and put a re-start banner in front of somebody whose bot
   * works fine.
   *
   * `attempts` is left alone. Nothing was attempted.
   */
  async markSuppressed(id: string): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: 'SUPPRESSED' },
    });
  }

  async markUndeliverable(id: string, userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.notification.update({
        where: { id },
        data: { status: 'UNDELIVERABLE', attempts: { increment: 1 } },
      }),
      this.prisma.telegramAccount.updateMany({
        where: { userId },
        data: { botBlocked: true },
      }),
    ]);
  }
}
