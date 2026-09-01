import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient, type PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry } from '@payetam/platform';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from './coin.service';
import {
  GIFT_CODE_FAILURE_ACTION,
  GIFT_CODE_SUCCESS_ACTION,
  GiftCodeService,
  giftCodeRedemptionKey,
} from './gift-code.service';

/**
 * Gift codes against a real database.
 *
 * Everything the feature promises is a *database* guarantee — a row lock for the
 * global cap, a unique index for the per-user limit, and `coin_ledger`'s
 * idempotency key for the coins — so mocking Postgres here would assert nothing.
 * The concurrency cases in particular are the whole point: a single pass through
 * a race is a coin flip that landed the way you wanted, which is why they run
 * many times.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-20T09:00:00.000Z');
const clock = new FakeClock(NOW);

const coins = new CoinService(service, clock);
const audit = new AuditService(service, clock);
// `SettingsService` for `giftcode.enabled`, the v0.6.5 kill switch. Real rather
// than stubbed: the default is 1 and the suite asserts redemption works, so a
// stub returning the wrong thing would silently disable every case here.
const settings = new SettingsService(service);
const giftCodes = new GiftCodeService(
  service,
  clock,
  coins,
  audit,
  new MetricsRegistry(),
  settings,
);

let user: string;

interface CodeOverrides {
  code?: string;
  coins?: number;
  maxRedemptions?: number | null;
  perUserLimit?: number;
  startsAt?: Date | null;
  expiresAt?: Date | null;
  isActive?: boolean;
}

async function createCode(overrides: CodeOverrides = {}): Promise<string> {
  const row = await prisma.giftCode.create({
    data: {
      code: overrides.code ?? 'WELCOME24',
      coins: overrides.coins ?? 25,
      maxRedemptions: overrides.maxRedemptions ?? null,
      perUserLimit: overrides.perUserLimit ?? 1,
      startsAt: overrides.startsAt ?? null,
      expiresAt: overrides.expiresAt ?? null,
      isActive: overrides.isActive ?? true,
      createdAt: NOW,
    },
  });
  return row.id;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  user = await createUser(prisma, 'PROFILE_COMPLETE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('redeeming', () => {
  it('grants the coins the row says, and reports the balance it left', async () => {
    await createCode({ coins: 25 });

    const result = await giftCodes.redeem(user, 'WELCOME24');

    expect(result.coins).toBe(25);
    expect(result.balance).toBe(25);
    expect(await coins.balanceOf(user)).toBe(25);
  });

  it('writes a ledger row for the grant, never a bare balance update', async () => {
    // ADR-0007, and invariant 3: the balance is a cache and the ledger is the
    // truth. A grant with no row is a balance nobody can account for.
    const codeId = await createCode({ coins: 40 });

    await giftCodes.redeem(user, 'WELCOME24');

    const ledger = await prisma.coinLedger.findMany({ where: { userId: user } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'GIFT_CODE_REDEEM',
      amount: 40,
      balanceBefore: 0,
      balanceAfter: 40,
      reasonCode: 'giftcode.redeemed',
      refType: 'gift_code',
      refId: codeId,
    });
    expect(ledger[0]?.idempotencyKey).toBe(giftCodeRedemptionKey(codeId, user, 1));
  });

  it('links the redemption to the ledger row that paid it', async () => {
    await createCode();

    await giftCodes.redeem(user, 'WELCOME24');

    const redemption = await prisma.giftCodeRedemption.findFirst({ where: { userId: user } });
    const ledger = await prisma.coinLedger.findFirst({ where: { userId: user } });
    expect(redemption?.coinLedgerId).toBe(ledger?.id);
    expect(redemption?.seq).toBe(1);
    expect(redemption?.coins).toBe(25);
  });

  it('records the redemption in the audit trail', async () => {
    const codeId = await createCode();

    await giftCodes.redeem(user, 'WELCOME24');

    const entries = await prisma.auditLog.findMany({ where: { targetId: codeId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'giftcode.redeemed', actorType: 'USER' });
  });

  /**
   * ── The one thing that is still forgiven ──────────────────────────────────
   *
   * Leading and trailing whitespace, because it is invisible, it comes from
   * pasting rather than typing, and a refusal caused by a character the user
   * cannot see is a refusal they cannot act on. Nothing else is.
   */
  it('ignores whitespace around the code, and nothing else', async () => {
    await createCode({ code: 'SUMMER24' });

    const result = await giftCodes.redeem(user, '  SUMMER24 ');

    expect(result.code).toBe('SUMMER24');
    expect(await coins.balanceOf(user)).toBe(25);
  });

  it('bumps the redeemed count under the same transaction as the grant', async () => {
    const codeId = await createCode();

    await giftCodes.redeem(user, 'WELCOME24');

    const row = await prisma.giftCode.findUnique({ where: { id: codeId } });
    expect(row?.redeemedCount).toBe(1);
  });
});

