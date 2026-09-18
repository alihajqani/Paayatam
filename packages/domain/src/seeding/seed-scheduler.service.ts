import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { SeedEventService } from './seed-event.service';

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

interface FillingCountRow {
  count: bigint;
}

/**
 * The worker-side sweep for marketing seed events (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
 *
 * Two passes, on their own cron cadence (wired in `apps/worker`): `topUp`
 * creates new seed events up to each city's floor, `fill` advances the ones
 * already in flight. Neither touches `lifecycle.service.ts` — a seed event
 * rides the real sweep once it exists.
 */
@Injectable()
export class SeedSchedulerService {
  private readonly logger = new Logger(SeedSchedulerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly seedEvents: SeedEventService,
  ) {}

  /**
   * Create seed events for every enabled, launched city, up to its floor.
   *
   * `floorCount` is contract-capped at 3
   * (`packages/shared/src/contracts/seed-events.ts`) because that is
   * `EventService`'s own concurrent-active-per-host quota — see the design
   * spec's "confirmed constraint" section. One city's host running out of
   * coins or quota (`INSUFFICIENT_COINS` / `EVENT_QUOTA_EXCEEDED`) must not
   * stop the sweep for every other city, so each attempt is isolated.
   */
  async topUp(): Promise<{ created: number }> {
    const configs = await this.prisma.citySeedConfig.findMany({
      where: { enabled: true, city: { isLaunched: true } },
      select: { cityId: true, floorCount: true },
    });

    let created = 0;
    for (const config of configs) {
      const filling = await this.countFillingEvents(config.cityId);
      const toCreate = Math.max(0, config.floorCount - filling);
      for (let i = 0; i < toCreate; i += 1) {
        try {
          await this.seedEvents.createSeedEvent(config.cityId);
          created += 1;
        } catch (error) {
          // Expected under quota/coin exhaustion — log and move on to the
          // next city rather than losing the rest of the pass. A city stuck
          // this way is visible in the admin screen as `fillingEventCount`
          // staying below `floorCount`.
          this.logger.warn(`Seed top-up failed for city ${config.cityId}: ${String(error)}`);
          break; // further attempts for this same city will fail the same way
        }
      }
    }
    return { created };
  }

  /** Advance every seed event that is due its next seat. */
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
        select: { fillMinutes: true },
      });
      if (!config) continue;

      if (isDueForSeat({ event, config, now })) {
        await this.seedEvents.fillStep(event.publicId);
        steps += 1;
      }
    }
    return { steps };
  }

  /**
   * Seed events not yet at capacity — a column-to-column comparison
   * (`accepted_count < capacity`) Prisma's query builder cannot express,
   * following the same `$queryRaw` + `Prisma.sql` convention as
   * `event-lock.ts`.
   */
  private async countFillingEvents(cityId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<FillingCountRow[]>(
      Prisma.sql`
        SELECT COUNT(*) AS count FROM "event"
        WHERE "city_id" = ${cityId}
          AND "is_seeded" = true
          AND "status" = 'PUBLISHED'
          AND "accepted_count" < "capacity"
      `,
    );
    return Number(rows[0]?.count ?? 0n);
  }
}
