import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import type { CitySeedConfigView, UpdateCitySeedConfigRequest } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { upcomingEventsWhere } from '../seeding/seed-floor';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/**
 * Admin configuration for the marketing seed-event scheduler (see
 * docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
 *
 * Read/write over `city_seed_config` alone — creating and filling seed
 * events themselves is `SeedSchedulerService`'s job, running in the worker
 * on its own cron cadence. Every mutating method begins with
 * `assertPermission` and ends with an audit row, in that order (ADR-0010
 * rule 2), matching every other `*AdminService` in this module.
 */
@Injectable()
export class SeedAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  async listCities(session: AdminSession): Promise<CitySeedConfigView[]> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_SEED_MANAGE);

    const cities = await this.prisma.city.findMany({
      where: { isLaunched: true },
      select: {
        id: true,
        nameFa: true,
        isLaunched: true,
        seedConfig: {
          select: {
            enabled: true,
            floorCount: true,
            eventCapacity: true,
            fillMinutes: true,
            host: { select: { publicId: true, profile: { select: { displayName: true } } } },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    const counts = await this.countsByCity();

    return cities.map((city) => ({
      cityId: city.id,
      cityNameFa: city.nameFa,
      isLaunched: city.isLaunched,
      enabled: city.seedConfig?.enabled ?? false,
      floorCount: city.seedConfig?.floorCount ?? 0,
      eventCapacity: city.seedConfig?.eventCapacity ?? 6,
      fillMinutes: city.seedConfig?.fillMinutes ?? 5,
      hostUserPublicId: city.seedConfig?.host.publicId ?? null,
      hostDisplayName: city.seedConfig?.host.profile?.displayName ?? null,
      fillingEventCount: counts.get(city.id)?.filling ?? 0,
      upcomingEventCount: counts.get(city.id)?.upcoming ?? 0,
    }));
  }

  async updateConfig(
    session: AdminSession,
    cityId: string,
    input: UpdateCitySeedConfigRequest,
  ): Promise<CitySeedConfigView> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_SEED_MANAGE);

    const city = await this.prisma.city.findUnique({ where: { id: cityId } });
    if (!city || !city.isLaunched) throw new AppError(ErrorCode.NOT_FOUND);

    const existing = await this.prisma.citySeedConfig.findUnique({ where: { cityId } });

    let hostUserId = existing?.hostUserId;
    if (input.hostUserPublicId !== undefined) {
      const host = await this.prisma.user.findUnique({
        where: { publicId: input.hostUserPublicId },
        select: { id: true, isSeed: true, status: true },
      });
      if (!host || host.isSeed || host.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.VALIDATION_FAILED);
      }
      hostUserId = host.id;
    }
    if (hostUserId === undefined) {
      // First write for this city must name a host — there is no default.
      throw new AppError(ErrorCode.VALIDATION_FAILED);
    }

    const saved = await this.prisma.citySeedConfig.upsert({
      where: { cityId },
      create: {
        cityId,
        enabled: input.enabled ?? false,
        floorCount: input.floorCount ?? 1,
        eventCapacity: input.eventCapacity ?? 6,
        fillMinutes: input.fillMinutes ?? 5,
        hostUserId,
        updatedByAdminId: session.adminUserId,
      },
      update: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.floorCount !== undefined ? { floorCount: input.floorCount } : {}),
        ...(input.eventCapacity !== undefined ? { eventCapacity: input.eventCapacity } : {}),
        ...(input.fillMinutes !== undefined ? { fillMinutes: input.fillMinutes } : {}),
        hostUserId,
        updatedByAdminId: session.adminUserId,
      },
      select: {
        enabled: true,
        floorCount: true,
        eventCapacity: true,
        fillMinutes: true,
        host: { select: { publicId: true, profile: { select: { displayName: true } } } },
      },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: existing ? 'seed_config.updated' : 'seed_config.created',
      targetType: 'city_seed_config',
      targetId: cityId,
      after: {
        enabled: saved.enabled,
        floorCount: saved.floorCount,
        eventCapacity: saved.eventCapacity,
        fillMinutes: saved.fillMinutes,
      },
    });

    const counts = await this.countsByCity();

    return {
      cityId,
      cityNameFa: city.nameFa,
      isLaunched: city.isLaunched,
      enabled: saved.enabled,
      floorCount: saved.floorCount,
      eventCapacity: saved.eventCapacity,
      fillMinutes: saved.fillMinutes,
      hostUserPublicId: saved.host.publicId,
      hostDisplayName: saved.host.profile?.displayName ?? null,
      fillingEventCount: counts.get(cityId)?.filling ?? 0,
      upcomingEventCount: counts.get(cityId)?.upcoming ?? 0,
    };
  }

  /**
   * Two different questions, so two counts. `filling` is how many seed events
   * are still short of capacity; `upcoming` is what the floor is compared with
   * (`upcomingEventsWhere`), and includes real events and full seed events. A
   * city with neither has no entry.
   *
   * The filling count is done in memory because Prisma cannot compare two
   * columns (`accepted_count < capacity`), and there are only ever a handful of
   * seed events in flight.
   */
  private async countsByCity(): Promise<Map<string, { filling: number; upcoming: number }>> {
    const now = this.clock.now();
    const [upcomingByCity, seededPublished] = await Promise.all([
      this.prisma.event.groupBy({
        by: ['cityId'],
        where: upcomingEventsWhere(now),
        _count: { _all: true },
      }),
      this.prisma.event.findMany({
        where: { isSeeded: true, status: 'PUBLISHED' },
        select: { cityId: true, capacity: true, acceptedCount: true },
      }),
    ]);

    const counts = new Map<string, { filling: number; upcoming: number }>();
    const entry = (cityId: string): { filling: number; upcoming: number } => {
      let existing = counts.get(cityId);
      if (existing === undefined) {
        existing = { filling: 0, upcoming: 0 };
        counts.set(cityId, existing);
      }
      return existing;
    };
    for (const row of upcomingByCity) entry(row.cityId).upcoming = row._count._all;
    for (const event of seededPublished) {
      if (event.acceptedCount < event.capacity) entry(event.cityId).filling += 1;
    }
    return counts;
  }
}