/**
 * A gift code is matched **exactly** (v0.6.5).
 *
 * ── The report ─────────────────────────────────────────────────────────────
 *
 * An operator created a campaign code `test1`, and a user redeemed it by typing
 * `test 1`. `normalizeCode` — shared with referral codes — upper-cased the input
 * and stripped every space and dash before anything compared it, so `test 1`,
 * `TEST-1` and `t e s t 1` were all the same string as `TEST1`. Coins were
 * granted for a code nobody had issued.
 *
 * That normalization is right for a *referral* code: it is generated from a
 * fixed alphabet and «abc-123» and «ABC123» are the same nine characters read
 * aloud. It is wrong for a gift code, whose text an operator chooses and which
 * is worth money — every string within one edit of a real code was a live code,
 * which for a bearer secret is the keyspace collapsing inwards.
 */
describe('a code is matched exactly', () => {
  it('refuses a different case', async () => {
    await createCode({ code: 'SUMMER24' });

    await expect(giftCodes.redeem(user, 'summer24')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
    expect(await coins.balanceOf(user)).toBe(0);
  });

  /** The reported case, exactly as it happened. */
  it('refuses an interior space', async () => {
    await createCode({ code: 'test1' });

    await expect(giftCodes.redeem(user, 'test 1')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
    expect(await coins.balanceOf(user)).toBe(0);
  });

  it('refuses a separator the code does not have', async () => {
    await createCode({ code: 'SUMMER24' });

    await expect(giftCodes.redeem(user, 'SUMMER-24')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
  });

  /** A lower-case code an operator chose is redeemable as they wrote it. */
  it('accepts a lower-case code typed exactly', async () => {
    await createCode({ code: 'test1' });

    const result = await giftCodes.redeem(user, 'test1');

    expect(result.code).toBe('test1');
    expect(await coins.balanceOf(user)).toBe(25);
  });
});

/**
 * The platform kill switch, `giftcode.enabled` (v0.6.5).
 *
 * `gift_code.is_active` stops one campaign; this stops all of them. The case it
 * is for is a code leaking to a channel with forty thousand members, where the
 * answer is "no codes at all until we know what happened" and disabling
 * campaigns one at a time leaves the last one live longest.
 */
describe('the platform kill switch', () => {
  async function setEnabled(value: number): Promise<void> {
    await prisma.appSetting.upsert({
      where: { key: 'giftcode.enabled' },
      create: { key: 'giftcode.enabled', value },
      update: { value },
    });
  }

  it('refuses every redemption while it is off', async () => {
    await createCode();
    await setEnabled(0);

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_DISABLED',
    });
    expect(await coins.balanceOf(user)).toBe(0);
  });

  /**
   * The same answer for a real code and an invented one, which is what keeps the
   * switch from becoming the oracle `GIFT_CODE_INVALID` is careful not to be.
   */
  it('answers identically whether or not the code exists', async () => {
    await createCode();
    await setEnabled(0);

    const real = await giftCodes.redeem(user, 'WELCOME24').catch((error: unknown) => error);
    const invented = await giftCodes.redeem(user, 'NOTHINGHERE').catch((error: unknown) => error);

    expect(real).toMatchObject({ code: 'GIFT_CODE_DISABLED' });
    expect(invented).toMatchObject({ code: 'GIFT_CODE_DISABLED' });
  });

  it('works again the moment it is switched back on', async () => {
    await createCode();
    await setEnabled(0);
    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toThrow();

    await setEnabled(1);

    expect(await giftCodes.redeem(user, 'WELCOME24')).toMatchObject({ coins: 25 });
  });

  it('is on by default, with no row at all', async () => {
    await createCode();

    expect(await giftCodes.redeem(user, 'WELCOME24')).toMatchObject({ coins: 25 });
  });
});

describe('refusals', () => {
  it('refuses a code that does not exist', async () => {
    await expect(giftCodes.redeem(user, 'NOSUCHCODE')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
    expect(await coins.balanceOf(user)).toBe(0);
  });

  it('refuses a disabled code without saying it was ever real', async () => {
    // Same code as "no such code": distinguishing them would turn this endpoint
    // into a way to enumerate which campaigns exist.
    await createCode({ isActive: false });

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
  });

  it('refuses a code whose window has closed', async () => {
    await createCode({ expiresAt: new Date(NOW.getTime() - 1000) });

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_EXPIRED',
    });
  });

  it('refuses a code whose window has not opened', async () => {
    await createCode({ startsAt: new Date(NOW.getTime() + 3_600_000) });

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_EXPIRED',
    });
  });

  it('opens exactly at starts_at and closes exactly at expires_at', async () => {
    // The boundaries, because "expired" measured with the wrong comparison is a
    // bug that only shows up on the last day of a campaign.
    await createCode({
      startsAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });

    await expect(giftCodes.redeem(user, 'WELCOME24')).resolves.toMatchObject({ coins: 25 });

    clock.set(new Date(NOW.getTime() + 3_600_000));
    const other = await createUser(prisma, 'PROFILE_COMPLETE');
    await expect(giftCodes.redeem(other, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_EXPIRED',
    });
  });

  it('refuses a second redemption of a single-use code by the same person', async () => {
    await createCode({ perUserLimit: 1 });
    await giftCodes.redeem(user, 'WELCOME24');

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_ALREADY_REDEEMED',
    });
    expect(await coins.balanceOf(user)).toBe(25);
  });

  it('refuses once the global cap is reached', async () => {
    await createCode({ maxRedemptions: 2 });
    const [second, third] = await Promise.all([
      createUser(prisma, 'PROFILE_COMPLETE'),
      createUser(prisma, 'PROFILE_COMPLETE'),
    ]);

    await giftCodes.redeem(user, 'WELCOME24');
    await giftCodes.redeem(second, 'WELCOME24');

    await expect(giftCodes.redeem(third, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_EXHAUSTED',
    });
    expect(await coins.balanceOf(third)).toBe(0);
  });

  it('leaves no ledger row behind when it refuses', async () => {
    // A refusal that had already moved the balance would be the worst outcome
    // available: coins granted for a code the product says was not accepted.
    await createCode({ isActive: false });

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toThrow();

    expect(await prisma.coinLedger.count()).toBe(0);
    expect(await prisma.giftCodeRedemption.count()).toBe(0);
  });
});

