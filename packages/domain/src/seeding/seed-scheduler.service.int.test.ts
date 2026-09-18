import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { ChannelService } from '../channel/channel.service';
import { SettingsService } from '../catalog/settings.service';
import { CatalogService } from '../catalog/catalog.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { EventService } from '../events/event.service';
import { ParticipationService } from '../participation/participation.service';
import { SeedEventService } from './seed-event.service';
import { SeedIdentityService } from './seed-identity.service';
import { SeedSchedulerService } from './seed-scheduler.service';

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran', TELEGRAM_CHANNEL_ID: '@payetam_test' } as unknown as Env;
const catalogEnv = { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as unknown as Env;

const settings = new SettingsService(service);
const catalog = new CatalogService(service, settings, catalogEnv);
const blacklist = new BlacklistService(service);
const moderation = new ModerationService(service, blacklist);
const channel = new ChannelService(service, clock, settings);
const audit = new AuditService(service, clock);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
const outbox = new OutboxService(service, clock);
const membership = new ChannelMembershipService(
  service,
  new ChannelConfigService(service, clock, audit),
);

const events = new EventService(
  service,
  clock,
  env,
  catalog,
  settings,
  moderation,
  channel,
  membership,
  coins,
  penalties,
  outbox,
  audit,
);
const participation = new ParticipationService(
  service,
  clock,
  env,
  settings,
  audit,
  outbox,
  penalties,
  membership,
  coins,
);
const identities = new SeedIdentityService(service);
const seedEvents = new SeedEventService(service, clock, events, participation, identities);
const scheduler = new SeedSchedulerService(service, clock, seedEvents);

let fixture: CatalogFixture;

const HOST_ENDOWMENT = 1_000;

async function seedRealHost(cityId: string): Promise<{ id: string; publicId: string }> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: HOST_ENDOWMENT });
  await prisma.userProfile.create({
    data: { userId, displayName: 'میزبان بذر', cityId, birthYear: 1995 },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return { id: userId, publicId: user.publicId };
}

async function seedConfig(
  cityId: string,
  hostUserId: string,
  overrides: Partial<{ enabled: boolean; eventCapacity: number; floorCount: number }> = {},
): Promise<void> {
  await prisma.citySeedConfig.create({
    data: {
      cityId,
      enabled: overrides.enabled ?? true,
      floorCount: overrides.floorCount ?? 1,
      eventCapacity: overrides.eventCapacity ?? 4,
      fillMinutes: 5,
      hostUserId,
      updatedByAdminId: hostUserId,
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SeedSchedulerService', () => {
  describe('topUp', () => {
    it('creates events up to the floor for an enabled, launched city', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 3 });

      const result = await scheduler.topUp();

      expect(result.created).toBe(3);
      const count = await prisma.event.count({
        where: { cityId: fixture.tehranId, isSeeded: true, status: 'PUBLISHED' },
      });
      expect(count).toBe(3);
    });

    it('does nothing for a disabled config', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { enabled: false, floorCount: 2 });

      const result = await scheduler.topUp();
      expect(result.created).toBe(0);
    });

    it('does not exceed the floor once it is already met', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 1 });

      await scheduler.topUp();
      const second = await scheduler.topUp();

      expect(second.created).toBe(0);
    });
  });

  describe('fill', () => {
    it('advances an event that is due another seat', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 1, eventCapacity: 4 });
      await scheduler.topUp();
      const event = await prisma.event.findFirstOrThrow({
        where: { cityId: fixture.tehranId, isSeeded: true },
      });
      // Backdate creation so "due for a seat" is unambiguously true for a
      // 5-minute fill window.
      await prisma.event.update({
        where: { id: event.id },
        data: { createdAt: new Date(NOW.getTime() - 4 * 60 * 1000) },
      });
      clock.set(NOW);

      const result = await scheduler.fill();

      expect(result.steps).toBeGreaterThanOrEqual(1);
      const updated = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(updated.acceptedCount).toBeGreaterThanOrEqual(1);
    });
  });
});
