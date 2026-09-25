import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
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
import type { Acquisition } from '../identity/acquisition';
import { UserService } from '../identity/user.service';
import { AcquisitionReportService } from './acquisition-report.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { ROLE_KEYS } from './permissions';

/**
 * The acquisition report, against real rows (migration 0061).
 *
 * A database rather than a unit test because everything worth asserting is a
 * property of the one query: that accounts without attribution are still
 * counted, that campaign rows split by tag while event links do not, and that
 * each funnel column counts *people* rather than rows — a user with two
 * requests is one person who asked.
 *
 * Accounts are created through `UserService.findOrCreateByTelegram`, the path
 * `/start` takes, so the fixture exercises the INSERT that writes attribution
 * rather than inserting `user_acquisition` rows by hand.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date();
const clock = new FakeClock(NOW);

const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const users = new UserService(service, clock);
const report = new AcquisitionReportService(service, clock, access, {
  TELEGRAM_BOT_USERNAME: 'test_bot',
} as Env);

const ANALYST: AdminSession = {
  adminUserId: 'admin-analyst',
  email: 'analyst@payetam.test',
  displayName: 'ANALYST',
  roles: [ROLE_KEYS.ANALYST],
  permissions: permissionsFor([ROLE_KEYS.ANALYST]),
};

let fixture: CatalogFixture;
let telegramId = 900_000_000n;

/** A new account, the way `/start` makes one. Returns the internal id. */
async function arrive(
  acquisition: Acquisition,
  onboardingState: 'NEW' | 'TERMS_ACCEPTED' | 'PROFILE_COMPLETE' = 'NEW',
): Promise<string> {
  telegramId += 1n;
  const created = await users.findOrCreateByTelegram(
    { telegramUserId: telegramId, firstName: 'کاربر' },
    acquisition,
  );
  const id = await users.resolveInternalId(created.publicId);
  if (onboardingState !== 'NEW') {
    await prisma.user.update({ where: { id }, data: { onboardingState } });
  }
  return id;
}