describe('what a refusal leaves behind (M19)', () => {
  /**
   * The counter answers "is somebody sweeping right now?" and answers nothing
   * else: it resets on deploy, it is per-replica, and it carries no time. A
   * campaign report six weeks later needs a row.
   */
  it('records a refused attempt in the audit trail, with its reason', async () => {
    const codeId = await createCode({ isActive: false });

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toThrow();

    const entries = await prisma.auditLog.findMany({
      where: { action: GIFT_CODE_FAILURE_ACTION },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ targetId: codeId, targetType: 'gift_code' });
    expect(entries[0]?.after).toEqual({ reason: 'invalid' });
  });

  it('distinguishes the four refusals by reason code', async () => {
    const expired = await createCode({
      code: 'EXPIRED1',
      expiresAt: new Date(NOW.getTime() - 1),
    });
    const exhausted = await createCode({
      code: 'FULLUP1',
      maxRedemptions: 1,
    });
    await giftCodes.redeem(await createUser(prisma, 'PROFILE_COMPLETE'), 'FULLUP1');
    const used = await createCode({ code: 'ONCEONLY' });
    await giftCodes.redeem(user, 'ONCEONLY');

    await expect(giftCodes.redeem(user, 'EXPIRED1')).rejects.toThrow();
    await expect(giftCodes.redeem(user, 'FULLUP1')).rejects.toThrow();
    await expect(giftCodes.redeem(user, 'ONCEONLY')).rejects.toThrow();

    const byTarget = new Map(
      (await prisma.auditLog.findMany({ where: { action: GIFT_CODE_FAILURE_ACTION } })).map(
        (entry) => [entry.targetId, (entry.after as { reason: string }).reason],
      ),
    );
    expect(byTarget.get(expired)).toBe('expired');
    expect(byTarget.get(exhausted)).toBe('exhausted');
    expect(byTarget.get(used)).toBe('already_redeemed');
  });

  /**
   * A sweep against codes that do not exist is the traffic this endpoint
   * actually attracts. Writing *what was tried* would turn the audit trail into
   * a list of near-miss codes — a file that is worth more to an attacker than to
   * a defender.
   */
  it('records an unknown code with no target and without echoing the guess', async () => {
    await expect(giftCodes.redeem(user, 'NOSUCHCODE')).rejects.toThrow();

    const entries = await prisma.auditLog.findMany({
      where: { action: GIFT_CODE_FAILURE_ACTION },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.targetId).toBeNull();
    expect(JSON.stringify(entries[0]?.after)).not.toContain('NOSUCHCODE');
  });

  it('never writes the code itself into the audit trail or the ledger', async () => {
    await createCode({ code: 'SECRET24' });

    await giftCodes.redeem(user, 'SECRET24');
    await expect(giftCodes.redeem(user, 'SECRET24')).rejects.toThrow();

    const trail = JSON.stringify(await prisma.auditLog.findMany());
    const ledger = JSON.stringify(await prisma.coinLedger.findMany());
    expect(trail).not.toContain('SECRET24');
    expect(ledger).not.toContain('SECRET24');
    // And the trail still says which code it was — by identifier, not by secret.
    expect(trail).toContain(GIFT_CODE_SUCCESS_ACTION);
  });
});

describe('the database is authoritative at redemption time (M19)', () => {
  /**
   * There is no cached verdict anywhere in the redemption path: `is_active`, the
   * window and both caps are read under the row lock that spends the code and
   * nowhere else. A client holding a page rendered five minutes ago therefore
   * cannot redeem something disabled since — which is the property, and it is
   * worth a test precisely because it holds by construction and a refactor could
   * quietly introduce a read-then-write.
   */
  it('refuses a code disabled after the client last saw it live', async () => {
    const codeId = await createCode();
    // What a stale client is holding: a code it observed as live.
    const asClientSawIt = await prisma.giftCode.findUniqueOrThrow({ where: { id: codeId } });
    expect(asClientSawIt.isActive).toBe(true);

    await prisma.giftCode.update({ where: { id: codeId }, data: { isActive: false } });

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_INVALID',
    });
    expect(await coins.balanceOf(user)).toBe(0);
  });

  it('refuses every one of ten concurrent attempts once the code is disabled', async () => {
    const codeId = await createCode();
    await prisma.giftCode.update({ where: { id: codeId }, data: { isActive: false } });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, () => giftCodes.redeem(user, 'WELCOME24')),
    );

    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(await prisma.coinLedger.count()).toBe(0);
  });

  /**
   * Disabling mid-flight is the case an operator actually meets: a campaign is
   * being drained faster than expected and has to stop *now*. Whatever is in
   * flight may land; nothing after the switch may.
   */
  it('lets a redemption that already committed stand, and refuses the next', async () => {
    const codeId = await createCode({ maxRedemptions: 10 });

    await giftCodes.redeem(user, 'WELCOME24');
    await prisma.giftCode.update({ where: { id: codeId }, data: { isActive: false } });

    const second = await createUser(prisma, 'PROFILE_COMPLETE');
    await expect(giftCodes.redeem(second, 'WELCOME24')).rejects.toThrow();

    // The first grant is untouched: the ledger is append-only and disabling a
    // campaign is not a reversal (ADR-0016).
    expect(await coins.balanceOf(user)).toBe(25);
    expect(await prisma.giftCodeRedemption.count()).toBe(1);
  });
});

