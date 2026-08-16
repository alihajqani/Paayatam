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
const events = new EventService(service, clock, env, catalog, settings, moderation, audit);

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
      events.create(hostId, validInput({ cityId: fixture.karajId, districtId: undefined })),
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
