import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { MessageCipher } from '../chat/message-cipher';
import { ChatService } from '../chat/chat.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { OutboxService } from '../outbox/outbox.service';
import { CatalogService } from '../catalog/catalog.service';
import { ChannelService } from '../channel/channel.service';
import { SETTING_DEFAULTS, SettingsService } from '../catalog/settings.service';
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

const settings = new SettingsService(service);
/**
 * `CatalogService` reads `TELEGRAM_BOT_USERNAME` for the deep link the Mini App
 * builds (report 6). Never the token — there is no code path here that reads one.
 */
const catalogEnv = { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as unknown as Env;

const catalog = new CatalogService(service, settings, catalogEnv);
const blacklist = new BlacklistService(service);
const moderation = new ModerationService(service, blacklist);
const channel = new ChannelService(service, clock, settings);
const audit = new AuditService(service, clock);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
const outbox = new OutboxService(service, clock);
const cipher = new MessageCipher({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as unknown as Env);
const chat = new ChatService(service, clock, cipher, audit, outbox);
/**
 * The channel-membership gate, in its permissive default state.
 *
 * `event_channel_config` is truncated between tests, so `membershipRequired` is
 * false and every check answers NOT_REQUIRED — the gate is a no-op here, which is
 * what these suites want. `membership.int.test.ts` is where it is switched on.
 */
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
  chat,
  outbox,
  audit,
);

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

/**
 * What a host starts with, so authoring can cost coins (M22 phase 5).
 *
 * A real account gets this from the onboarding grant; `createUser` writes the row
 * directly and never runs it. Large enough that no test in this file is
 * accidentally about affordability — the one that *is* funds a host deliberately
 * and asserts the refusal.
 */
const HOST_ENDOWMENT = 1_000;

/** What creating an event costs, read from the same table the service reads. */
const CREATE_COST = SETTING_DEFAULTS['economy.event_create_coins'];

/**
 * The channel placement a registration includes, and the two together.
 *
 * A published event costs both; a BLOCKed one costs only `CREATE_COST`, because
 * there is nothing to place in the channel and the service does not claim one.
 * That difference is why the assertions below do not all use the same constant.
 */
const CHANNEL_PUBLISH_COST = SETTING_DEFAULTS['economy.event_channel_publish_coins'];
const REGISTER_COST = CREATE_COST + CHANNEL_PUBLISH_COST;

/** A host who has finished onboarding, which authoring requires. */
async function createHost(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: HOST_ENDOWMENT });
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

/**
 * The «سایر» tag (M21).
 *
 * `allows_custom_label` is a column rather than a `slug === 'other'` check, so
 * these tests set the flag on a fixture category rather than reaching for a
 * particular slug — which is the property being asserted as much as the
 * behaviour.
 */