describe('a multi-use code', () => {
  it('allows exactly as many redemptions per person as the limit says', async () => {
    await createCode({ perUserLimit: 3, coins: 10 });

    const first = await giftCodes.redeem(user, 'WELCOME24');
    const second = await giftCodes.redeem(user, 'WELCOME24');
    const third = await giftCodes.redeem(user, 'WELCOME24');

    expect([first.remainingForUser, second.remainingForUser, third.remainingForUser]).toEqual([
      2, 1, 0,
    ]);
    expect(await coins.balanceOf(user)).toBe(30);

    await expect(giftCodes.redeem(user, 'WELCOME24')).rejects.toMatchObject({
      code: 'GIFT_CODE_ALREADY_REDEEMED',
    });
  });

  it('gives each redemption its own idempotency key, so none of them collide', async () => {
    const codeId = await createCode({ perUserLimit: 2 });

    await giftCodes.redeem(user, 'WELCOME24');
    await giftCodes.redeem(user, 'WELCOME24');

    const keys = (
      await prisma.coinLedger.findMany({ where: { userId: user }, orderBy: { createdAt: 'asc' } })
    ).map((row) => row.idempotencyKey);
    expect(keys).toEqual([
      giftCodeRedemptionKey(codeId, user, 1),
      giftCodeRedemptionKey(codeId, user, 2),
    ]);
  });
});

