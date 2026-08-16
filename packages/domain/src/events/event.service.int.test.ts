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
import { CoinService } from '../economy/coin.service';
import { CatalogService } from '../catalog/catalog.service';
import { SettingsService } from '../catalog/settings.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { normalize } from '../moderation/persian-normalizer';
import { EventService, type CreateEventInput } from './event.service';

/**
 * Event authoring against a real database.
 *
 * The properties worth a database: the quota counts a *Tehran* day, the
 * moderation verdict and the event row commit together, a BLOCK never reaches
 * PUBLISHED, and the CHECK constraints hold when the service is wrong.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const catalog = new CatalogService(service);
const settings = new SettingsService(service);
const blacklist = new BlacklistService(service);
const moderation = new ModerationService(service, blacklist);
const audit = new AuditService(service, clock);
const coins = new CoinService(service);
const events = new EventService(service, clock, env, catalog, settings, moderation, coins, audit);

let fixture: CatalogFixture;
let hostId: string;

function validInput(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    title: 'شب بازی رومیزی',
    description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ. همه خوش‌آمدید.',
    categoryId: fixture.categoryId,
    cityId: fixture.tehranId,
    districtId: fixture.tehranDistrictId,
    startsAt: new Date('2026-08-20T15:00:00.000Z'),
    endsAt: new Date('2026-08-20T18:00:00.000Z'),
    capacity: 6,
    costType: 'FREE',
    ...overrides,
  };
}

/**
 * `validInput`, with the district left out entirely.
 *
 * `districtId: undefined` cannot travel through the overrides object:
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and `CreateEventInput` permits only the former. Omitting the key is
 * what a test pairing a city with no district actually means.
 */
function inputWithoutDistrict(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  const { districtId: _dropped, ...rest } = validInput(overrides);
  return rest;
}

/** A host who has finished onboarding, which authoring requires. */
async function createHost(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'میزبان', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

async function seedBlacklist(): Promise<void> {
  await prisma.blacklistVersion.create({ data: { version: 3 } });
  await prisma.blacklistTerm.createMany({
    data: [
      {
        termRaw: 'مشروب',
        termNormalized: normalize('مشروب'),
        patternType: 'SUBSTRING',
        severity: 'BLOCK',
      },
      {
        termRaw: 'شیشه',
        termNormalized: normalize('شیشه'),
        patternType: 'EXACT',
        severity: 'FLAG',
      },
    ],
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  await seedBlacklist();
  hostId = await createHost();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('EventService.create — a clean event', () => {
  it('publishes immediately and records the moderation verdict', async () => {
    const event = await events.create(hostId, validInput());

    expect(event.status).toBe('PUBLISHED');
    expect(event.moderationStatus).toBe('APPROVED');
    expect(event.publishedAt).toEqual(NOW);
    expect(event.acceptedCount).toBe(0);
    expect(event.city.slug).toBe('tehran');
    expect(event.district?.slug).toBe('district-1');

    await expect(prisma.moderationCase.count()).resolves.toBe(0);
  });

  it('stores the normalized text the M5 search index will read', async () => {
    await events.create(hostId, validInput({ title: 'شب بازي   رومیزي' }));

    const row = await prisma.event.findFirstOrThrow({ where: { hostUserId: hostId } });
    expect(row.titleNormalized).toBe('شب بازی رومیزی');
  });

  it('writes one audit row naming the decision (invariant 10)', async () => {
    const event = await events.create(hostId, validInput());
    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: event.publicId } });

    const entries = await prisma.auditLog.findMany({ where: { targetId: row.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'event.created',
      actorType: 'USER',
      targetType: 'event',
      after: { status: 'PUBLISHED', decision: 'CLEAN', blacklistVersion: 3 },
    });
  });
});

describe('EventService.create — auto-moderation', () => {
  it('never publishes a BLOCK match, and opens a case that records the version', async () => {
    const event = await events.create(hostId, validInput({ title: 'دورهمی با مشروب و موسیقی' }));

    expect(event.status).toBe('PENDING_MODERATION');
    expect(event.moderationStatus).toBe('PENDING');
    expect(event.publishedAt).toBeNull();

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: event.publicId } });
    const opened = await prisma.moderationCase.findFirstOrThrow({ where: { subjectId: row.id } });

    expect(opened).toMatchObject({
      subjectType: 'EVENT',
      trigger: 'AUTO_BLACKLIST',
      status: 'OPEN',
      blacklistVersion: 3,
    });
    expect(JSON.stringify(opened.matchedTerms)).toContain('مشروب');
  });

  it('publishes a FLAG match and opens a case anyway (ADR-0012)', async () => {
    // The central tuning decision: a queue entry is cheap, a blocked legitimate
    // host is not.
    const event = await events.create(hostId, validInput({ title: 'دورهمی در کافه شیشه ای' }));

    expect(event.status).toBe('PUBLISHED');
    expect(event.moderationStatus).toBe('FLAGGED');

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: event.publicId } });
    await expect(prisma.moderationCase.count({ where: { subjectId: row.id } })).resolves.toBe(1);
  });

  it('catches a term obfuscated with half-spaces and Arabic letters', async () => {
    const event = await events.create(hostId, validInput({ title: 'دورهمي با مَشْروب' }));
    expect(event.status).toBe('PENDING_MODERATION');
  });

  it('scans the description too, so splitting across fields is not an evasion', async () => {
    const event = await events.create(
      hostId,
      validInput({ description: 'یک دورهمی دوستانه. مشروب هم داریم برای همه.' }),
    );
    expect(event.status).toBe('PENDING_MODERATION');
  });
});

