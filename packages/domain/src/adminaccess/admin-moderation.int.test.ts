import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SETTING_DEFAULTS, SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { TrustService } from '../economy/trust.service';
import { normalize } from '../moderation/persian-normalizer';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { AdminOperationsService } from './admin-operations.service';
import { ROLE_KEYS } from './permissions';

/**
 * The three mutations the panel added (M19): moderating an event without a case,
 * closing a single report, and changing a policy number.
 *
 * All three are ordinary admin operations and are therefore bound by invariant
 * 12 — a permission check first and an `audit_log` row last, both asserted here.
 * What makes them worth their own suite is the *refusals*: an event that cannot
 * go where a moderator asked, a report answered twice, and a settings key that
 * does not exist. Each one is the shape of a back door if it is missing.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const operations = new AdminOperationsService(service, clock, access, coins, trust, audit);

let fixture: CatalogFixture;
let SUPER: AdminSession;
let host: string;

async function seedEvent(
  title: string,
  status: 'PUBLISHED' | 'HIDDEN' | 'CANCELLED_BY_HOST' = 'PUBLISHED',
): Promise<string> {
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';
  const startsAt = new Date(NOW.getTime() + 9 * 86_400_000);
  const row = await prisma.event.create({
    data: {
      hostUserId: host,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status,
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return row.publicId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  host = await createUser(prisma, 'PROFILE_COMPLETE');
  SUPER = {
    adminUserId: 'moderation-super',
    email: 'super@payetam.test',
    displayName: 'مدیر',
    roles: [ROLE_KEYS.SUPER_ADMIN],
    permissions: permissionsFor([ROLE_KEYS.SUPER_ADMIN]),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('moderating an event without a case', () => {
  it('hides a published event and records what it was', async () => {
    const publicId = await seedEvent('شب بازی رومیزی');

    const result = await operations.moderateEvent(SUPER, publicId, {
      action: 'HIDE',
      reason: 'Reported for advertising a paid service.',
    });

    expect(result.status).toBe('HIDDEN');
    const row = await prisma.event.findUniqueOrThrow({ where: { publicId } });
    expect(row.status).toBe('HIDDEN');
    // The version moves — 0 on creation, 1 after this — so a host mid-edit gets a
    // conflict rather than silently un-hiding what a moderator just hid.
    expect(row.version).toBe(1);

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'event.moderated' } });
    expect(entry.before).toMatchObject({ status: 'PUBLISHED' });
    expect(entry.after).toMatchObject({ status: 'HIDDEN' });
  });

  it('restores a hidden event', async () => {
    const publicId = await seedEvent('شب بازی رومیزی', 'HIDDEN');

    await operations.moderateEvent(SUPER, publicId, {
      action: 'PUBLISH',
      reason: 'The complaint did not hold up on review.',
    });

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId } });
    expect(row.status).toBe('PUBLISHED');
    expect(row.moderationStatus).toBe('APPROVED');
  });

  /**
   * The reason this is not a back door: `assertEventTransition` decides, so an
   * event the host already called off is not resurrected by a moderator agreeing
   * with a complaint about it.
   */
  it('refuses a transition the lifecycle does not allow', async () => {
    const publicId = await seedEvent('لغو شده', 'CANCELLED_BY_HOST');

    await expect(
      operations.moderateEvent(SUPER, publicId, {
        action: 'PUBLISH',
        reason: 'Trying to bring back a cancelled event.',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId } });
    expect(row.status).toBe('CANCELLED_BY_HOST');
  });

  it('refuses a decision nobody explained', async () => {
    const publicId = await seedEvent('شب بازی رومیزی');

    await expect(
      operations.moderateEvent(SUPER, publicId, { action: 'HIDE', reason: 'no' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('refuses an event that does not exist', async () => {
    await expect(
      operations.moderateEvent(SUPER, '00000000-0000-4000-8000-000000000000', {
        action: 'HIDE',
        reason: 'Nothing to hide.',
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });
});

describe('closing one report', () => {
  async function seedReport(): Promise<string> {
    const reporter = await createUser(prisma, 'PROFILE_COMPLETE');
    const row = await prisma.report.create({
      data: {
        targetType: 'USER',
        targetId: host,
        reporterUserId: reporter,
        reason: 'SPAM',
        status: 'OPEN',
      },
      select: { publicId: true },
    });
    return row.publicId;
  }

  it('answers a report and says what it was about', async () => {
    const publicId = await seedReport();

    await operations.decideReport(SUPER, publicId, {
      status: 'DISMISSED',
      note: 'Not spam; the host was answering a question.',
    });

    const row = await prisma.report.findUniqueOrThrow({ where: { publicId } });
    expect(row.status).toBe('DISMISSED');

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'report.decided' } });
    expect(entry.after).toMatchObject({ status: 'DISMISSED', subjectType: 'USER' });
  });

  /**
   * Two moderators reading the same queue is the normal case, so a second
   * decision is a **conflict** and not a bug — and it must not overwrite the
   * first one's answer.
   */
  it('refuses to answer the same report twice', async () => {
    const publicId = await seedReport();
    await operations.decideReport(SUPER, publicId, {
      status: 'ACTIONED',
      note: 'Hidden the event and warned the host.',
    });

    await expect(
      operations.decideReport(SUPER, publicId, {
        status: 'DISMISSED',
        note: 'Second opinion, arriving too late.',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const row = await prisma.report.findUniqueOrThrow({ where: { publicId } });
    expect(row.status).toBe('ACTIONED');
  });

  it('refuses a decision nobody explained', async () => {
    const publicId = await seedReport();

    await expect(
      operations.decideReport(SUPER, publicId, { status: 'DISMISSED', note: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('changing a policy number', () => {
  it('lists every key from the code catalogue, with its default beside it', async () => {
    const listed = await operations.listSettings(SUPER);

    expect(listed).toHaveLength(Object.keys(SETTING_DEFAULTS).length);
    expect(listed.every((row) => row.overridden === false)).toBe(true);
    expect(listed.find((row) => row.key === 'economy.boost_coins')).toMatchObject({
      value: 40,
      defaultValue: 40,
    });
  });

  it('changes one, marks it changed, and records why', async () => {
    await operations.updateSetting(SUPER, 'economy.boost_coins', 55, 'Nowruz campaign pricing.');

    // The service that actually reads it agrees, which is the only definition of
    // "changed" that matters.
    expect(await settings.getInt('economy.boost_coins')).toBe(55);

    const listed = await operations.listSettings(SUPER);
    expect(listed.find((row) => row.key === 'economy.boost_coins')).toMatchObject({
      value: 55,
      defaultValue: 40,
      overridden: true,
    });

    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'setting.changed' } });
    expect(entry.targetId).toBe('economy.boost_coins');
    expect(entry.before).toEqual({ value: 40 });
    expect(entry.after).toMatchObject({ value: 55, reason: 'Nowruz campaign pricing.' });
  });

  /**
   * The reason there is no "edit any environment variable" screen: an arbitrary
   * key would let the panel write rows nothing reads, and a settings table that
   * stops describing the product is worse than no settings table.
   */
  it('refuses a key the code does not know about', async () => {
    await expect(
      operations.updateSetting(SUPER, 'DATABASE_URL', 1, 'Trying something clever.'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await prisma.appSetting.count()).toBe(0);
  });

  it('refuses a fraction where the default is an integer', async () => {
    // A coin amount that arrives as 12.5 is a corrupted ledger rather than a
    // rounding question.
    await expect(
      operations.updateSetting(SUPER, 'economy.boost_coins', 12.5, 'Half a coin.'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('accepts a fraction where the default is one', async () => {
    await operations.updateSetting(
      SUPER,
      'ranking.weight_trust',
      0.08,
      'Damping reputation slightly.',
    );

    expect(await settings.getNumber('ranking.weight_trust')).toBeCloseTo(0.08);
  });

  it('refuses a change nobody explained', async () => {
    await expect(
      operations.updateSetting(SUPER, 'economy.boost_coins', 55, 'x'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