async function hostEvent(hostUserId: string, isSeeded = false): Promise<string> {
  const startsAt = new Date(NOW.getTime() - 2 * 86_400_000);
  const event = await prisma.event.create({
    data: {
      hostUserId,
      title: 'دورهمی',
      description: 'یک شب بازی.',
      titleNormalized: 'دورهمی',
      descriptionNormalized: 'یک شب بازی',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: startsAt,
      isSeeded,
    },
    select: { id: true },
  });
  return event.id;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the acquisition report', () => {
  it('lets an ANALYST read it, because it is aggregates', async () => {
    const result = await report.report(ANALYST);

    expect(result.totals.users).toBe(0);
    expect(result.botUsername).toBe('test_bot');
  });

  it('splits campaigns by tag and reports every other source whole', async () => {
    await arrive({ source: 'CAMPAIGN', ref: 'tgads_a' });
    await arrive({ source: 'CAMPAIGN', ref: 'tgads_a' });
    await arrive({ source: 'CAMPAIGN', ref: 'tgads_b' });
    await arrive({ source: 'EVENT_LINK', ref: '11111111-1111-4111-8111-111111111111' });
    await arrive({ source: 'EVENT_LINK', ref: '22222222-2222-4222-8222-222222222222' });
    await arrive({ source: 'DIRECT', ref: null });

    const result = await report.report(ANALYST);

    expect(result.rows.map((row) => [row.source, row.ref, row.users])).toEqual([
      ['CAMPAIGN', 'tgads_a', 2],
      // Two events, one row: a row per event is the events screen's job.
      ['EVENT_LINK', null, 2],
      ['CAMPAIGN', 'tgads_b', 1],
      ['DIRECT', null, 1],
    ]);
    expect(result.totals.users).toBe(6);
  });

  /**
   * A total that disagreed with the dashboard's user count would make the whole
   * report suspect, so the accounts from before attribution are a row, and seed
   * accounts — which nobody acquired — are not.
   */
  it('counts accounts from before tracking as their own row, and never a seed account', async () => {
    await arrive({ source: 'DIRECT', ref: null });
    await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.user.create({ data: { isSeed: true } });

    const result = await report.report(ANALYST);

    expect(result.rows).toContainEqual(
      expect.objectContaining({ source: null, ref: null, users: 1, profileComplete: 1 }),
    );
    expect(result.totals.users).toBe(2);
  });

  it('follows the same people down the funnel, counting each person once', async () => {
    const stayed = await arrive({ source: 'CAMPAIGN', ref: 'tgads_a' }, 'PROFILE_COMPLETE');
    await arrive({ source: 'CAMPAIGN', ref: 'tgads_a' }, 'TERMS_ACCEPTED');
    const left = await arrive({ source: 'CAMPAIGN', ref: 'tgads_a' });
    await prisma.telegramAccount.update({ where: { userId: left }, data: { botBlocked: true } });

    const host = await arrive({ source: 'DIRECT', ref: null }, 'PROFILE_COMPLETE');
    const [first, second] = [await hostEvent(host), await hostEvent(host)];
    // Two participations, one of them attended: one person who asked, one who came.
    await prisma.eventParticipant.createMany({
      data: [
        { eventId: first, userId: stayed, status: 'COMPLETED', acceptedAt: NOW },
        { eventId: second, userId: stayed, status: 'PENDING' },
      ],
    });

    const result = await report.report(ANALYST);
    const campaign = result.rows.find((row) => row.ref === 'tgads_a');
    const direct = result.rows.find((row) => row.source === 'DIRECT');

    expect(campaign).toEqual({
      source: 'CAMPAIGN',
      ref: 'tgads_a',
      users: 3,
      termsAccepted: 2,
      profileComplete: 1,
      requested: 1,
      attended: 1,
      hosted: 0,
      botBlocked: 1,
    });
    expect(direct?.hosted).toBe(1);
  });

  it('does not count a seeded event as hosting', async () => {
    const host = await arrive({ source: 'DIRECT', ref: null }, 'PROFILE_COMPLETE');
    await hostEvent(host, true);

    const result = await report.report(ANALYST);

    expect(result.totals.hosted).toBe(0);
  });

  it('narrows to accounts created inside the window', async () => {
    await arrive({ source: 'CAMPAIGN', ref: 'recent' });
    const old = await arrive({ source: 'CAMPAIGN', ref: 'old' });
    await prisma.user.update({
      where: { id: old },
      data: { createdAt: new Date(NOW.getTime() - 60 * 86_400_000) },
    });

    const lastMonth = await report.report(ANALYST, 30);
    const allTime = await report.report(ANALYST);

    expect(lastMonth.rows.map((row) => row.ref)).toEqual(['recent']);
    expect(lastMonth.windowDays).toBe(30);
    expect(allTime.rows.map((row) => row.ref).sort()).toEqual(['old', 'recent']);
    expect(allTime.windowDays).toBeNull();
  });

  /** First touch: the next link an existing account taps changes nothing. */
  it('never re-attributes an account that already exists', async () => {
    telegramId += 1n;
    const telegramUser = { telegramUserId: telegramId, firstName: 'کاربر' };
    await users.findOrCreateByTelegram(telegramUser, { source: 'DIRECT', ref: null });
    await users.findOrCreateByTelegram(telegramUser, { source: 'CAMPAIGN', ref: 'later' });

    const rows = await prisma.userAcquisition.findMany({ select: { source: true, ref: true } });

    expect(rows).toEqual([{ source: 'DIRECT', ref: null }]);
  });

  /** The CHECK that lets the report group on `ref` without asking whether a row is malformed. */
  it('refuses a campaign row the report could not group', async () => {
    const userId = await createUser(prisma);

    await expect(
      prisma.userAcquisition.create({ data: { userId, source: 'CAMPAIGN', ref: 'Upper' } }),
    ).rejects.toThrow();
    await expect(
      prisma.userAcquisition.create({ data: { userId, source: 'DIRECT', ref: 'something' } }),
    ).rejects.toThrow();
  });
});