describe('EventService.create — validation', () => {
  it('refuses a host who has not completed their profile', async () => {
    const stranger = await createUser(prisma, 'TERMS_ACCEPTED');
    await expect(events.create(stranger, validInput())).rejects.toMatchObject({
      code: 'PROFILE_INCOMPLETE',
    });
  });

  it('refuses a start time in the past, measured on the server clock', async () => {
    await expect(
      events.create(hostId, validInput({ startsAt: new Date('2026-08-01T10:00:00.000Z') })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses an end before its start', async () => {
    await expect(
      events.create(
        hostId,
        validInput({
          startsAt: new Date('2026-08-20T18:00:00.000Z'),
          endsAt: new Date('2026-08-20T15:00:00.000Z'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses an inactive category', async () => {
    await expect(
      events.create(hostId, validInput({ categoryId: fixture.retiredCategoryId })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses an inactive city', async () => {
    await expect(
      events.create(hostId, inputWithoutDistrict({ cityId: fixture.karajId })),
    ).rejects.toMatchObject({ code: 'CITY_NOT_AVAILABLE' });
  });

  it('refuses a district from another city', async () => {
    await expect(
      events.create(hostId, validInput({ districtId: fixture.karajDistrictId })),
    ).rejects.toMatchObject({ code: 'INVALID_DISTRICT' });
  });

  it('leaves nothing behind when it refuses', async () => {
    await expect(
      events.create(hostId, validInput({ districtId: fixture.karajDistrictId })),
    ).rejects.toThrow();

    await expect(prisma.event.count()).resolves.toBe(0);
    await expect(prisma.auditLog.count()).resolves.toBe(0);
  });

  it('refuses an http link at the database, not only in the contract (T5.3)', async () => {
    // The service is handed a value the zod contract would have rejected, which
    // is exactly the case the CHECK constraint exists for.
    await expect(
      events.create(hostId, validInput({ externalLink: 'http://example.com' })),
    ).rejects.toThrow(/event_external_link_https/);
  });

  it('refuses a cost amount that contradicts the cost type', async () => {
    await expect(
      events.create(hostId, validInput({ costType: 'FREE', costAmount: 50_000 })),
    ).rejects.toThrow(/event_cost_amount_matches_type/);
  });
});

describe('EventService.create — quotas (plan §11)', () => {
  it('allows five in a Tehran day and refuses the sixth', async () => {
    // Five separate future days, so the concurrency limit is not what stops it.
    for (let index = 0; index < 5; index += 1) {
      const day = 20 + index;
      await events.create(
        hostId,
        validInput({
          startsAt: new Date(`2026-09-${String(day)}T15:00:00.000Z`),
          endsAt: new Date(`2026-09-${String(day)}T18:00:00.000Z`),
        }),
      );
      // Retire it, so only the daily limit is in play.
      await prisma.event.updateMany({ where: { hostUserId: hostId }, data: { status: 'EXPIRED' } });
    }

    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'EVENT_QUOTA_EXCEEDED',
      details: { scope: 'per_day', limit: 5 },
    });
  });

  it('resets the daily count at Tehran midnight, not UTC midnight', async () => {
    clock.set(new Date('2026-08-15T19:00:00.000Z')); // 22:30 Tehran
    for (let index = 0; index < 5; index += 1) {
      await events.create(
        hostId,
        validInput({
          startsAt: new Date(`2026-09-${String(20 + index)}T15:00:00.000Z`),
          endsAt: new Date(`2026-09-${String(20 + index)}T18:00:00.000Z`),
        }),
      );
      await prisma.event.updateMany({ where: { hostUserId: hostId }, data: { status: 'EXPIRED' } });
    }

    // 20:00 UTC is still the 15th in Tehran (23:30) — still blocked.
    clock.set(new Date('2026-08-15T20:00:00.000Z'));
    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'EVENT_QUOTA_EXCEEDED',
    });

    // 20:31 UTC is 00:01 on the 16th in Tehran — a new day, and allowed.
    clock.set(new Date('2026-08-15T20:31:00.000Z'));
    await expect(events.create(hostId, validInput())).resolves.toMatchObject({
      status: 'PUBLISHED',
    });
  });

  it('refuses a fourth concurrent upcoming event', async () => {
    for (let index = 0; index < 3; index += 1) {
      await events.create(
        hostId,
        validInput({
          startsAt: new Date(`2026-09-${String(20 + index)}T15:00:00.000Z`),
          endsAt: new Date(`2026-09-${String(20 + index)}T18:00:00.000Z`),
        }),
      );
    }

    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'EVENT_QUOTA_EXCEEDED',
      details: { scope: 'concurrent_active', limit: 3 },
    });
  });

  it('does not count events that have already started', async () => {
    // Without the `startsAt` filter, three stale events would lock a host out
    // permanently — the lifecycle sweep that retires them is M13.
    for (let index = 0; index < 3; index += 1) {
      await events.create(
        hostId,
        validInput({
          startsAt: new Date(`2026-09-${String(20 + index)}T15:00:00.000Z`),
          endsAt: new Date(`2026-09-${String(20 + index)}T18:00:00.000Z`),
        }),
      );
    }

    clock.set(new Date('2026-10-01T09:00:00.000Z'));
    await expect(
      events.create(
        hostId,
        validInput({
          startsAt: new Date('2026-10-20T15:00:00.000Z'),
          endsAt: new Date('2026-10-20T18:00:00.000Z'),
        }),
      ),
    ).resolves.toMatchObject({ status: 'PUBLISHED' });
  });

  it('takes both limits from app_setting', async () => {
    await prisma.appSetting.create({ data: { key: 'events.max_per_day', value: 1 } });
    await events.create(hostId, validInput());

    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'EVENT_QUOTA_EXCEEDED',
      details: { limit: 1 },
    });
  });
});

describe('EventService.update', () => {
  it('applies a non-sensitive edit without re-moderating', async () => {
    const created = await events.create(hostId, validInput());
    const updated = await events.update(hostId, created.publicId, { capacity: 10 });

    expect(updated.capacity).toBe(10);
    expect(updated.status).toBe('PUBLISHED');
    expect(updated.version).toBe(1);

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    const entries = await prisma.auditLog.findMany({
      where: { targetId: row.id, action: 'event.updated' },
    });
    expect(entries[0]?.after).toMatchObject({ rescanned: false });
  });

  it('re-scans a title change and can send a live event back to moderation', async () => {
    const created = await events.create(hostId, validInput());
    expect(created.status).toBe('PUBLISHED');

    const updated = await events.update(hostId, created.publicId, {
      title: 'دورهمی با مشروب',
    });

    expect(updated.status).toBe('PENDING_MODERATION');
    expect(updated.moderationStatus).toBe('PENDING');

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    await expect(prisma.moderationCase.count({ where: { subjectId: row.id } })).resolves.toBe(1);
  });

  it('keeps a clean edit published and re-scans it', async () => {
    const created = await events.create(hostId, validInput());
    const updated = await events.update(hostId, created.publicId, {
      title: 'شب بازی رومیزی و پیتزا',
    });

    expect(updated.status).toBe('PUBLISHED');
    expect(updated.moderationStatus).toBe('APPROVED');
  });

  it('does not restamp published_at when an edit round-trips through moderation', async () => {
    const created = await events.create(hostId, validInput());
    const firstPublish = created.publishedAt;

    clock.advance(3 * 60 * 60 * 1000);
    const updated = await events.update(hostId, created.publicId, {
      title: 'شب بازی رومیزی و چای',
    });

    // Otherwise "how long has this been live?" quietly becomes "how long since
    // the host last fixed a typo?".
    expect(updated.publishedAt).toEqual(firstPublish);
  });

  it('refuses an edit from someone who is not the host', async () => {
    const created = await events.create(hostId, validInput());
    const stranger = await createUser(prisma, 'PROFILE_COMPLETE');

    // The same error as "no such event": a distinguishable response would be an
    // existence oracle over every public id (T3.1, T3.3).
    await expect(events.update(stranger, created.publicId, { capacity: 50 })).rejects.toMatchObject(
      { code: 'EVENT_NOT_FOUND' },
    );
  });

  it('refuses a stale version', async () => {
    const created = await events.create(hostId, validInput());
    await events.update(hostId, created.publicId, { capacity: 8 });

    await expect(events.update(hostId, created.publicId, { capacity: 9 }, 0)).rejects.toMatchObject(
      { code: 'CONFLICT_STALE_VERSION', httpStatus: 409 },
    );
  });

  it('accepts the current version', async () => {
    const created = await events.create(hostId, validInput());
    await expect(
      events.update(hostId, created.publicId, { capacity: 8 }, created.version),
    ).resolves.toMatchObject({ capacity: 8 });
  });

  it('refuses a capacity below the number already accepted', async () => {
    const created = await events.create(hostId, validInput({ capacity: 6 }));
    await prisma.event.update({
      where: { publicId: created.publicId },
      data: { acceptedCount: 4 },
    });

    await expect(events.update(hostId, created.publicId, { capacity: 2 })).rejects.toMatchObject({
      code: 'CAPACITY_BELOW_ACCEPTED',
      details: { capacity: 2, acceptedCount: 4 },
    });
  });

  it('refuses to edit an event that has already run', async () => {
    const created = await events.create(hostId, validInput());
    await prisma.event.update({
      where: { publicId: created.publicId },
      data: { status: 'COMPLETED' },
    });

    await expect(events.update(hostId, created.publicId, { capacity: 8 })).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('re-checks a district against a changed city', async () => {
    const created = await events.create(hostId, validInput());
    await prisma.city.update({ where: { id: fixture.karajId }, data: { isActive: true } });

    await expect(
      events.update(hostId, created.publicId, { cityId: fixture.karajId }),
    ).resolves.toMatchObject({ city: { slug: 'karaj' }, district: null });
  });
});

describe('EventService.listOwned', () => {
  it('shows the host their unpublished events', async () => {
    await events.create(hostId, validInput());
    await events.create(hostId, validInput({ title: 'دورهمی با مشروب' }));

    const owned = await events.listOwned(hostId);
    expect(owned.map((event) => event.status).sort()).toEqual(['PENDING_MODERATION', 'PUBLISHED']);
  });

  it('shows nothing of another host', async () => {
    await events.create(hostId, validInput());
    const stranger = await createUser(prisma, 'PROFILE_COMPLETE');
    await expect(events.listOwned(stranger)).resolves.toEqual([]);
  });
});

/**
 * The two coin sinks (plan §2.9, §11), and the only place in the MVP where a
 * user's own balance goes down because they asked it to.
 *
 * What is worth a database here is the pairing: the coins leave and the placement
 * arrives in one transaction, or neither happens. A host charged forty coins for a
 * boost that did not apply has no way to tell the difference between that and a
 * boost that expired, so the failure is invisible to exactly the person it robs.
 */
describe('EventService.boost — the two coin sinks (plan §2.9)', () => {
  /** Coins in hand, granted the only way anything may: through the ledger. */
  async function fund(userId: string, amount: number): Promise<void> {
    await coins.apply({
      userId,
      amount,
      type: 'ADMIN_ADJUSTMENT',
      reasonCode: 'test.funding',
      idempotencyKey: `fund:${userId}:${String(amount)}`,
      actorType: 'ADMIN',
    });
  }

  it('opens a window and charges the configured price', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());

    const boosted = await events.boost(hostId, created.publicId, 'BOOST');

    // 40 coins for 24 hours, from `SETTING_DEFAULTS`.
    expect(boosted.boostedUntil).toEqual(new Date(NOW.getTime() + 24 * 3_600_000));
    await expect(coins.balanceOf(hostId)).resolves.toBe(60);
  });

  /**
   * A host who pays twice gets twice.
   *
   * Overwriting would silently sell the second window at a discount of however
   * much of the first one was left — the kind of arithmetic a user notices only
   * as "I paid and nothing happened".
   */
  it('extends a live window rather than overwriting it', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());

    await events.boost(hostId, created.publicId, 'BOOST');
    clock.set(new Date(NOW.getTime() + 6 * 3_600_000));
    const second = await events.boost(hostId, created.publicId, 'BOOST');

    // 24 h remaining at purchase + 24 h bought, measured from the first expiry.
    expect(second.boostedUntil).toEqual(new Date(NOW.getTime() + 48 * 3_600_000));
    await expect(coins.balanceOf(hostId)).resolves.toBe(20);
  });

  it('starts a lapsed window from now, not from the old expiry', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());

    await events.boost(hostId, created.publicId, 'BOOST');
    const later = new Date(NOW.getTime() + 30 * 3_600_000);
    clock.set(later);
    const second = await events.boost(hostId, created.publicId, 'BOOST');

    expect(second.boostedUntil).toEqual(new Date(later.getTime() + 24 * 3_600_000));
  });

  /**
   * VIP is a flag, so its idempotency key is just the event — which makes buying
   * it twice structurally impossible rather than merely discouraged. This is the
   * property boost cannot have, because a second boost is a second window.
   */
  it('charges for VIP once, however many times it is bought', async () => {
    await fund(hostId, 250);
    const created = await events.create(hostId, validInput());

    const first = await events.boost(hostId, created.publicId, 'VIP');
    const second = await events.boost(hostId, created.publicId, 'VIP');

    expect(first.isVip).toBe(true);
    expect(second.isVip).toBe(true);
    await expect(coins.balanceOf(hostId)).resolves.toBe(150);
    await expect(prisma.coinLedger.count({ where: { type: 'VIP_SPEND' } })).resolves.toBe(1);
  });

  it('leaves the event untouched when the host cannot afford it', async () => {
    await fund(hostId, 10);
    const created = await events.create(hostId, validInput());

    await expect(events.boost(hostId, created.publicId, 'BOOST')).rejects.toMatchObject({
      code: 'INSUFFICIENT_COINS',
    });

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    expect(row.boostedUntil).toBeNull();
    await expect(coins.balanceOf(hostId)).resolves.toBe(10);
  });

  /**
   * The spend is traceable to what it bought.
   *
   * ADR-0007's whole point applied to the one purchase a user makes with their
   * own coins: "where did my forty coins go?" is answered by a row that names the
   * event, not by a reason code they have to interpret.
   */
  it('records the spend against the event that was promoted', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());
    await events.boost(hostId, created.publicId, 'BOOST');

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    const entry = await prisma.coinLedger.findFirstOrThrow({ where: { type: 'BOOST_SPEND' } });

    expect(entry.amount).toBe(-40);
    expect(entry.refType).toBe('event');
    expect(entry.refId).toBe(row.id);
    expect(entry.actorType).toBe('USER');
    await expect(
      prisma.auditLog.count({ where: { targetId: row.id, action: 'event.boosted' } }),
    ).resolves.toBe(1);
  });

  it('tells a stranger the event does not exist, and charges them nothing', async () => {
    const created = await events.create(hostId, validInput());
    const stranger = await createUser(prisma, 'PROFILE_COMPLETE');
    await fund(stranger, 100);

    await expect(events.boost(stranger, created.publicId, 'BOOST')).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
    await expect(coins.balanceOf(stranger)).resolves.toBe(100);
  });

  it('refuses to promote something nobody can see', async () => {
    await fund(hostId, 100);
    // A BLOCK verdict lands in PENDING_MODERATION, which discovery never shows.
    const blocked = await events.create(hostId, validInput({ title: 'دورهمی با مشروب' }));
    expect(blocked.status).toBe('PENDING_MODERATION');

    await expect(events.boost(hostId, blocked.publicId, 'BOOST')).rejects.toMatchObject({
      code: 'EVENT_NOT_BOOSTABLE',
    });
    await expect(coins.balanceOf(hostId)).resolves.toBe(100);
  });

  it('refuses to promote an event that has already started', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());
    clock.set(new Date('2026-08-20T16:00:00.000Z'));

    await expect(events.boost(hostId, created.publicId, 'BOOST')).rejects.toMatchObject({
      code: 'EVENT_NOT_BOOSTABLE',
    });
    await expect(coins.balanceOf(hostId)).resolves.toBe(100);
  });
});

describe('the capacity invariant (invariant 1)', () => {
  it('is enforced by the database, not only by the service', async () => {
    const created = await events.create(hostId, validInput({ capacity: 4 }));

    // A direct write, bypassing every service check — which is the case the
    // CHECK constraint exists for. M6's row lock is the other half.
    await expect(
      prisma.event.update({
        where: { publicId: created.publicId },
        data: { acceptedCount: 5 },
      }),
    ).rejects.toThrow(/event_accepted_count_within_capacity/);
  });
});
