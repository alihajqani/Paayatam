import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  grantCoins,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { ChannelService } from '../channel/channel.service';
import { SETTING_DEFAULTS, SettingsService } from '../catalog/settings.service';
import { CatalogService } from '../catalog/catalog.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { ReferralService } from '../economy/referral.service';
import { TrustService } from '../economy/trust.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { EventService } from '../events/event.service';
import { EventLifecycleService } from '../events/lifecycle.service';
import { ParticipationService } from '../participation/participation.service';
import { ReviewService } from '../reviews/review.service';
import { SeedEventService } from './seed-event.service';
import { SeedIdentityService } from './seed-identity.service';
import { MAX_CREATED_PER_CITY_PER_PASS, SeedSchedulerService } from './seed-scheduler.service';
import { SEED_HORIZON_DAYS, SEED_MIN_LEAD_MS } from './seed-variety';

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const HOUR = 3_600_000;
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
const referrals = new ReferralService(
  service,
  clock,
  settings,
  coins,
  audit,
  outbox,
  new MetricsRegistry(),
);
const reviews = new ReviewService(
  service,
  clock,
  settings,
  coins,
  trust,
  moderation,
  audit,
  outbox,
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
// The unmodified real sweeps: a seed event rides them between creation and purge,
// and the purge test below runs the real ones so it proves the whole path.
const lifecycle = new EventLifecycleService(
  service,
  clock,
  env,
  settings,
  trust,
  referrals,
  penalties,
  reviews,
  audit,
  outbox,
);
const identities = new SeedIdentityService(service);
const seedEvents = new SeedEventService(service, clock, env, events, participation, identities);
const scheduler = new SeedSchedulerService(service, clock, seedEvents, audit);

let fixture: CatalogFixture;

const HOST_ENDOWMENT = 5_000;
const SETTLEMENT_DELAY_MS = SETTING_DEFAULTS['participation.settlement_delay_hours'] * HOUR;

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
  overrides: Partial<{
    enabled: boolean;
    eventCapacity: number;
    floorCount: number;
    fillMinutes: number;
  }> = {},
): Promise<void> {
  await prisma.citySeedConfig.create({
    data: {
      cityId,
      enabled: overrides.enabled ?? true,
      floorCount: overrides.floorCount ?? 1,
      eventCapacity: overrides.eventCapacity ?? 4,
      fillMinutes: overrides.fillMinutes ?? 5,
      hostUserId,
      updatedByAdminId: hostUserId,
    },
  });
}

/** A published event somebody else hosts — what the floor has to count. */
async function insertRealEvent(
  hostId: string,
  overrides: { startsAt?: Date; status?: 'PUBLISHED' | 'CANCELLED_BY_HOST'; n?: number } = {},
): Promise<string> {
  const startsAt = overrides.startsAt ?? new Date(NOW.getTime() + 48 * HOUR);
  const title = `رویداد واقعی ${String(overrides.n ?? 0)}`;
  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title,
      description: 'یک رویداد واقعی که یک میزبان واقعی ساخته است.',
      titleNormalized: title,
      descriptionNormalized: 'یک رویداد واقعی که یک میزبان واقعی ساخته است.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * HOUR),
      capacity: 6,
      costType: 'FREE',
      status: overrides.status ?? 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return event.publicId;
}

async function addCategories(slugs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const slug of slugs) {
    const category = await prisma.category.create({
      data: { slug, nameFa: `دسته ${slug}`, isActive: true },
    });
    ids.push(category.id);
  }
  return ids;
}

async function fillCompletely(eventPublicId: string): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
    if ((await seedEvents.fillStep(eventPublicId)).done) return;
  }
  throw new Error('event never filled');
}

