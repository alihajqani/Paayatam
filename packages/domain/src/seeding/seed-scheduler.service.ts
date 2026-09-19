import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AuditService } from '../audit/audit.service';
import { lockEventByPublicIdForUpdate } from '../events/event-lock';
import { SeedEventService } from './seed-event.service';
import { upcomingEventsWhere } from './seed-floor';

/**
 * Whether a seed event has "waited its turn" for another seat, given a
 * target fill window spread evenly across its remaining seats. Pure and
 * exported so the pacing decision is unit-testable without a database.
 */
export function isDueForSeat(input: {
  event: { createdAt: Date; capacity: number; acceptedCount: number };
  config: { fillMinutes: number };
  now: Date;
}): boolean {
  const { event, config, now } = input;
  const elapsedMs = now.getTime() - event.createdAt.getTime();
  const windowMs = config.fillMinutes * 60_000;
  const targetFraction = Math.min(1, elapsedMs / windowMs);
  const targetSeats = Math.ceil(targetFraction * event.capacity);
  return targetSeats > event.acceptedCount;
}

/**
 * At most this many events per city per pass, however far below the floor it is.
 * A city at zero with a floor of twenty is reached over several passes, not in
 * one burst of twenty channel posts and twenty coin charges.
 */
export const MAX_CREATED_PER_CITY_PER_PASS = 3;

/** A seed identity older than this with no seat is debris, not a seat in progress. */
const ORPHAN_GRACE_MS = 60 * 60_000;

const PURGE_BATCH = 100;

/**
 * Event states that are over and will never be settled: nothing further will
 * happen to the people seated in them. `COMPLETED` and `HIDDEN` are over only
 * once their end has passed (see `purge`).
 */
const VOID_STATUSES = ['CANCELLED_BY_HOST', 'EXPIRED', 'REJECTED', 'DELETED'] as const;

/**
 * The worker-side sweeps for marketing seed events (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md and
 * 2026-09-19-seed-event-floor-and-purge-design.md).
 *
 * Three passes, each on its own cron cadence (wired in `apps/worker`): `topUp`
 * creates seed events until a city has as many upcoming events as its floor,
 * `fill` advances the ones already in flight, and `purge` removes the synthetic
 * people once their event is over. None touches `lifecycle.service.ts` — a seed
 * event rides the real sweeps between its creation and its purge.
 */
