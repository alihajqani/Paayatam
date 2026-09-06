import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import { AppError } from '@payetam/shared';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { FoundingService } from '../founding/founding.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { FoundingAdminService } from './founding-admin.service';
import { ROLE_KEYS } from './permissions';

/**
 * The campaign report, against real rows (v0.10.1).
 *
 * The reason this needs a database rather than a unit test: every number it
 * produces is an aggregate over rows that only `FoundingService.award` knows how
 * to create, and the two facts most worth asserting — that the counts follow the
 * **snapshot** rather than today's settings, and that a city's members and its
 * waitlist come from one join — are both properties of the query, not of the
 * mapping around it.
 *
 * The fixture therefore allocates ranks through the real allocator inside a real
 * transaction. A test that inserted `founding_member` rows by hand would pass
 * over an allocator that had stopped working.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-09-06T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const coins = new CoinService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);

const founding = new FoundingService(service, settings, coins);
const admin = new FoundingAdminService(service, clock, access, settings);

function sessionFor(role: keyof typeof ROLE_KEYS): AdminSession {
  return {
    adminUserId: `admin-${role}`,
    email: `${role.toLowerCase()}@payetam.test`,
    displayName: role,
    roles: [ROLE_KEYS[role]],
    permissions: permissionsFor([ROLE_KEYS[role]]),
  };
}

const SUPER = sessionFor('SUPER_ADMIN');
const ANALYST = sessionFor('ANALYST');

let tehranId: string;
let shirazId: string;

/** A user with a completed profile in a city, optionally given a rank. */
async function member(cityId: string, withRank: boolean): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: `کاربر ${userId.slice(0, 4)}`, cityId, completedAt: NOW },
  });
  if (withRank) {
    await prisma.$transaction(async (tx) => {
      await founding.award(userId, tx);
    });
  }
  return userId;
}

beforeEach(async () => {
  await resetDatabase(prisma);

  // The campaign ships inert — `founding.enabled` defaults to 0 because a rank
  // is irreversible — so the fixture has to switch it on the way an operator
  // does, through `app_setting`.
  await prisma.appSetting.create({ data: { key: 'founding.enabled', value: 1 } });

  const [tehran, shiraz] = await Promise.all([
    prisma.city.create({
      data: { slug: 'tehran', nameFa: 'تهران', isActive: true, isLaunched: true },
    }),
    // Selectable but not open — the v0.10.0 split this report's waitlist reads.
    prisma.city.create({ data: { slug: 'shiraz', nameFa: 'شیراز', isActive: true } }),
  ]);
  tehranId = tehran.id;
  shirazId = shiraz.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('who may read what', () => {
  /**
   * ADR-0010's line, on the exact screen most likely to blur it: the aggregates
   * are what `ANALYST` exists for, and the roster is a list of named accounts.
   * One page, two disclosures, two permissions.
   */
  it('lets an ANALYST read the aggregates', async () => {
    const report = await admin.report(ANALYST);

    expect(report.max).toBe(1000);
  });

  it('refuses an ANALYST the roster, which names people', async () => {
    await expect(admin.members(ANALYST)).rejects.toBeInstanceOf(AppError);
  });
});

describe('the report', () => {
  it('counts the ranks the allocator actually handed out', async () => {
    await member(tehranId, true);
    await member(tehranId, true);

    const report = await admin.report(SUPER);

    expect(report.enabled).toBe(true);
    expect(report.awarded).toBe(2);
    expect(report.remaining).toBe(998);
    expect(report.joinedLast24h).toBe(2);
    // Tier 1 pays 150 by default, and both of these are ranks 1 and 2.
    expect(report.coinsGranted).toBe(300);
  });

  /**
   * The point of snapshotting. An operator retunes tier 1 mid campaign; the
   * members already paid keep the number they were given, and the report shows
   * the new configuration beside the old payment rather than rewriting history.
   */
  it('reports the paid coins from the snapshot, not from today’s settings', async () => {
    await member(tehranId, true);

    await prisma.appSetting.create({ data: { key: 'founding.tier1_coins', value: 5 } });
    const report = await admin.report(SUPER);

    const tier1 = report.tiers.find((row) => row.tier === 1);
    expect(tier1?.configuredCoins).toBe(5);
    expect(tier1?.coins).toBe(150);
    expect(report.coinsGranted).toBe(150);
  });

  /**
   * The two counts a city carries, and why they differ: a profile completed
   * while the campaign was off is in `profiles` and not in `members`. That gap
   * is the whole reason both are on the screen.
   */
  it('separates members from the profiles behind them', async () => {
    await member(tehranId, true);
    await member(tehranId, false);

    const report = await admin.report(SUPER);

    const tehran = report.cities.find((row) => row.slug === 'tehran');
    expect(tehran).toMatchObject({ members: 1, profiles: 2, isLaunched: true });
  });

  it('queues a closed city by how close it is, and leaves an open one out', async () => {
    await member(shirazId, true);
    await member(tehranId, true);

    const report = await admin.report(SUPER);

    expect(report.waitlist.threshold).toBe(100);
    expect(report.waitlist.cities).toEqual([{ slug: 'shiraz', nameFa: 'شیراز', profiles: 1 }]);
  });

  /**
   * Three counts, not a partition. Nobody here was referred and nobody redeemed
   * a code, so «هیچ‌کدام» carries all of them — the case that would look right
   * either way if `direct` were computed by subtraction.
   */
  it('reports acquisition as three independent counts', async () => {
    await member(tehranId, true);
    await member(tehranId, true);

    const report = await admin.report(SUPER);

    expect(report.sources).toEqual({ referred: 0, giftCode: 0, direct: 2 });
  });

  it('draws the daily curve oldest first', async () => {
    await member(tehranId, true);

    const report = await admin.report(SUPER);

    expect(report.trend).toEqual([{ day: '2026-09-06', members: 1, coins: 150 }]);
  });

  /** A campaign that has never run is a page of zeroes, not a failure. */
  it('answers with zeroes before anybody has joined', async () => {
    const report = await admin.report(SUPER);

    expect(report.awarded).toBe(0);
    expect(report.coinsGranted).toBe(0);
    expect(report.firstAwardedAt).toBeNull();
    expect(report.cities).toEqual([]);
    expect(report.trend).toEqual([]);
  });
});

describe('the roster', () => {
  it('lists members by rank, with the public id and never the internal one', async () => {
    const first = await member(tehranId, true);
    await member(shirazId, true);

    const page = await admin.members(SUPER);

    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(page.rows[0]?.cityNameFa).toBe('تهران');
    expect(page.rows[0]?.publicId).not.toBe(first);
    expect(JSON.stringify(page.rows)).not.toContain(first);
  });

  it('filters to one wave and still reports that wave’s total', async () => {
    await member(tehranId, true);
    // Rank 2 lands in tier 1 as well, so narrow tier 1 to a single seat first.
    await prisma.appSetting.create({ data: { key: 'founding.tier1_max_rank', value: 1 } });
    await member(tehranId, true);

    const page = await admin.members(SUPER, { tier: 2 });

    expect(page.total).toBe(1);
    expect(page.rows[0]?.rank).toBe(2);
  });
});
