import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';

export interface PurgeResult {
  chatMessages: number;
  chats: number;
  notifications: number;
  auditRows: number;
  outboxRows: number;
  idempotencyKeys: number;
}

/**
 * Everything that points at `anonymous_chat`, all four with `onDelete: Restrict`.
 *
 * Written down because the first version of this service deleted `chat_message` and
 * then the chat, which fails on every real conversation — a chat always has two
 * `chat_participant` rows, and RESTRICT means the delete raises rather than
 * cascading. The integration test caught it; nothing else would have, because an
 * empty database purges perfectly and so does one holding only messages.
 *
 * Exported so a test can compare it against `pg_constraint` rather than against
 * somebody's memory. A fifth table added in a later milestone would otherwise turn
 * the nightly purge into a nightly exception, and the only symptom would be chat
 * bodies quietly outliving the ninety days they were promised.
 */
export const CHAT_DEPENDENTS = [
  'chat_message',
  'chat_action',
  'chat_participant',
  'chat_unseal_grant',
] as const;

/**
 * Retention, in days, from §8's table.
 *
 * Constants for the same reason the rate limits are: these are legal and policy
 * commitments made to users in a privacy notice, not knobs to be turned by whoever
 * has admin access. Changing one should be a deploy somebody reviews.
 */
export const RETENTION = {
  /** §8: chat bodies, **90 days after the chat closes** — not after they were sent. */
  CHAT_DAYS: 90,
  /** §4.6: notifications, six months. */
  NOTIFICATION_DAYS: 180,
  /** §8: the audit trail, 24 months. */
  AUDIT_DAYS: 730,
  /**
   * Processed outbox rows. Not in §8's table, and ADR-0005 names it as a
   * consequence: "the outbox needs its own retention policy or it grows forever".
   * Seven days is long enough to investigate a delivery that went wrong and short
   * enough that the table stays small.
   */
  OUTBOX_DAYS: 7,
} as const;