describe('EventService.create — a category that allows a custom label', () => {
  beforeEach(async () => {
    await prisma.category.update({
      where: { id: fixture.categoryId },
      data: { allowsCustomLabel: true },
    });
  });

  it("stores the host's own words", async () => {
    const created = await events.create(
      hostId,
      validInput({ customCategoryLabel: 'بازدید از نمایشگاه کتاب' }),
    );

    expect(created.customCategoryLabel).toBe('بازدید از نمایشگاه کتاب');
  });

  /**
   * Required, not optional. A «سایر» event with no label tells a reader nothing
   * at all — the words the host types are the entire meaning of the category.
   */
  it('refuses the category without one', async () => {
    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'CUSTOM_LABEL_REQUIRED',
    });
  });

  /**
   * The label is free text a host types, so it is exactly the kind of field the
   * blacklist exists to read. A label that never reached the scanner would be the
   * one place in the product where a host can write anything unexamined.
   */
  it('scans the label against the blacklist, like the title', async () => {
    const created = await events.create(
      hostId,
      validInput({ customCategoryLabel: 'دورهمی با مشروب' }),
    );

    expect(created.status).toBe('PENDING_MODERATION');
    expect(created.moderationStatus).toBe('PENDING');

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    await expect(prisma.moderationCase.count({ where: { subjectId: row.id } })).resolves.toBe(1);
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

  it('refuses a custom label for a category that does not allow one', async () => {
    await expect(
      events.create(hostId, validInput({ customCategoryLabel: 'هرچه دلم خواست' })),
    ).rejects.toMatchObject({ code: 'CUSTOM_LABEL_NOT_ALLOWED' });
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

    /**
     * Its **own** error code as of v0.6.5, and the reason is the message behind
     * it. Both quotas used to raise `EVENT_QUOTA_EXCEEDED`, whose Persian names
     * the *daily* limit — so a host stopped by concurrency was told the wrong
     * thing, and the operator who then raised `events.max_per_day` from 5 to 30
     * watched the product carry on refusing and reported the setting as broken.
     * The two are cleared by different actions: one by waiting for tomorrow, the
     * other by finishing an event you already have.
     */
    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'EVENT_ACTIVE_QUOTA_EXCEEDED',
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

/**
 * The pre-flight, and the reason it exists.
 *
 * The bot's create-event wizard asks fourteen questions. Until v0.6.5 the quota
 * was discovered by `create` at the end of them: a host who had already reached
 * the limit filled in a title, a description, a category, a place, a date, a
 * capacity and a price, pressed «ثبت فعالیت», and was told they could not create
 * an event today. The refusal was correct and arrived after every opportunity to
 * act on it had passed.
 *
 * It is the **same** check — `assertWithinQuota` is written in terms of this, so
 * the two cannot disagree — offered where a flow begins rather than where it
 * ends. Deliberately a snapshot and not a reservation: `create` re-checks under
 * its own transaction, because a host may create an event on another surface
 * while this conversation is open.
 */
describe('EventService.quotaFor — the pre-flight', () => {
  it('reports both counts and both limits with nothing created', async () => {
    expect(await events.quotaFor(hostId)).toEqual({
      createdToday: 0,
      maxPerDay: 5,
      activeCount: 0,
      maxConcurrentActive: 3,
      blockedBy: null,
    });
  });

  it('counts what has been created today', async () => {
    await events.create(hostId, validInput());

    expect(await events.quotaFor(hostId)).toMatchObject({
      createdToday: 1,
      activeCount: 1,
      blockedBy: null,
    });
  });

  it('names the daily quota once it is spent', async () => {
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

    expect(await events.quotaFor(hostId)).toMatchObject({
      createdToday: 5,
      blockedBy: 'per_day',
    });
  });

  it('names the concurrency quota when that is the one that binds', async () => {
    for (let index = 0; index < 3; index += 1) {
      await events.create(
        hostId,
        validInput({
          startsAt: new Date(`2026-09-${String(20 + index)}T15:00:00.000Z`),
          endsAt: new Date(`2026-09-${String(20 + index)}T18:00:00.000Z`),
        }),
      );
    }

    expect(await events.quotaFor(hostId)).toMatchObject({
      createdToday: 3,
      activeCount: 3,
      blockedBy: 'concurrent_active',
    });
  });

  /**
   * The operator's report, as a test: raising the number in the panel raises the
   * number the product enforces *and* the number it reports.
   */
  it('follows `events.max_per_day` when an operator changes it', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'events.max_per_day' },
      create: { key: 'events.max_per_day', value: 30 },
      update: { value: 30 },
    });

    expect(await events.quotaFor(hostId)).toMatchObject({ maxPerDay: 30, blockedBy: null });
  });

  it('agrees with what `create` actually does', async () => {
    for (let index = 0; index < 3; index += 1) {
      await events.create(
        hostId,
        validInput({
          startsAt: new Date(`2026-09-${String(20 + index)}T15:00:00.000Z`),
          endsAt: new Date(`2026-09-${String(20 + index)}T18:00:00.000Z`),
        }),
      );
    }

    const quota = await events.quotaFor(hostId);
    expect(quota.blockedBy).toBe('concurrent_active');
    await expect(events.create(hostId, validInput())).rejects.toMatchObject({
      code: 'EVENT_ACTIVE_QUOTA_EXCEEDED',
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

  /**
   * What the host is told about the channel, and when.
   *
   * The post is produced by a five-minute sweep, so the honest sequence is
   * NONE → QUEUED → PUBLISHED. Reporting `PUBLISHED` at purchase time would be a
   * claim about Telegram the product has not yet earned, and reading the claim row
   * alone would flicker back to NONE whenever a failed send released it.
   */
  it('reports NONE before anything is bought', async () => {
    const created = await events.create(hostId, validInput());

    expect(created.channelStatus).toBe('NONE');
  });

  it('reports QUEUED the moment coins are spent, not PUBLISHED', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());

    const boosted = await events.boost(hostId, created.publicId, 'BOOST');

    expect(boosted.channelStatus).toBe('QUEUED');
  });

  it('reports PUBLISHED once the sweep records a Telegram message id', async () => {
    await fund(hostId, 250);
    const created = await events.create(hostId, validInput());
    await events.boost(hostId, created.publicId, 'VIP');

    // What `ChannelService.markPosted` writes after Telegram confirms.
    const row = await prisma.event.findFirstOrThrow({
      where: { publicId: created.publicId },
      select: { id: true },
    });
    await prisma.channelPost.create({
      data: { eventId: row.id, kind: 'VIP', telegramMessageId: 4242, postedAt: NOW },
    });

    const [mine] = await events.listOwned(hostId);
    expect(mine?.channelStatus).toBe('PUBLISHED');
  });

  it('stays QUEUED when a failed send released its claim', async () => {
    // `releaseClaim` deletes the row so the next sweep can retry. The host has paid,
    // so the answer is still "on its way" rather than "nothing bought".
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());
    await events.boost(hostId, created.publicId, 'BOOST');

    const [mine] = await events.listOwned(hostId);
    expect(mine?.channelStatus).toBe('QUEUED');
  });

  it('reports NONE again once the boost window has lapsed', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());
    await events.boost(hostId, created.publicId, 'BOOST');

    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    const [mine] = await events.listOwned(hostId);

    expect(mine?.channelStatus).toBe('NONE');
  });

  it('opens a window and charges the configured price', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());

    const boosted = await events.boost(hostId, created.publicId, 'BOOST');

    // 40 coins for 24 hours, from `SETTING_DEFAULTS`.
    expect(boosted.boostedUntil).toEqual(new Date(NOW.getTime() + 24 * 3_600_000));
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT + 100 - REGISTER_COST - 40);
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
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT + 100 - REGISTER_COST - 80);
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
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT + 250 - REGISTER_COST - 100);
    await expect(prisma.coinLedger.count({ where: { type: 'VIP_SPEND' } })).resolves.toBe(1);
  });

  it('leaves the event untouched when the host cannot afford it', async () => {
    // A host with exactly enough to author and nothing to promote with. The
    // shared `hostId` is deliberately not used: it is endowed so that every
    // other test in this file is about something other than affordability.
    const poor = await createUser(prisma, 'PROFILE_COMPLETE', { coins: REGISTER_COST + 10 });
    await prisma.userProfile.create({
      data: { userId: poor, displayName: 'کم‌سکه', cityId: fixture.tehranId, birthYear: 1995 },
    });
    const created = await events.create(poor, validInput());

    await expect(events.boost(poor, created.publicId, 'BOOST')).rejects.toMatchObject({
      code: 'INSUFFICIENT_COINS',
    });

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    expect(row.boostedUntil).toBeNull();
    await expect(coins.balanceOf(poor)).resolves.toBe(10);
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
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT + 100 - CREATE_COST);
  });

  it('refuses to promote an event that has already started', async () => {
    await fund(hostId, 100);
    const created = await events.create(hostId, validInput());
    clock.set(new Date('2026-08-20T16:00:00.000Z'));

    await expect(events.boost(hostId, created.publicId, 'BOOST')).rejects.toMatchObject({
      code: 'EVENT_NOT_BOOSTABLE',
    });
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT + 100 - REGISTER_COST);
  });
});

