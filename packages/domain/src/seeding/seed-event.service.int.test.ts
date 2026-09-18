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
  overrides: Partial<{ eventCapacity: number; floorCount: number; fillMinutes: number }> = {},
): Promise<void> {
  await prisma.citySeedConfig.create({
    data: {
      cityId,
      enabled: true,
      floorCount: overrides.floorCount ?? 1,
      eventCapacity: overrides.eventCapacity ?? 4,
      fillMinutes: overrides.fillMinutes ?? 5,
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

describe('SeedEventService', () => {
  it('creates a PUBLISHED, isSeeded event hosted by the configured account', async () => {
    const host = await seedRealHost(fixture.tehranId);
    await seedConfig(fixture.tehranId, host.id, { eventCapacity: 4 });

    const { eventPublicId } = await seedEvents.createSeedEvent(fixture.tehranId);

    const event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.isSeeded).toBe(true);
    expect(event.hostUserId).toBe(host.id);
    expect(event.status).toBe('PUBLISHED');
    expect(event.acceptedCount).toBe(0);
    expect(event.capacity).toBe(4);
  });

  it('fillStep adds exactly one seat per call and reports done at capacity', async () => {
    const host = await seedRealHost(fixture.tehranId);
    await seedConfig(fixture.tehranId, host.id, { eventCapacity: 2 });
    const { eventPublicId } = await seedEvents.createSeedEvent(fixture.tehranId);

    const first = await seedEvents.fillStep(eventPublicId);
    expect(first.done).toBe(false);
    let event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.acceptedCount).toBe(1);

    const second = await seedEvents.fillStep(eventPublicId);
    expect(second.done).toBe(true);
    event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.acceptedCount).toBe(2);

    const third = await seedEvents.fillStep(eventPublicId);
    expect(third.done).toBe(true);
    event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.acceptedCount).toBe(2); // unchanged — no-op past capacity
  });
});
