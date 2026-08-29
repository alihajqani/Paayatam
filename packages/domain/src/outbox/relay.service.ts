import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { planNotifications } from '../notifications/fanout';
import { NotificationService } from '../notifications/notification.service';

/** How far behind the outbox is, if it is behind at all. */
export interface OutboxBacklog {
  /** Rows committed and not yet fanned out. */
  pending: number;
  /**
   * Age of the oldest undelivered row, or null when there is none.
   *
   * The number that actually means something. A large `pending` during a burst is
   * the relay working; an *old* row is the relay stuck, because the drain takes
   * the oldest first — so nothing overtakes a row that is failing.
   */
  oldestAgeMs: number | null;
}

export interface RelayResult {
  /** Outbox rows drained. */
  processed: number;
  /** Notifications actually created — fewer on a redelivery, by design. */
  created: number;
  /** Notification ids to hand to the sender. */
  queued: string[];
}

/**
 * Drains the transactional outbox (ADR-0005).
 *
 * This is the half M7 could not build: the row has been committing with its state
 * change since then, and this is what finally reads it. The guarantee the pair
 * provides is the one a dual write cannot — **a crash at any point either leaves
 * the row undelivered (and it is delivered on restart) or delivers it twice (and
 * the dedupe key absorbs the second)**. What it never does is lose it.
 *
 * `processed_at` is set **after** the notifications are recorded, not before. That
 * ordering is the whole design: a crash between the two re-reads the row and
 * re-plans it, which is safe because the dedupe keys are derived from the row
 * rather than from the moment. Marking first would be faster and would lose
 * notifications on exactly the crash this exists to survive.
 */
@Injectable()
export class OutboxRelayService {
  private readonly logger = new Logger(OutboxRelayService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * One pass: read the backlog, fan it out, mark it done.
   *
   * Oldest first, because a notification about a request somebody made an hour ago
   * matters more than one from a second ago — and because a stuck row at the front
   * of the queue should be visible as a growing lag rather than hidden by newer
   * work overtaking it.
   */
  async drain(limit = 100): Promise<RelayResult> {
    const rows = await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, eventType: true, aggregateId: true, payload: true },
    });

    const result: RelayResult = { processed: 0, created: 0, queued: [] };

    for (const row of rows) {
      const planned = planNotifications({
        id: row.id,
        eventType: row.eventType,
        aggregateId: row.aggregateId,
        payload: asRecord(row.payload),
      });

      for (const plan of planned) {
        const userId = await this.resolveUserId(plan.userPublicId);
        // A public id that resolves to nobody is an anonymised or deleted account
        // (M15). Skipping is correct — and skipping *quietly* is not, because the
        // same symptom would appear if a payload started carrying the wrong field.
        if (userId === null) {
          this.logger.warn(`outbox ${row.id}: no user for ${plan.templateKey}`);
          continue;
        }

        const queued = await this.notifications.queue({
          userId,
          templateKey: plan.templateKey,
          dedupeKey: plan.dedupeKey,
          payload: plan.payload as Prisma.InputJsonValue,
        });

        if (queued.created) result.created += 1;
        // Handed to the sender either way. A row that already existed may still be
        // PENDING because the previous pass died before enqueueing it, and the
        // sender is idempotent on its own account.
        result.queued.push(queued.id);
      }

      await this.prisma.outboxEvent.update({
        where: { id: row.id },
        data: { processedAt: this.clock.now(), attempts: { increment: 1 } },
      });
      result.processed += 1;
    }

    return result;
  }

  /**
   * How far behind the outbox is (M22 phase 7).
   *
   * M16 made this number scrapeable and the comment there says why it matters:
   * queue depth going up means the worker is behind, but **outbox backlog going up
   * means the guarantee itself is not being kept** — a promise breaking quietly,
   * with no user-visible symptom until somebody notices they were never told.
   *
   * What M16 could not do is notice on its own; `/metrics` needs somebody
   * scraping it and somebody reading the scrape. This is the same question asked
   * by the worker every five minutes so it can raise its hand.
   */
  async backlog(): Promise<OutboxBacklog> {
    const [pending, oldest] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { processedAt: null } }),
      this.prisma.outboxEvent.findFirst({
        where: { processedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    return {
      pending,
      oldestAgeMs:
        oldest === null
          ? null
          : Math.max(0, this.clock.now().getTime() - oldest.createdAt.getTime()),
    };
  }

  private async resolveUserId(publicId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { publicId },
      select: { id: true },
    });
    return user?.id ?? null;
  }
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value;
}