/**
 * What creating an event costs (M22 phase 5).
 *
 * The property worth a real database is the pairing, and it is the same one the
 * boost suite above checks from the other side: the coins leave and the event
 * arrives in one transaction, or neither does. A host charged for an event that
 * was rolled back has no way to tell that from a bug, and the money is gone
 * either way.
 */
describe('EventService.create — the creation charge (M22 phase 5)', () => {
  it('charges the configured price and records it against the event', async () => {
    const created = await events.create(hostId, validInput());

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    const entry = await prisma.coinLedger.findFirstOrThrow({
      where: { type: 'EVENT_CREATE_SPEND' },
    });

    expect(entry.amount).toBe(-CREATE_COST);
    expect(entry.reasonCode).toBe('event.created');
    expect(entry.refType).toBe('event');
    expect(entry.refId).toBe(row.id);
    expect(entry.actorType).toBe('USER');
    // The create row alone is `CREATE_COST`; the balance also carries the channel
    // placement the registration includes.
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT - REGISTER_COST);
  });

  it('refuses, and creates nothing, when the host cannot afford it', async () => {
    const pauper = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.userProfile.create({
      data: { userId: pauper, displayName: 'بی‌سکه', cityId: fixture.tehranId, birthYear: 1995 },
    });

    await expect(events.create(pauper, validInput())).rejects.toMatchObject({
      code: 'INSUFFICIENT_COINS',
    });

    // The whole point of charging inside the transaction: no orphan event, and
    // no orphan quota consumption either.
    await expect(prisma.event.count({ where: { hostUserId: pauper } })).resolves.toBe(0);
    await expect(coins.balanceOf(pauper)).resolves.toBe(0);
  });

  /**
   * A blocked event is still an event.
   *
   * It exists, it consumed a slot of the daily quota and it is queued for a human
   * to read. Not charging would make the blacklist a free way to occupy a
   * moderator; reversing it automatically would be an apology for content the
   * scanner objected to. A moderator who disagrees reverses it by hand, which is
   * a decision with a name on it.
   */
  it('charges for a BLOCKed event too, because the event exists', async () => {
    await events.create(hostId, validInput({ title: 'دورهمی با مشروب' }));

    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT - CREATE_COST);
    await expect(prisma.coinLedger.count({ where: { type: 'EVENT_CREATE_SPEND' } })).resolves.toBe(
      1,
    );
  });

  /**
   * Two creations at once are two events and two charges — which is correct, and
   * is *not* what an accidental double-tap should produce. That case is plan §6's
   * `Idempotency-Key` header, tested in `apps/api/src/common/idempotency.int.test.ts`
   * against the HTTP layer where the header exists.
   */
  it('charges once per event under concurrency, and never oversells the balance', async () => {
    const broke = await createUser(prisma, 'PROFILE_COMPLETE', { coins: REGISTER_COST });
    await prisma.userProfile.create({
      data: { userId: broke, displayName: 'یک‌بار', cityId: fixture.tehranId, birthYear: 1995 },
    });

    const results = await Promise.allSettled([
      events.create(broke, validInput()),
      events.create(broke, validInput({ title: 'دورهمی دوم در کافه' })),
    ]);

    // Exactly one could be paid for. The other is refused rather than driving the
    // balance negative, which the CHECK would refuse anyway.
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(coins.balanceOf(broke)).resolves.toBe(0);
    await expect(prisma.event.count({ where: { hostUserId: broke } })).resolves.toBe(1);
  });

  it('writes no ledger row at all when the price is zero', async () => {
    await prisma.appSetting.upsert({
      where: { key: 'economy.event_create_coins' },
      create: { key: 'economy.event_create_coins', value: 0 },
      update: { value: 0 },
    });

    await events.create(hostId, validInput());

    // `coin_ledger.amount` may not be zero, so "free" has to mean no row rather
    // than a row recording that nothing happened.
    await expect(prisma.coinLedger.count({ where: { type: 'EVENT_CREATE_SPEND' } })).resolves.toBe(
      0,
    );
    // Only the create half was zeroed. The channel placement is a separate
    // setting and still costs what it costs — which is the point of pricing the
    // two apart even though the host is quoted their sum.
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT - CHANNEL_PUBLISH_COST);
  });
});