/**
 * The retention purge (§8, ADR-0009).
 *
 * The property the plan asks for is *"deletes exactly the expired rows and nothing
 * else"*, and the risk it is guarding against is real in both directions: a purge
 * that under-deletes silently breaks a promise made in a privacy notice, and one
 * that over-deletes destroys evidence somebody needs. Every query below is
 * therefore keyed on a stored expiry column or an explicit age, never on a join
 * that could widen.
 *
 * **Chat retention keys on `retention_expires_at`, which is set when the chat
 * closes** — not on message age. M8 chose that deliberately, and it is why
 * partitioning `chat_message` by month would not have helped: a conversation
 * spanning a month boundary would put its messages in two partitions with one
 * expiry between them, and partitions could never be dropped wholesale anyway.
 *
 * Deleted in dependency order, so nothing is ever orphaned mid-purge — see
 * `CHAT_DEPENDENTS`, which is the part a first reading gets wrong.
 *
 * ── What is deliberately absent: `direct_message` (v0.8.0) ──────────────────
 *
 * The chat's ninety-day clock existed because the chat was **anonymous**: two
 * strangers wrote under aliases, and what made that safe was the transcript not
 * outliving the conversation. «پیام مستقیم به میزبان» is the opposite
 * arrangement — nobody is anonymous, contact details are deliberately not
 * masked, and what people use it for is arranging to meet. A thread that
 * disappeared on a timer would take the address with it, and the person who
 * needed it would have no way to get it back.
 *
 * So no query below touches `direct_message`, and `retention.int.test.ts` seeds
 * one older than every window in §8 and asserts it survives — an absence is the
 * kind of thing that gets reintroduced by somebody adding "one more table" to
 * the purge.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async purge(): Promise<PurgeResult> {
    const now = this.clock.now();

    const result: PurgeResult = {
      chatMessages: 0,
      chats: 0,
      notifications: 0,
      auditRows: 0,
      outboxRows: 0,
      idempotencyKeys: 0,
    };

    /**
     * A conversation and everything attached to it, innermost first.
     *
     * `CHAT_DEPENDENTS` lists the four tables that reference `anonymous_chat`, all
     * with RESTRICT, and each has to go before the chat itself. The order within a
     * chat does not matter — none of them reference each other — but the order
     * relative to the chat row does, absolutely.
     *
     * The one that deserves an argument is `chat_unseal_grant`. It records a
     * break-glass read (T14), and deleting it looks like erasing accountability —
     * except that `audit_log` holds `chat.unseal_granted` and one
     * `chat.message_read` per message for twenty-four months, independently of this
     * table. The grant row is fifteen minutes of operational state; the record of
     * what was read outlives it by two years. Keeping the chat alive because
     * somebody once had cause to read it would make a break-glass grant *extend*
     * the retention of the conversation, which is exactly backwards.
     *
     * `chat_action` is append-only by trigger with the same escape hatch
     * `audit_log` has, and M8 wrote the reason into the migration: "the M15 purge
     * sets `payetam.retention_purge` for the duration of its transaction". This is
     * that caller. The setting is transaction-local, so it cannot leak onto a
     * pooled connection and quietly leave somebody else able to delete an
     * append-only row.
     */
    const expiring = await this.prisma.anonymousChat.findMany({
      where: { retentionExpiresAt: { lte: now } },
      select: { id: true },
    });
    const chatIds = expiring.map((chat) => chat.id);

    if (chatIds.length > 0) {
      result.chatMessages = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('payetam.retention_purge', 'on', true)`;

        const messages = await tx.chatMessage.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.chatAction.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.chatParticipant.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.chatUnsealGrant.deleteMany({ where: { chatId: { in: chatIds } } });
        await tx.anonymousChat.deleteMany({ where: { id: { in: chatIds } } });

        return messages.count;
      });
      result.chats = chatIds.length;
    }

    /**
     * A message whose own expiry has passed while its chat's has not.
     *
     * Normally impossible — both are stamped from `closed_at` — but a message
     * carrying its own earlier expiry (a moderation removal, say) must still go, and
     * the query above would have skipped it entirely.
     */
    result.chatMessages += (
      await this.prisma.chatMessage.deleteMany({ where: { retentionExpiresAt: { lte: now } } })
    ).count;

    result.notifications = (
      await this.prisma.notification.deleteMany({
        where: { createdAt: { lte: daysAgo(now, RETENTION.NOTIFICATION_DAYS) } },
      })
    ).count;

    /**
     * Processed outbox rows only.
     *
     * `processedAt: { not: null }` is the whole safety of this one: an unprocessed
     * row is a notification nobody has been told about yet, and deleting it by age
     * would silently discard the delivery the outbox exists to guarantee — during
     * an outage, which is exactly when a backlog gets old.
     */
    result.outboxRows = (
      await this.prisma.outboxEvent.deleteMany({
        where: {
          processedAt: { not: null, lte: daysAgo(now, RETENTION.OUTBOX_DAYS) },
        },
      })
    ).count;

    /**
     * Expired `Idempotency-Key` claims (§6).
     *
     * Deleted by their own `expires_at` rather than by an age constant, because the
     * interceptor is what decides how long a key speaks for and this sweep should
     * not hold a second opinion about it. Nothing here is a record of anything — a
     * stored response is a defence against a retry, and a retry that arrives after
     * the window is a new intention.
     */
    result.idempotencyKeys = (
      await this.prisma.requestIdempotency.deleteMany({ where: { expiresAt: { lte: now } } })
    ).count;

    result.auditRows = await this.purgeAuditLog(daysAgo(now, RETENTION.AUDIT_DAYS));

    this.logger.log(
      `Purge: ${String(result.chatMessages)} messages, ${String(result.chats)} chats, ` +
        `${String(result.notifications)} notifications, ${String(result.outboxRows)} outbox, ` +
        `${String(result.idempotencyKeys)} idempotency, ${String(result.auditRows)} audit`,
    );
    return result;
  }

  /**
   * The audit trail, through its **retention escape hatch**.
   *
   * `audit_log` is append-only by trigger, and M1 gave it an escape hatch that
   * `coin_ledger` deliberately does not have — the ledger's trigger refuses every
   * delete forever, because a missing ledger row breaks reconciliation
   * permanently, while the audit trail has a stated 24-month life. This is the one
   * caller allowed to use it.
   *
   * A raw statement because the escape hatch is a session setting the trigger
   * reads, and Prisma has no way to express "run this delete with that variable
   * set". Tagged, with the interval interpolated as a parameter — never
   * concatenated (T10).
   */
  private async purgeAuditLog(before: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('payetam.retention_purge', 'on', true)`;
      const deleted = await tx.$executeRaw`
        DELETE FROM "audit_log" WHERE "created_at" <= ${before}
      `;
      return deleted;
    });
  }
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 3_600_000);
}