@Injectable()
export class SeedSchedulerService {
  private readonly logger = new Logger(SeedSchedulerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly seedEvents: SeedEventService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bring every enabled, launched city up to its floor, and no further.
   *
   * The floor is the number of **upcoming events in the city, whoever hosts
   * them** (`upcomingEventsWhere`). A city with seven and a floor of ten gets
   * three; a city already at ten gets none. The count is taken again before each
   * creation, so two overlapping passes overshoot by at most one rather than by a
   * whole deficit.
   *
   * One city's host running out of coins (`INSUFFICIENT_COINS`) or being
   * unable to author must not stop the sweep for every other city, so each
   * attempt is isolated; a city stuck this way shows in the admin screen as an
   * upcoming count that stays below its floor.
   */
  async topUp(): Promise<{ created: number }> {
    const configs = await this.prisma.citySeedConfig.findMany({
      where: { enabled: true, city: { isLaunched: true } },
      select: { cityId: true, floorCount: true },
    });

    let created = 0;
    for (const config of configs) {
      for (let attempt = 0; attempt < MAX_CREATED_PER_CITY_PER_PASS; attempt += 1) {
        const upcoming = await this.prisma.event.count({
          where: upcomingEventsWhere(this.clock.now(), config.cityId),
        });
        if (upcoming >= config.floorCount) break;

        try {
          await this.seedEvents.createSeedEvent(config.cityId);
          created += 1;
        } catch (error) {
          this.logger.warn(`Seed top-up failed for city ${config.cityId}: ${String(error)}`);
          break; // further attempts for this same city will fail the same way
        }
      }
    }
    return { created };
  }

  /**
   * Advance every seed event that is due its next seat.
   *
   * A city whose config has been switched off (or removed) is left alone: the
   * kill switch is documented as stopping creation **and filling** at once, and
   * this used to check only that a config row existed.
   */
  async fill(): Promise<{ steps: number }> {
    const now = this.clock.now();
    const candidates = await this.prisma.event.findMany({
      where: { isSeeded: true, status: 'PUBLISHED' },
      select: {
        publicId: true,
        cityId: true,
        createdAt: true,
        capacity: true,
        acceptedCount: true,
      },
    });

    let steps = 0;
    for (const event of candidates) {
      if (event.acceptedCount >= event.capacity) continue;

      const config = await this.prisma.citySeedConfig.findUnique({
        where: { cityId: event.cityId },
        select: { fillMinutes: true, enabled: true },
      });
      if (!config || !config.enabled) continue;

      if (isDueForSeat({ event, config, now })) {
        // One event failing (it filled under us, or was cancelled) must not
        // abandon the rest of the pass; the next tick picks it up again.
        try {
          await this.seedEvents.fillStep(event.publicId);
          steps += 1;
        } catch (error) {
          this.logger.warn(`Seed fill failed for event ${event.publicId}: ${String(error)}`);
        }
      }
    }
    return { steps };
  }

  /**
   * Remove the synthetic people of every seed event that is over, so they never
   * add up to a user count that is not real.
   *
   * An event is over when it was cancelled, expired or deleted, or when it has
   * ended (`COMPLETED`, or `HIDDEN` with its end passed). The purge runs hourly,
   * long before `settleAttendance` may act on it — that waits
   * `participation.settlement_delay_hours` after the end — and that ordering is
   * what makes deletion possible at all: settling a guest credits trust, and
   * `trust_score_ledger` is append-only by trigger, so a synthetic guest who had
   * been settled could never be removed. The settlement sweep therefore skips
   * seed guests as a second line of defence (`EventLifecycleService.settleOne`),
   * for a worker that was down long enough for the two to run out of order.
   *
   * A real guest on the same event is untouched, and is settled and reviewed as
   * usual. The event row is kept: it happened as far as the platform is
   * concerned, and the host's ledger and history refer to it; what goes is the
   * person occupying each synthetic seat.
   */
  async purge(): Promise<{ events: number; users: number; orphans: number }> {
    const now = this.clock.now();

    const candidates = await this.prisma.event.findMany({
      where: {
        isSeeded: true,
        participants: { some: { user: { isSeed: true } } },
        OR: [
          { status: { in: [...VOID_STATUSES] } },
          { status: { in: ['COMPLETED', 'HIDDEN'] }, endsAt: { lte: now } },
        ],
      },
      select: { publicId: true },
      orderBy: { endsAt: 'asc' },
      take: PURGE_BATCH,
    });

    let events = 0;
    let users = 0;
    for (const { publicId } of candidates) {
      try {
        const removed = await this.purgeEvent(publicId);
        if (removed > 0) {
          events += 1;
          users += removed;
        }
      } catch (error) {
        // Rolled back whole, so the event keeps all of its people and the next
        // pass tries again. Something unexpected still references one of them —
        // most likely a ledger row, which is append-only and so can never be
        // deleted — and is worth a look, not worth stopping the rest. The user
        // counters exclude `is_seed`, so a guest that cannot be removed does not
        // inflate any number an operator reads.
        this.logger.warn(`Seed purge failed for event ${publicId}: ${String(error)}`);
      }
    }

    const orphans = await this.purgeOrphans(now);
    return { events, users, orphans };
  }

  /**
   * One event's synthetic guests, in one transaction under the event lock — the
   * lock `settleAttendance` and every seat change take, so a purge and a
   * settlement of the same event cannot interleave.
   *
   * The order is the foreign keys': a review pair points at reviews and at the
   * participation, a review at the participation, and the participation at the
   * user. (A seed guest has no ledger row to remove: see `purge`.) Every delete on
   * the user table is filtered on `is_seed`, so however this is reached it cannot
   * remove a real account; a count that comes back short of the identities found
   * aborts the transaction.
   */
  private async purgeEvent(publicId: string): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await lockEventByPublicIdForUpdate(tx, publicId);
        if (!locked) return 0;

        const seated = await tx.eventParticipant.findMany({
          where: { eventId: locked.id, user: { isSeed: true } },
          select: { id: true, userId: true },
        });
        if (seated.length === 0) return 0;

        const participantIds = seated.map((row) => row.id);
        const userIds = [...new Set(seated.map((row) => row.userId))];

        await tx.reviewPair.deleteMany({ where: { participantId: { in: participantIds } } });
        await tx.review.deleteMany({ where: { participantId: { in: participantIds } } });
        await tx.eventParticipant.deleteMany({ where: { id: { in: participantIds } } });

        const removed = await tx.user.deleteMany({
          where: { id: { in: userIds }, isSeed: true },
        });
        if (removed.count !== userIds.length) {
          throw new Error(
            `Expected to remove ${String(userIds.length)} seed identities, removed ${String(removed.count)}`,
          );
        }

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'seed.purged',
            targetType: 'event',
            targetId: locked.id,
            after: { users: removed.count },
          },
          tx,
        );

        return removed.count;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Identities that never got a seat: `fillStep` made one and the seat was
   * refused, and its own cleanup failed too. Old enough that none can be a seat
   * in progress.
   */
  private async purgeOrphans(now: Date): Promise<number> {
    const orphans = await this.prisma.user.findMany({
      where: {
        isSeed: true,
        createdAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) },
        participations: { none: {} },
      },
      select: { id: true },
      take: PURGE_BATCH,
    });
    if (orphans.length === 0) return 0;

    const removed = await this.prisma.user.deleteMany({
      where: {
        id: { in: orphans.map((orphan) => orphan.id) },
        isSeed: true,
        participations: { none: {} },
      },
    });
    return removed.count;
  }
}