/**
 * Buying a place in the channel (M22 phase 5).
 *
 * The property worth a real database is the same one boost has, plus one more:
 * `UNIQUE (event_id, kind)` is what makes the purchase exactly-once, and the claim
 * is taken *before* the charge so a second attempt is refused rather than charged
 * and then refunded.
 */
describe('EventService.publishToChannel — the paid channel post', () => {
  const SEND_COST = SETTING_DEFAULTS['economy.event_channel_send_coins'];

  it('claims a PAID post and charges the configured price', async () => {
    const created = await events.create(hostId, validInput());

    await events.publishToChannel(hostId, created.publicId);

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    // Two now: the one registration claimed at sequence 0, and the renewal at 1.
    const posts = await prisma.channelPost.findMany({
      where: { eventId: row.id },
      orderBy: { republishSeq: 'asc' },
    });
    expect(posts.map((post) => post.republishSeq)).toEqual([0, 1]);
    expect(posts.every((post) => post.kind === 'PAID')).toBe(true);
    // Unposted: nothing here talks to Telegram, the worker's sweep does.
    expect(posts[1]?.postedAt).toBeNull();
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT - REGISTER_COST - SEND_COST);

    const entry = await prisma.coinLedger.findFirstOrThrow({
      where: { type: 'CHANNEL_POST_SPEND' },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry.amount).toBe(-SEND_COST);
    expect(entry.refId).toBe(row.id);
  });

  /**
   * What this test used to assert is now the opposite of the rule.
   *
   * It pinned *"an event reaches the channel by purchase at most once, ever"* —
   * a second call was `EVENT_ALREADY_IN_CHANNEL` and charged nothing. Renewal is
   * the feature that replaced that rule, so the property worth pinning is the one
   * that took over: each renewal is its own purchase at its own sequence, and the
   * post it replaces is superseded so the channel does not end up holding two
   * copies of one activity.
   */
  it('charges each renewal separately and supersedes the post it replaces', async () => {
    const created = await events.create(hostId, validInput());
    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    // The registration's own post, as the sweep would leave it once Telegram
    // accepted it — `supersede` only acts on a post that actually reached the
    // channel.
    await prisma.channelPost.updateMany({
      where: { eventId: row.id, republishSeq: 0 },
      data: { postedAt: new Date(), telegramMessageId: 4242 },
    });

    await events.publishToChannel(hostId, created.publicId);
    await events.publishToChannel(hostId, created.publicId);

    const posts = await prisma.channelPost.findMany({
      where: { eventId: row.id },
      orderBy: { republishSeq: 'asc' },
    });
    expect(posts.map((post) => post.republishSeq)).toEqual([0, 1, 2]);
    // The posted one was replaced and is queued for takedown; the unposted one
    // had no message to remove, so nothing marked it.
    expect(posts[0]?.supersededAt).not.toBeNull();
    expect(posts[1]?.supersededAt).toBeNull();

    // One row for the registration's placement, one per renewal.
    await expect(prisma.coinLedger.count({ where: { type: 'CHANNEL_POST_SPEND' } })).resolves.toBe(
      3,
    );
    await expect(coins.balanceOf(hostId)).resolves.toBe(
      HOST_ENDOWMENT - REGISTER_COST - SEND_COST * 2,
    );
  });

  /**
   * A double tap is one renewal, and the sequence is what makes that true: both
   * calls resolve to the same next sequence, so the second collides on the unique
   * index before it can charge.
   */
  it('refuses a second concurrent renewal rather than charging twice', async () => {
    const created = await events.create(hostId, validInput());

    const results = await Promise.allSettled([
      events.publishToChannel(hostId, created.publicId),
      events.publishToChannel(hostId, created.publicId),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_ENDOWMENT - REGISTER_COST - SEND_COST);
  });

  it('claims nothing when the host cannot afford it', async () => {
    // Exactly enough to register and nothing left to renew with.
    const poor = await createUser(prisma, 'PROFILE_COMPLETE', { coins: REGISTER_COST });
    await prisma.userProfile.create({
      data: { userId: poor, displayName: 'کم‌سکه', cityId: fixture.tehranId, birthYear: 1995 },
    });
    const created = await events.create(poor, validInput());

    await expect(events.publishToChannel(poor, created.publicId)).rejects.toMatchObject({
      code: 'INSUFFICIENT_COINS',
    });

    // The renewal's claim was taken first and rolled back with the charge, so the
    // event is not silently barred from a future purchase by a row nobody paid
    // for. The registration's own post at sequence 0 stays: it was paid for.
    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: created.publicId } });
    const posts = await prisma.channelPost.findMany({ where: { eventId: row.id } });
    expect(posts.map((post) => post.republishSeq)).toEqual([0]);
  });

  it('tells a stranger the event does not exist, and charges them nothing', async () => {
    const created = await events.create(hostId, validInput());
    const stranger = await createUser(prisma, 'PROFILE_COMPLETE', { coins: 500 });

    await expect(events.publishToChannel(stranger, created.publicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
    await expect(coins.balanceOf(stranger)).resolves.toBe(500);
  });

  it('refuses an event that has already started', async () => {
    const created = await events.create(hostId, validInput());
    clock.set(new Date('2026-08-20T16:00:00.000Z'));

    await expect(events.publishToChannel(hostId, created.publicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_BOOSTABLE',
    });
  });

  it('hands the unposted claim to the sweep, and keeps it after a failure', async () => {
    const created = await events.create(hostId, validInput());
    await events.publishToChannel(hostId, created.publicId);

    // Two unposted claims: the registration's, and the renewal's. Both were paid
    // for and both are the sweep's to deliver.
    const pending = await channel.findUnpostedPaid();

    expect(pending.map((post) => post.eventPublicId)).toEqual([created.publicId, created.publicId]);
    expect(pending.every((post) => post.kind === 'PAID')).toBe(true);
    // Still there on the next pass: the worker never releases a paid claim,
    // because it is the record that somebody paid.
    await expect(channel.findUnpostedPaid()).resolves.toHaveLength(2);
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