describe('concurrency', () => {
  /**
   * Fifty iterations rather than one, for the reason `coin.service.int.test.ts`
   * gives about the same class of test: a single pass through a race is a coin
   * flip that landed the way you wanted.
   *
   * Each iteration gets a **fresh code and a fresh user** rather than a fresh
   * database. Truncating fifty times dominated the runtime and pushed the suite
   * past its timeout, and it was never what made the test meaningful: the
   * assertions are scoped to the code and the person under test, so rows left by
   * earlier iterations cannot make a failing race look green.
   */
  it('credits once when one person redeems a single-use code ten times at once', async () => {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const person = await createUser(prisma, 'PROFILE_COMPLETE');
      const code = `SINGLE${String(iteration).padStart(3, '0')}`;
      const codeId = await createCode({ code, perUserLimit: 1, coins: 25 });

      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () => giftCodes.redeem(person, code)),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(await coins.balanceOf(person)).toBe(25);
      expect(await prisma.coinLedger.count({ where: { userId: person } })).toBe(1);
      expect(await prisma.giftCodeRedemption.count({ where: { giftCodeId: codeId } })).toBe(1);
    }
  });

  it('honours the global cap when more people redeem at once than there are slots', async () => {
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const code = `CAPPED${String(iteration).padStart(3, '0')}`;
      const codeId = await createCode({ code, maxRedemptions: 3, coins: 10 });
      const people = await Promise.all(
        Array.from({ length: 10 }, () => createUser(prisma, 'PROFILE_COMPLETE')),
      );

      const attempts = await Promise.allSettled(
        people.map((person) => giftCodes.redeem(person, code)),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
      expect(await prisma.giftCodeRedemption.count({ where: { giftCodeId: codeId } })).toBe(3);
      const row = await prisma.giftCode.findUnique({ where: { id: codeId } });
      expect(row?.redeemedCount).toBe(3);
    }
  });
});

describe('the database, independently of the service', () => {
  it('refuses a redeemed count above the global cap', async () => {
    // The CHECK is the backstop for the day a future code path forgets the row
    // lock. It should never fire in normal operation, which is exactly why it has
    // to be asserted directly rather than through the service that respects it.
    const codeId = await createCode({ maxRedemptions: 1 });

    await expect(
      prisma.giftCode.update({ where: { id: codeId }, data: { redeemedCount: 2 } }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('refuses a code that grants nothing', async () => {
    await expect(createCode({ code: 'ZEROCODE', coins: 0 })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it('refuses a window that closes before it opens', async () => {
    await expect(
      createCode({
        code: 'BACKWARDS',
        startsAt: new Date(NOW.getTime() + 3_600_000),
        expiresAt: NOW,
      }),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('refuses two codes with the same normalized value', async () => {
    await createCode({ code: 'SUMMER24' });

    await expect(createCode({ code: 'SUMMER24' })).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });
});
