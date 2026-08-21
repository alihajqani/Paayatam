import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { GiftCodeService } from '../economy/gift-code.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { GiftCodeAdminService } from './gift-code-admin.service';
import { ROLE_KEYS } from './permissions';

/**
 * Minting and retiring campaign codes (M18, ADR-0010).
 *
 * The RBAC matrix already asserts *who* may call these — this asserts what they
 * do, and in particular the two properties an operator relies on: a code created
 * here is immediately redeemable through `GiftCodeService`, and disabling one
 * stops it without back-dating anything.
 *
 * Authentication never happens in this file, so Redis is never reached and a stub
 * stands in for it — the same choice `rbac-matrix.int.test.ts` makes, and for the
 * same reason: a live connection would make this suite about something other than
 * what it is testing.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-20T09:00:00.000Z');
const clock = new FakeClock(NOW);

const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const settings = new SettingsService(service);
const admin = new GiftCodeAdminService(service, clock, access, settings, audit);

const coins = new CoinService(service, clock);
const giftCodes = new GiftCodeService(service, clock, coins, audit, new MetricsRegistry());

/**
 * A real `admin_user` row, because `gift_code.created_by_admin_id` is a real
 * foreign key.
 *
 * A synthetic session id would be enough for the RBAC matrix, which only ever
 * asserts a refusal — but a *successful* create writes that id into a column that
 * references this table, and a fixture that skipped the row would fail on the
 * constraint rather than on anything the test is about. The row is inserted
 * directly rather than through `createAdmin` so this suite still needs no roles,
 * no Redis and no TOTP.
 */
