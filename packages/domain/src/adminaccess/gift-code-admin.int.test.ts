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
const admin = new GiftCodeAdminService(service, clock, access, audit);

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

    expect(created.perUserLimit).toBe(1);
    expect(created.maxRedemptions).toBeNull();
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
  it('stops it being redeemable, without touching its expiry', async () => {
    await admin.create(SUPER, { code: 'KILLABLE', coins: 20 });
    const user = await createUser(prisma, 'PROFILE_COMPLETE');

    const disabled = await admin.setActive(SUPER, 'killable', false);

    expect(disabled.isActive).toBe(false);
    expect(disabled.expiresAt).toBeNull();
    await expect(giftCodes.redeem(user, 'KILLABLE')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
  });

  it('can be turned back on', async () => {
    await admin.create(SUPER, { code: 'KILLABLE', coins: 20 });
    await admin.setActive(SUPER, 'KILLABLE', false);

    await admin.setActive(SUPER, 'KILLABLE', true);

    const user = await createUser(prisma, 'PROFILE_COMPLETE');
    await expect(giftCodes.redeem(user, 'KILLABLE')).resolves.toMatchObject({ coins: 20 });
  });

  it('audits the change with what it was before', async () => {
    const created = await admin.create(SUPER, { code: 'KILLABLE', coins: 20 });
    const row = await prisma.giftCode.findUniqueOrThrow({ where: { code: created.code } });

    await admin.setActive(SUPER, 'KILLABLE', false);

    const entries = await prisma.auditLog.findMany({
      where: { targetId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((entry) => entry.action)).toEqual(['giftcode.created', 'giftcode.disabled']);
  });

  it('refuses a code that does not exist', async () => {
    await expect(admin.setActive(SUPER, 'NOSUCHCODE', false)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
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

    const [row] = await admin.list(SUPER);

    expect(row).toMatchObject({ code: 'TRACKED1', redeemedCount: 2, maxRedemptions: 5 });
  });

  it('is newest first', async () => {
    await admin.create(SUPER, { code: 'OLDERONE', coins: 10 });
    clock.advance(60_000);
    await admin.create(SUPER, { code: 'NEWERONE', coins: 10 });

    const rows = await admin.list(SUPER);

    expect(rows.map((row) => row.code)).toEqual(['NEWERONE', 'OLDERONE']);
  });

  it('is empty rather than an error when nothing has been minted', async () => {
    await expect(admin.list(SUPER)).resolves.toEqual([]);
  });
});
