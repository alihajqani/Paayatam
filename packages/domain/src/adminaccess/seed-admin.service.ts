import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import type { CitySeedConfigView, UpdateCitySeedConfigRequest } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
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

    const fillingCounts = await this.prisma.event.groupBy({
      by: ['cityId'],
      where: { isSeeded: true, status: 'PUBLISHED' },
      _count: { _all: true },
    });
    const fillingByCity = new Map(fillingCounts.map((row) => [row.cityId, row._count._all]));

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
      fillingEventCount: fillingByCity.get(city.id) ?? 0,
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
      fillingEventCount: 0,
    };
  }
}