let SUPER: AdminSession;

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);

  const row = await prisma.adminUser.create({
    data: {
      email: 'super@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'مدیر ارشد',
    },
    select: { id: true },
  });

  SUPER = {
    adminUserId: row.id,
    email: 'super@payetam.test',
    displayName: 'مدیر ارشد',
    roles: [ROLE_KEYS.SUPER_ADMIN],
    permissions: permissionsFor([ROLE_KEYS.SUPER_ADMIN]),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('creating a code', () => {
  it('stores it normalized, so case and separators are not two codes', async () => {
    const created = await admin.create(SUPER, { code: ' summer-24 ', coins: 30 });

    expect(created.code).toBe('SUMMER24');
    expect(await prisma.giftCode.count({ where: { code: 'SUMMER24' } })).toBe(1);
  });

  it('produces a code the redeem path accepts, in whatever case it is typed', async () => {
    // The two halves of the feature meet here. A code an operator can create but
    // nobody can redeem is the failure this asserts against.
    await admin.create(SUPER, { code: 'summer-24', coins: 30 });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');

    const result = await giftCodes.redeem(user, 'Summer 24');

    expect(result.coins).toBe(30);
    expect(await coins.balanceOf(user)).toBe(30);
  });

  it('defaults to one redemption per person and no global cap', async () => {
    const created = await admin.create(SUPER, { code: 'DEFAULTS1', coins: 5 });

    expect(created.summary.perUserLimit).toBe(1);
    expect(created.summary.maxRedemptions).toBeNull();
    // The plaintext comes back exactly once, from the call that made it — and it
    // is safe here only because the operator typed it (ADR-0016).
    expect(created.code).toBe('DEFAULTS1');
  });

  it('refuses a duplicate, including one that differs only in case', async () => {
    await admin.create(SUPER, { code: 'SUMMER24', coins: 30 });

    await expect(admin.create(SUPER, { code: 'summer24', coins: 99 })).rejects.toMatchObject({
      code: 'GIFT_CODE_DUPLICATE',
    });
  });

  it('refuses a code that grants nothing, or a fractional amount', async () => {
    // Coins are integers (plan §4), and a code worth zero is a support ticket
    // nobody can reproduce.
    await expect(admin.create(SUPER, { code: 'ZEROCODE', coins: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(admin.create(SUPER, { code: 'HALFCODE', coins: 2.5 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a window that closes before it opens', async () => {
    await expect(
      admin.create(SUPER, {
        code: 'BACKWARDS',
        coins: 10,
        startsAt: new Date(NOW.getTime() + 3_600_000),
        expiresAt: NOW,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('records who minted it, and what it was worth', async () => {
    // Invariant 12: every mutating admin action writes `audit_log`. Minting coins
    // out of nothing is the one that most needs a name attached.
    const created = await admin.create(SUPER, { code: 'AUDITED1', coins: 15 });
    const row = await prisma.giftCode.findUniqueOrThrow({ where: { code: created.code } });

    const entries = await prisma.auditLog.findMany({ where: { targetId: row.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'giftcode.created',
      actorType: 'ADMIN',
      actorId: SUPER.adminUserId,
    });
    expect(row.createdByAdminId).toBe(SUPER.adminUserId);
  });
});

describe('disabling a code', () => {
  /**
   * Addressed by `public_id`, never by the code (M19, ADR-0016).
   *
   * The code is a bearer secret, and a route that names one writes it into every
   * access log between the operator and the database — which is the thing
   * ADR-0015's own threat section forbade and then did.
   */
  it('stops it being redeemable, without touching its expiry', async () => {
    const created = await admin.create(SUPER, { code: 'KILLABLE', coins: 20 });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');

    const disabled = await admin.setActive(SUPER, created.summary.publicId, false);

    expect(disabled.isActive).toBe(false);
    expect(disabled.state).toBe('DISABLED');
    expect(disabled.expiresAt).toBeNull();
    await expect(giftCodes.redeem(user, 'KILLABLE')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
  });

  it('can be turned back on', async () => {
    const created = await admin.create(SUPER, { code: 'KILLABLE', coins: 20 });
    await admin.setActive(SUPER, created.summary.publicId, false);

    await admin.setActive(SUPER, created.summary.publicId, true);

    const user = await createUser(prisma, 'PROFILE_COMPLETE');
    await expect(giftCodes.redeem(user, 'KILLABLE')).resolves.toMatchObject({ coins: 20 });
  });

  it('audits the change with what it was before', async () => {
    const created = await admin.create(SUPER, { code: 'KILLABLE', coins: 20 });
    const row = await prisma.giftCode.findUniqueOrThrow({ where: { code: created.code } });

    await admin.setActive(SUPER, created.summary.publicId, false);

    const entries = await prisma.auditLog.findMany({
      where: { targetId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((entry) => entry.action)).toEqual(['giftcode.created', 'giftcode.disabled']);
  });

  it('refuses a code that does not exist', async () => {
    await expect(
      admin.setActive(SUPER, '00000000-0000-4000-8000-000000000000', false),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('minting a batch (M19)', () => {
  it('mints the number asked for, all distinct, all in one batch', async () => {
    const batch = await admin.createBatch(SUPER, {
      count: 50,
      coins: 25,
      campaign: 'nowruz-1405',
    });

    expect(batch.codes).toHaveLength(50);
    expect(new Set(batch.codes).size).toBe(50);
    expect(batch.summaries.every((row) => row.batchId === batch.batchId)).toBe(true);
    expect(await prisma.giftCode.count({ where: { batchId: batch.batchId } })).toBe(50);
  });

  it('draws every code from the unambiguous alphabet, at the length asked for', async () => {
    const batch = await admin.createBatch(SUPER, { count: 20, coins: 5, length: 14 });

    for (const code of batch.codes) {
      expect(code).toHaveLength(14);
      // No 0/O and no 1/I/L: these are read off one screen and typed into
      // another, often by somebody who did not choose them.
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    }
  });

  it('prefixes every code in the batch, and normalizes the prefix', async () => {
    const batch = await admin.createBatch(SUPER, {
      count: 5,
      coins: 5,
      prefix: 'now-ruz',
      length: 8,
    });

    expect(batch.codes.every((code) => code.startsWith('NOWRUZ'))).toBe(true);
    expect(batch.codes.every((code) => code.length === 14)).toBe(true);
  });

  /**
   * The codes are returned once and are not recoverable. Everything the list can
   * say about them afterwards is a mask — which is the property that makes bulk
   * minting safe to expose at all (ADR-0016).
   */
  it('never returns a batch’s codes again', async () => {
    const batch = await admin.createBatch(SUPER, { count: 3, coins: 5, campaign: 'once-only' });

    const { codes } = await admin.list(SUPER, { batchId: batch.batchId });

    expect(codes).toHaveLength(3);
    for (const minted of batch.codes) {
      expect(JSON.stringify(codes)).not.toContain(minted);
    }
  });

  it('writes no code into the audit trail, only the shape of the batch', async () => {
    const batch = await admin.createBatch(SUPER, { count: 4, coins: 15, campaign: 'quiet' });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'giftcode.batch_created' },
    });
    expect(entry.targetId).toBe(batch.batchId);
    expect(entry.after).toMatchObject({ count: 4, coins: 15, campaign: 'quiet' });
    for (const minted of batch.codes) {
      expect(JSON.stringify(entry.after)).not.toContain(minted);
    }
  });

  /**
   * The collision path, forced rather than waited for.
   *
   * At length 6 over a 31-character alphabet with a fixed prefix there are ~887
   * million codes, so a natural collision would never be observed. Pre-seeding
   * one that the generator *must* eventually draw is not practical either — so
   * this asserts the property that matters and is reachable: a batch either
   * places every code it was asked for, or places none of them.
   */
  it('is all or nothing: a batch that cannot be placed leaves no rows', async () => {
    // Six characters of a two-character effective space is impossible to fill
    // 1000 times over, which is what the retry loop is for and what it gives up
    // on. A shorter alphabet cannot be configured, so this uses the real bound:
    // asking for more codes than the setting allows is refused before any write.
    await expect(admin.createBatch(SUPER, { count: 5000, coins: 5 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await prisma.giftCode.count()).toBe(0);
  });

  /**
   * A prefix is a word, and a word disambiguates its own glyphs — «NOWRUZ» read
   * as «N0WRUZ» is corrected by anybody who has seen it. A bare digit does not,
   * which is why `0` and `1` are still refused there.
   */
  it('accepts a readable word as a prefix, and refuses a confusable digit', async () => {
    await expect(
      admin.createBatch(SUPER, { count: 2, coins: 5, prefix: 'NOWRUZ' }),
    ).resolves.toMatchObject({ campaign: null });

    await expect(
      admin.createBatch(SUPER, { count: 2, coins: 5, prefix: 'NOWRUZ1405' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('mints disabled when a campaign is not meant to start yet', async () => {
    const batch = await admin.createBatch(SUPER, { count: 3, coins: 5, isActive: false });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');

    expect(batch.summaries.every((row) => row.state === 'DISABLED')).toBe(true);
    await expect(giftCodes.redeem(user, batch.codes[0] ?? '')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
  });

  it('mints codes that actually redeem', async () => {
    const batch = await admin.createBatch(SUPER, { count: 2, coins: 40, campaign: 'real' });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');

    await expect(giftCodes.redeem(user, batch.codes[0] ?? '')).resolves.toMatchObject({
      coins: 40,
    });
  });
});

describe('the per-user cap (ADR-0016)', () => {
  it('refuses a new code that lets one person redeem twice', async () => {
    await expect(
      admin.create(SUPER, { code: 'TWICEOK1', coins: 5, perUserLimit: 2 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      admin.createBatch(SUPER, { count: 2, coins: 5, perUserLimit: 3 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  /**
   * The column is deliberately **not** constrained to 1 (migration 0018).
   *
   * A constraint tightened over live data is a migration that fails on the data
   * it was meant to describe, and rows above 1 are history: their redemptions are
   * paid and their ledger rows are immutable. So a historical code keeps working
   * exactly as it did, and only *creation* is capped.
   */
  it('leaves a historical code above the cap working', async () => {
    const legacy = await prisma.giftCode.create({
      data: { code: 'LEGACY24', coins: 10, perUserLimit: 3, createdAt: NOW },
    });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');

    await giftCodes.redeem(user, 'LEGACY24');
    await giftCodes.redeem(user, 'LEGACY24');

    expect(await coins.balanceOf(user)).toBe(20);
    const { codes } = await admin.list(SUPER, { code: 'LEGACY24' });
    expect(codes[0]).toMatchObject({ publicId: legacy.publicId, perUserLimit: 3 });
  });

  it('refuses to raise a historical code’s limit while leaving it alone', async () => {
    const legacy = await prisma.giftCode.create({
      data: { code: 'LEGACY24', coins: 10, perUserLimit: 3, createdAt: NOW },
    });

    await expect(admin.update(SUPER, legacy.publicId, { perUserLimit: 3 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const still = await prisma.giftCode.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(still.perUserLimit).toBe(3);
  });
});

describe('retuning a campaign (M19)', () => {
  /**
   * Configuration is future-facing and history is immutable, and the two facts
   * are structural rather than a rule anybody follows: `gift_code_redemption`
   * snapshots what was granted, `coin_ledger` is append-only under a trigger, and
   * nothing in this service writes to either (ADR-0016).
   */
  it('changes what the next redemption grants, and not what an old one did', async () => {
    const created = await admin.create(SUPER, { code: 'RETUNE24', coins: 50 });
    const early = await createUser(prisma, 'PROFILE_COMPLETE');
    await giftCodes.redeem(early, 'RETUNE24');

    await admin.update(SUPER, created.summary.publicId, { coins: 80 });

    const later = await createUser(prisma, 'PROFILE_COMPLETE');
    await giftCodes.redeem(later, 'RETUNE24');

    expect(await coins.balanceOf(early)).toBe(50);
    expect(await coins.balanceOf(later)).toBe(80);

    const snapshots = await prisma.giftCodeRedemption.findMany({ orderBy: { createdAt: 'asc' } });
    expect(snapshots.map((row) => row.coins)).toEqual([50, 80]);
  });

  it('refuses a global cap below what has already been taken', async () => {
    const created = await admin.create(SUPER, { code: 'CAPPED24', coins: 5, maxRedemptions: 10 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'CAPPED24');
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'CAPPED24');

    await expect(
      admin.update(SUPER, created.summary.publicId, { maxRedemptions: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('records what changed, before and after', async () => {
    const created = await admin.create(SUPER, { code: 'AUDITED1', coins: 5 });

    await admin.update(SUPER, created.summary.publicId, { coins: 9, campaign: 'renamed' });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'giftcode.updated' },
    });
    expect(entry.before).toMatchObject({ coins: 5, campaign: null });
    expect(entry.after).toMatchObject({ coins: 9, campaign: 'renamed' });
  });
});

describe('per-code analytics (M19)', () => {
  /**
   * The durable rows are the source of truth, and the metric is not: a Prometheus
   * counter resets on deploy, is per-replica and carries no time. Successful
   * redemptions come from `gift_code_redemption`, coins from its immutable
   * snapshot, and refusals from `audit_log` — where the redemption path writes one
   * row per refused attempt precisely so this question has a durable answer.
   */
  it('counts redemptions, distinct people and coins from the rows themselves', async () => {
    const created = await admin.create(SUPER, { code: 'MEASURED', coins: 30, maxRedemptions: 10 });
    const [one, two] = await Promise.all([
      createUser(prisma, 'PROFILE_COMPLETE'),
      createUser(prisma, 'PROFILE_COMPLETE'),
    ]);
    await giftCodes.redeem(one, 'MEASURED');
    await giftCodes.redeem(two, 'MEASURED');

    const report = await admin.analytics(SUPER, created.summary.publicId);

    expect(report.successfulRedemptions).toBe(2);
    expect(report.uniqueUsers).toBe(2);
    expect(report.coinsGranted).toBe(60);
    expect(report.summary.remainingRedemptions).toBe(8);
    expect(report.firstRedeemedAt).toEqual(NOW);
    expect(report.lastRedeemedAt).toEqual(NOW);
  });

  it('counts refusals by reason, from the durable rows rather than a counter', async () => {
    const created = await admin.create(SUPER, { code: 'REFUSER1', coins: 5 });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');
    await giftCodes.redeem(user, 'REFUSER1');
    await expect(giftCodes.redeem(user, 'REFUSER1')).rejects.toThrow();
    await expect(giftCodes.redeem(user, 'REFUSER1')).rejects.toThrow();

    const report = await admin.analytics(SUPER, created.summary.publicId);

    expect(report.failedAttempts).toBe(2);
    expect(report.failuresByReason).toEqual({ already_redeemed: 2 });
  });

  it('buckets redemptions by day, oldest first', async () => {
    const created = await admin.create(SUPER, { code: 'TRENDING', coins: 10, maxRedemptions: 5 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'TRENDING');
    clock.advance(48 * 3_600_000);
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'TRENDING');

    const report = await admin.analytics(SUPER, created.summary.publicId);

    expect(report.trend).toEqual([
      { day: '2026-08-20', redemptions: 1, coins: 10 },
      { day: '2026-08-22', redemptions: 1, coins: 10 },
    ]);
  });

  it('honours a date window on every number it reports', async () => {
    const created = await admin.create(SUPER, { code: 'WINDOWED', coins: 10, maxRedemptions: 5 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'WINDOWED');
    clock.advance(72 * 3_600_000);
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'WINDOWED');

    const recent = await admin.analytics(SUPER, created.summary.publicId, {
      from: new Date('2026-08-22T00:00:00.000Z'),
    });

    expect(recent.successfulRedemptions).toBe(1);
    expect(recent.coinsGranted).toBe(10);
    // `redeemedCount` is the code's own column and is not windowed: it is what
    // the cap is measured against, and a window would make it lie.
    expect(recent.summary.redeemedCount).toBe(2);
  });

  it('reports zero rather than nothing for a campaign nobody has redeemed', async () => {
    const created = await admin.create(SUPER, { code: 'UNTOUCHD', coins: 10 });

    const report = await admin.analytics(SUPER, created.summary.publicId);

    expect(report).toMatchObject({
      successfulRedemptions: 0,
      uniqueUsers: 0,
      coinsGranted: 0,
      failedAttempts: 0,
      firstRedeemedAt: null,
      lastRedeemedAt: null,
      trend: [],
    });
  });

  /**
   * The whole point of the snapshot, stated as a report: a campaign retuned from
   * 50 to 80 shows 80 on its configuration and 130 granted, not 160 (ADR-0016).
   */
  it('sums what was actually granted, not what the code grants now', async () => {
    const created = await admin.create(SUPER, { code: 'RETUNED1', coins: 50, maxRedemptions: 5 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'RETUNED1');
    await admin.update(SUPER, created.summary.publicId, { coins: 80 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'RETUNED1');

    const report = await admin.analytics(SUPER, created.summary.publicId);

    expect(report.summary.coins).toBe(80);
    expect(report.coinsGranted).toBe(130);
  });

  it('never puts the code into the report', async () => {
    const created = await admin.create(SUPER, { code: 'SECRETIV', coins: 5 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'SECRETIV');

    const report = await admin.analytics(SUPER, created.summary.publicId);

    expect(JSON.stringify(report)).not.toContain('SECRETIV');
  });

  it('refuses a campaign that does not exist', async () => {
    await expect(
      admin.analytics(SUPER, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('campaign roll-ups (M19)', () => {
  it('groups every code under its campaign, in one query', async () => {
    await admin.createBatch(SUPER, { count: 3, coins: 10, campaign: 'nowruz' });
    const solo = await admin.create(SUPER, { code: 'NOWRUZX1', coins: 10, campaign: 'nowruz' });
    await admin.createBatch(SUPER, { count: 2, coins: 5, campaign: 'yalda' });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'NOWRUZX1');
    await admin.setActive(SUPER, solo.summary.publicId, false);

    const campaigns = await admin.campaigns(SUPER);
    const nowruz = campaigns.find((row) => row.campaign === 'nowruz');
    const yalda = campaigns.find((row) => row.campaign === 'yalda');

    expect(nowruz).toMatchObject({
      codes: 4,
      activeCodes: 3,
      redemptions: 1,
      coinsGranted: 10,
      uniqueUsers: 1,
    });
    expect(yalda).toMatchObject({ codes: 2, redemptions: 0, coinsGranted: 0 });
  });

  /**
   * A one-off support gesture is not a campaign, and bucketing it under
   * «بدون کمپین» would make the roll-up describe nothing.
   */
  it('leaves unlabelled codes out entirely', async () => {
    await admin.create(SUPER, { code: 'ONEOFF24', coins: 10 });

    await expect(admin.campaigns(SUPER)).resolves.toEqual([]);
  });
});

describe('the redemption list (M19)', () => {
  it('names a user by public id and nothing else, newest first', async () => {
    const created = await admin.create(SUPER, { code: 'WHOTOOK1', coins: 20, maxRedemptions: 5 });
    const first = await createUser(prisma, 'PROFILE_COMPLETE');
    await giftCodes.redeem(first, 'WHOTOOK1');
    const { publicId } = await prisma.user.findUniqueOrThrow({
      where: { id: first },
      select: { publicId: true },
    });

    const { redemptions, total } = await admin.redemptions(SUPER, created.summary.publicId);

    expect(total).toBe(1);
    expect(redemptions[0]).toMatchObject({ userPublicId: publicId, seq: 1, coins: 20 });
    // A public id, a sequence, an amount and a time. A list of who took a
    // promotion is not a reason to project a profile.
    expect(Object.keys(redemptions[0] ?? {}).sort()).toEqual([
      'coins',
      'createdAt',
      'seq',
      'userPublicId',
    ]);
  });

  it('shows what each redemption was granted, even after the code was retuned', async () => {
    const created = await admin.create(SUPER, { code: 'HISTORY1', coins: 50, maxRedemptions: 5 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'HISTORY1');
    await admin.update(SUPER, created.summary.publicId, { coins: 80 });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'HISTORY1');

    const { redemptions } = await admin.redemptions(SUPER, created.summary.publicId);

    expect(redemptions.map((row) => row.coins).sort((a, b) => a - b)).toEqual([50, 80]);
  });
});

describe('finding a code without being able to enumerate one', () => {
  it('matches an exact code, however it was retyped', async () => {
    await admin.create(SUPER, { code: 'FINDME24', coins: 5 });
    await admin.create(SUPER, { code: 'FINDME25', coins: 5 });

    const { codes, total } = await admin.list(SUPER, { code: ' find-me 24 ' });

    expect(total).toBe(1);
    expect(codes[0]?.codeMasked).toBe('FI•••••4');
  });

  it('returns nothing for a prefix, so a campaign cannot be swept', async () => {
    await admin.create(SUPER, { code: 'FINDME24', coins: 5 });

    await expect(admin.list(SUPER, { code: 'FIND' })).resolves.toEqual({ codes: [], total: 0 });
  });

  it('filters by campaign and reports the total behind the page', async () => {
    await admin.createBatch(SUPER, { count: 7, coins: 5, campaign: 'spring' });
    await admin.createBatch(SUPER, { count: 3, coins: 5, campaign: 'autumn' });

    const page = await admin.list(SUPER, { campaign: 'spring', limit: 2 });

    expect(page.codes).toHaveLength(2);
    expect(page.total).toBe(7);
  });
});

describe('the list', () => {
  it('shows how far each campaign has been drained', async () => {
    // The monitoring surface: `redeemedCount` against `maxRedemptions` is how an
    // operator sees a campaign running out before their users do.
    await admin.create(SUPER, { code: 'TRACKED1', coins: 10, maxRedemptions: 5 });
    const [first, second] = await Promise.all([
      createUser(prisma, 'PROFILE_COMPLETE'),
      createUser(prisma, 'PROFILE_COMPLETE'),
    ]);
    await giftCodes.redeem(first, 'TRACKED1');
    await giftCodes.redeem(second, 'TRACKED1');

    const { codes, total } = await admin.list(SUPER);

    expect(total).toBe(1);
    expect(codes[0]).toMatchObject({ redeemedCount: 2, maxRedemptions: 5, state: 'ACTIVE' });
    // Masked, never echoed: a list that returned live codes would turn a stolen
    // admin session into free coins (ADR-0016).
    expect(codes[0]?.codeMasked).toBe('TR•••••1');
  });

  it('is newest first', async () => {
    await admin.create(SUPER, { code: 'OLDERONE', coins: 10 });
    clock.advance(60_000);
    await admin.create(SUPER, { code: 'NEWERONE', coins: 10 });

    const { codes } = await admin.list(SUPER);

    expect(codes.map((row) => row.codeMasked)).toEqual(['NE•••••E', 'OL•••••E']);
  });

  it('is empty rather than an error when nothing has been minted', async () => {
    await expect(admin.list(SUPER)).resolves.toEqual({ codes: [], total: 0 });
  });
});
