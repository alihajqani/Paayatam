import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient, type PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry } from '@payetam/platform';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { CoinService } from './coin.service';
import { GiftCodeService, giftCodeRedemptionKey } from './gift-code.service';

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
const giftCodes = new GiftCodeService(service, clock, coins, audit, new MetricsRegistry());

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

  it('accepts the code however it was retyped', async () => {
    // Codes are read off one screen and typed into another. Stored normalized, so
    // case and separators are the column's problem rather than every query's.
    await createCode({ code: 'SUMMER24' });

    const result = await giftCodes.redeem(user, '  summer-24 ');

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