async function seededEvents() {
  return prisma.event.findMany({
    where: { cityId: fixture.tehranId, isSeeded: true },
    orderBy: { startsAt: 'asc' },
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

    it('counts the city’s real events: seven exist, a floor of ten makes three', async () => {
      const host = await seedRealHost(fixture.tehranId);
      const other = await createUser(prisma, 'PROFILE_COMPLETE');
      for (let n = 0; n < 7; n += 1) {
        await insertRealEvent(other, {
          n,
          startsAt: new Date(NOW.getTime() + (24 + n * 5) * HOUR),
        });
      }
      await seedConfig(fixture.tehranId, host.id, { floorCount: 10 });

      const result = await scheduler.topUp();

      expect(result.created).toBe(3);
      expect(await prisma.event.count({ where: { cityId: fixture.tehranId } })).toBe(10);
      expect(await seededEvents()).toHaveLength(3);
    });

    it('makes nothing when the city’s real events already meet the floor', async () => {
      const host = await seedRealHost(fixture.tehranId);
      const other = await createUser(prisma, 'PROFILE_COMPLETE');
      for (let n = 0; n < 4; n += 1) await insertRealEvent(other, { n });
      await seedConfig(fixture.tehranId, host.id, { floorCount: 4 });

      const result = await scheduler.topUp();

      expect(result.created).toBe(0);
      expect(await seededEvents()).toHaveLength(0);
    });

    /**
     * The reported bug. The floor counted seed events that were still *filling*, and
     * a seed event fills in minutes — so each one left the count almost at once and
     * the next pass made a fresh batch, over and over, until the host ran out of
     * quota or coins.
     */
    it('does not make more once its events have filled up', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 3, eventCapacity: 3 });

      expect((await scheduler.topUp()).created).toBe(3);
      for (const event of await seededEvents()) await fillCompletely(event.publicId);
      for (const event of await seededEvents()) {
        expect(event.capacity).toBe(3);
      }

      // Five minutes, then ten, then an hour: the sweep must stay quiet.
      for (const minutes of [5, 10, 60]) {
        clock.set(new Date(NOW.getTime() + minutes * 60_000));
        expect((await scheduler.topUp()).created).toBe(0);
      }
      expect(await seededEvents()).toHaveLength(3);
    });

    it('does not count an event that has started, or one that was cancelled', async () => {
      const host = await seedRealHost(fixture.tehranId);
      const other = await createUser(prisma, 'PROFILE_COMPLETE');
      // Still PUBLISHED but its start has passed (the lifecycle sweep is a minute
      // behind): it is not "upcoming".
      await insertRealEvent(other, { n: 1, startsAt: new Date(NOW.getTime() - HOUR) });
      await insertRealEvent(other, { n: 2, status: 'CANCELLED_BY_HOST' });
      await seedConfig(fixture.tehranId, host.id, { floorCount: 2 });

      expect((await scheduler.topUp()).created).toBe(2);
    });

    it('makes at most three per city per pass, and reaches a high floor over several', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 8 });

      expect((await scheduler.topUp()).created).toBe(MAX_CREATED_PER_CITY_PER_PASS);
      expect((await scheduler.topUp()).created).toBe(MAX_CREATED_PER_CITY_PER_PASS);
      expect((await scheduler.topUp()).created).toBe(2);
      expect((await scheduler.topUp()).created).toBe(0);
      expect(await seededEvents()).toHaveLength(8);
    });

    it('is not held to the host’s three-at-a-time quota, and does not spend it', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 6 });

      await scheduler.topUp();
      await scheduler.topUp();

      expect(await seededEvents()).toHaveLength(6);
      // The team account can still host real evenings: seeds are not in its quota.
      const quota = await events.quotaFor(host.id);
      expect(quota.activeCount).toBe(0);
      expect(quota.createdToday).toBe(0);
      expect(quota.blockedBy).toBeNull();
    });

    it('still charges the host for each event, like any other', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 2 });

      await scheduler.topUp();

      const account = await prisma.coinAccount.findUniqueOrThrow({
        where: { userId: host.id },
        select: { balance: true },
      });
      expect(account.balance).toBeLessThan(HOST_ENDOWMENT);
    });

    it('gives each event of a pass its own category, title, day and hour', async () => {
      await addCategories(['sports', 'walking', 'music']);
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 3 });

      await scheduler.topUp();
      const created = await seededEvents();

      expect(created).toHaveLength(3);
      expect(new Set(created.map((event) => event.categoryId)).size).toBe(3);
      expect(new Set(created.map((event) => event.title)).size).toBe(3);
      expect(new Set(created.map((event) => event.startsAt.getTime())).size).toBe(3);
      for (let i = 1; i < created.length; i += 1) {
        const gap = created[i]!.startsAt.getTime() - created[i - 1]!.startsAt.getTime();
        expect(gap).toBeGreaterThanOrEqual(2 * HOUR);
      }
    });

    it('schedules every event between four hours and two weeks ahead, never "now + 3h"', async () => {
      await addCategories(['sports', 'walking', 'music', 'outdoor']);
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 5 });

      await scheduler.topUp();
      await scheduler.topUp();

      const created = await seededEvents();
      expect(created).toHaveLength(5);
      for (const event of created) {
        expect(event.startsAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + SEED_MIN_LEAD_MS);
        expect(event.startsAt.getTime()).toBeLessThanOrEqual(
          NOW.getTime() + SEED_HORIZON_DAYS * 24 * HOUR,
        );
        expect(event.endsAt.getTime()).toBeGreaterThan(event.startsAt.getTime());
      }
      // Five events at one instant is what the bug produced.
      expect(new Set(created.map((event) => event.startsAt.getTime())).size).toBe(5);
    });

    it('never picks a category that is not offered in the city', async () => {
      const [restricted] = await addCategories(['sports']);
      await prisma.cityCategory.create({
        data: { cityId: fixture.karajId, categoryId: restricted! },
      });
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 3 });

      await scheduler.topUp();

      const created = await seededEvents();
      expect(created).toHaveLength(3);
      expect(created.some((event) => event.categoryId === restricted)).toBe(false);
    });

    it('never picks the catch-all category', async () => {
      const other = await prisma.category.create({
        data: { slug: 'other', nameFa: 'سایر', isActive: true },
      });
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 3 });

      await scheduler.topUp();

      expect((await seededEvents()).some((event) => event.categoryId === other.id)).toBe(false);
    });

    it('marks the event as seeded in the same write that creates it', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 1 });

      await scheduler.topUp();

      const [event] = await seededEvents();
      expect(event?.isSeeded).toBe(true);
      const created = await prisma.auditLog.findFirst({
        where: { action: 'event.created', targetId: event!.id },
      });
      expect(created).not.toBeNull();
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

    it('stops filling once the city is switched off', async () => {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 1, eventCapacity: 4 });
      await scheduler.topUp();
      const event = await prisma.event.findFirstOrThrow({
        where: { cityId: fixture.tehranId, isSeeded: true },
      });
      await prisma.event.update({
        where: { id: event.id },
        data: { createdAt: new Date(NOW.getTime() - 10 * 60 * 1000) },
      });
      await prisma.citySeedConfig.update({
        where: { cityId: fixture.tehranId },
        data: { enabled: false },
      });

      const result = await scheduler.fill();

      expect(result.steps).toBe(0);
      const unchanged = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(unchanged.acceptedCount).toBe(0);
    });
  });

  describe('purge', () => {
    /** A seed event with two synthetic guests and one real one, all seated. */
    async function seatedSeedEvent(): Promise<{
      eventId: string;
      eventPublicId: string;
      endsAt: Date;
      hostId: string;
      realUserId: string;
      seedUserIds: string[];
    }> {
      const host = await seedRealHost(fixture.tehranId);
      await seedConfig(fixture.tehranId, host.id, { floorCount: 1, eventCapacity: 3 });
      await scheduler.topUp();
      const [event] = await seededEvents();

      await seedEvents.fillStep(event!.publicId);
      await seedEvents.fillStep(event!.publicId);

      const realUserId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: 500 });
      await prisma.userProfile.create({
        data: {
          userId: realUserId,
          displayName: 'مهمان واقعی',
          cityId: fixture.tehranId,
          birthYear: 1995,
        },
      });
      const request = await participation.join(realUserId, event!.publicId);
      await participation.accept(host.id, request.publicId);

      const seedUsers = await prisma.user.findMany({
        where: { isSeed: true },
        select: { id: true },
      });
      return {
        eventId: event!.id,
        eventPublicId: event!.publicId,
        endsAt: event!.endsAt,
        hostId: host.id,
        realUserId,
        seedUserIds: seedUsers.map((user) => user.id),
      };
    }

    it('removes an event’s synthetic guests once it is over, and only theirs', async () => {
      const seeded = await seatedSeedEvent();
      expect(seeded.seedUserIds).toHaveLength(2);

      // An hour after the end: COMPLETED, but nowhere near the settlement delay.
      clock.set(new Date(seeded.endsAt.getTime() + HOUR));
      await lifecycle.retireStarted();

      const result = await scheduler.purge();

      expect(result).toEqual({ events: 1, users: 2, orphans: 0 });
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(0);

      // The event, its host and the real guest are all still here.
      expect(await prisma.event.count({ where: { id: seeded.eventId } })).toBe(1);
      expect(await prisma.user.count({ where: { id: seeded.hostId } })).toBe(1);
      expect(await prisma.user.count({ where: { id: seeded.realUserId } })).toBe(1);
      const remaining = await prisma.eventParticipant.findMany({
        where: { eventId: seeded.eventId },
        select: { userId: true, status: true },
      });
      expect(remaining).toEqual([{ userId: seeded.realUserId, status: 'ACCEPTED' }]);

      const trail = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'seed.purged', targetId: seeded.eventId },
      });
      expect(trail.actorType).toBe('SYSTEM');

      // The real guest is settled by the unmodified sweep as if nothing happened:
      // attended, credited, and given a review window with the host.
      clock.set(new Date(seeded.endsAt.getTime() + SETTLEMENT_DELAY_MS + HOUR));
      await lifecycle.settleAttendance();
      const settled = await prisma.eventParticipant.findMany({
        where: { eventId: seeded.eventId },
        select: { userId: true, status: true, attended: true },
      });
      expect(settled).toEqual([{ userId: seeded.realUserId, status: 'COMPLETED', attended: true }]);
      expect(await prisma.reviewPair.count({ where: { eventId: seeded.eventId } })).toBe(1);
      expect(
        await prisma.trustScoreLedger.count({
          where: { userId: seeded.realUserId, type: 'ATTENDANCE' },
        }),
      ).toBe(1);
    });

    it('is idempotent: a second pass finds nothing left to do', async () => {
      const seeded = await seatedSeedEvent();
      clock.set(new Date(seeded.endsAt.getTime() + HOUR));
      await lifecycle.retireStarted();
      await scheduler.purge();

      expect(await scheduler.purge()).toEqual({ events: 0, users: 0, orphans: 0 });
    });

    /**
     * The order that must never strand an identity. `trust_score_ledger` is
     * append-only by trigger, so a synthetic guest credited for attending could
     * never be deleted. A worker that was down for a day runs the settlement sweep
     * before the purge; the sweep must therefore settle a seed guest without
     * crediting it.
     */
    it('can still purge a guest the settlement sweep reached first, and credited nothing', async () => {
      const seeded = await seatedSeedEvent();

      clock.set(new Date(seeded.endsAt.getTime() + SETTLEMENT_DELAY_MS + HOUR));
      await lifecycle.retireStarted();
      await lifecycle.settleAttendance();

      // Settled like anybody, earning and owing nothing.
      const settled = await prisma.eventParticipant.findMany({
        where: { eventId: seeded.eventId },
        select: { status: true },
      });
      expect(settled).toHaveLength(3);
      expect(settled.every((row) => row.status === 'COMPLETED')).toBe(true);
      expect(
        await prisma.trustScoreLedger.count({ where: { userId: { in: seeded.seedUserIds } } }),
      ).toBe(0);
      // A review pair for the real guest only: the host is not asked about fakes.
      expect(await prisma.reviewPair.count({ where: { eventId: seeded.eventId } })).toBe(1);

      const result = await scheduler.purge();

      expect(result).toEqual({ events: 1, users: 2, orphans: 0 });
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(0);
      expect(await prisma.user.count({ where: { id: seeded.realUserId } })).toBe(1);
      expect(await prisma.reviewPair.count({ where: { eventId: seeded.eventId } })).toBe(1);
    });

    it('leaves the guests of an event that is under way', async () => {
      const seeded = await seatedSeedEvent();
      const startsAt = (await prisma.event.findUniqueOrThrow({ where: { id: seeded.eventId } }))
        .startsAt;

      clock.set(new Date(startsAt.getTime() + 30 * 60_000));
      await lifecycle.retireStarted();
      expect((await prisma.event.findUniqueOrThrow({ where: { id: seeded.eventId } })).status).toBe(
        'ONGOING',
      );

      expect(await scheduler.purge()).toEqual({ events: 0, users: 0, orphans: 0 });
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(2);
    });

    it('leaves the guests of an event that has not happened yet', async () => {
      await seatedSeedEvent();

      expect(await scheduler.purge()).toEqual({ events: 0, users: 0, orphans: 0 });
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(2);
    });

    it('removes the guests at once when the event was cancelled', async () => {
      const seeded = await seatedSeedEvent();
      await prisma.event.update({
        where: { id: seeded.eventId },
        data: { status: 'CANCELLED_BY_HOST' },
      });

      const result = await scheduler.purge();

      expect(result.users).toBe(2);
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(0);
      expect(await prisma.user.count({ where: { id: seeded.realUserId } })).toBe(1);
    });

    it('does not touch the seats of an ordinary event, whoever is in them', async () => {
      const host = await seedRealHost(fixture.tehranId);
      const guest = await createUser(prisma, 'PROFILE_COMPLETE', { coins: 500 });
      await prisma.userProfile.create({
        data: { userId: guest, displayName: 'مهمان', cityId: fixture.tehranId, birthYear: 1995 },
      });
      const realEvent = await insertRealEvent(host.id, { n: 1 });
      const request = await participation.join(guest, realEvent);
      await participation.accept(host.id, request.publicId);
      await prisma.event.update({
        where: { publicId: realEvent },
        data: { status: 'CANCELLED_BY_HOST' },
      });

      const result = await scheduler.purge();

      expect(result).toEqual({ events: 0, users: 0, orphans: 0 });
      expect(await prisma.eventParticipant.count({ where: { userId: guest } })).toBe(1);
    });

    it('rolls an event back whole, and carries on, when something still references a guest', async () => {
      const seeded = await seatedSeedEvent();
      await prisma.event.update({
        where: { id: seeded.eventId },
        data: { status: 'CANCELLED_BY_HOST' },
      });
      // A ledger row is a reference the purge does not know how to remove, and
      // `coin_ledger.user_id` is RESTRICT: the delete of that guest must fail.
      await grantCoins(prisma, seeded.seedUserIds[0]!, 5);

      const result = await scheduler.purge();

      // Nothing was half-removed: both synthetic guests and all three seats remain,
      // and the pass finished rather than throwing.
      expect(result).toEqual({ events: 0, users: 0, orphans: 0 });
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(2);
      expect(await prisma.eventParticipant.count({ where: { eventId: seeded.eventId } })).toBe(3);
      expect(await prisma.auditLog.count({ where: { action: 'seed.purged' } })).toBe(0);
    });

    it('removes an identity that never got a seat, once it is old enough to be debris', async () => {
      const old = await prisma.user.create({
        data: { isSeed: true, createdAt: new Date(NOW.getTime() - 2 * HOUR) },
      });
      const fresh = await prisma.user.create({
        data: { isSeed: true, createdAt: new Date(NOW.getTime() - 10 * 60_000) },
      });
      // A real account that looks the same from the outside: old, no seat.
      const real = await prisma.user.create({
        data: { isSeed: false, createdAt: new Date(NOW.getTime() - 2 * HOUR) },
      });

      const result = await scheduler.purge();

      expect(result.orphans).toBe(1);
      expect(await prisma.user.count({ where: { id: old.id } })).toBe(0);
      expect(await prisma.user.count({ where: { id: fresh.id } })).toBe(1);
      expect(await prisma.user.count({ where: { id: real.id } })).toBe(1);
    });

    it('does not remove an old identity that is seated in an event still to come', async () => {
      const seeded = await seatedSeedEvent();
      await prisma.user.updateMany({
        where: { isSeed: true },
        data: { createdAt: new Date(NOW.getTime() - 5 * HOUR) },
      });

      const result = await scheduler.purge();

      expect(result.orphans).toBe(0);
      expect(await prisma.user.count({ where: { isSeed: true } })).toBe(seeded.seedUserIds.length);
    });
  });
});
