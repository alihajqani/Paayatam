import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@payetam/platform';
import type { PrismaClient } from '@payetam/db';
import type { PrismaService } from '@payetam/db';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { CoinService, type CoinMovementInput } from './coin.service';

/**
 * The ledger guarantees, against a real Postgres.
 *
 * Every property here is a database property — a UNIQUE index, a CHECK, a
 * trigger, a row lock. Mocking any of it would test the mock (ADR-0007).
 */

const prisma: PrismaClient = createTestPrisma();

/**
 * A fixed clock, because the ledger now stamps `created_at` from it (ADR-0008).
 * The value is arbitrary here — what matters is that it is the domain's clock and
 * not the database's, so a policy window and the rows it filters agree.
 */
const clock = new FakeClock(new Date('2026-08-15T09:00:00.000Z'));
const coins = new CoinService(prisma as unknown as PrismaService, clock);

function grant(userId: string, amount: number, key: string): CoinMovementInput {
  return {
    userId,
    amount,
    type: 'ONBOARDING_REWARD',
    reasonCode: 'test.grant',
    idempotencyKey: key,
    actorType: 'SYSTEM',
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('CoinService.apply', () => {
  it('creates the account lazily and records the movement', async () => {
    const userId = await createUser(prisma);

    const movement = await coins.apply(grant(userId, 50, `t:${userId}`));

    expect(movement).toMatchObject({ applied: true, balance: 50 });
    await expect(coins.balanceOf(userId)).resolves.toBe(50);

    const ledger = await prisma.coinLedger.findMany({ where: { userId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 50, balanceBefore: 0, balanceAfter: 50 });
  });

  it('reports a zero balance for a user who has never moved a coin', async () => {
    const userId = await createUser(prisma);
    await expect(coins.balanceOf(userId)).resolves.toBe(0);
  });

  it('is a no-op the second time the same key is applied', async () => {
    const userId = await createUser(prisma);
    const key = `t:${userId}`;

    const first = await coins.apply(grant(userId, 50, key));
    const second = await coins.apply(grant(userId, 50, key));

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.ledgerId).toBe(first.ledgerId);
    await expect(coins.balanceOf(userId)).resolves.toBe(50);
  });

  it('applies exactly once under 20 concurrent calls with the same key', async () => {
    const userId = await createUser(prisma);
    const key = `t:${userId}`;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => coins.apply(grant(userId, 50, key))),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    await expect(prisma.coinLedger.count({ where: { userId } })).resolves.toBe(1);
    await expect(coins.balanceOf(userId)).resolves.toBe(50);
  });

  it('keeps the balance equal to the sum of the ledger under concurrent distinct movements', async () => {
    const userId = await createUser(prisma);

    // Distinct keys, so every one of these must land. The account row lock is
    // what serialises them; without it, two would read the same balance_before
    // and one increment would vanish.
    await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        coins.apply(grant(userId, index + 1, `t:${userId}:${index}`)),
      ),
    );

    const expected = (20 * 21) / 2;
    const aggregate = await prisma.coinLedger.aggregate({
      where: { userId },
      _sum: { amount: true },
    });

    expect(aggregate._sum.amount).toBe(expected);
    await expect(coins.balanceOf(userId)).resolves.toBe(expected);
  });

  it('refuses to overdraw, and says so in a way a user can act on', async () => {
    const userId = await createUser(prisma);
    await coins.apply(grant(userId, 30, `t:${userId}:credit`));

    await expect(coins.apply(grant(userId, -40, `t:${userId}:debit`))).rejects.toMatchObject({
      code: 'INSUFFICIENT_COINS',
      details: { balance: 30, required: 40 },
    });

    // The failed spend left nothing behind.
    await expect(coins.balanceOf(userId)).resolves.toBe(30);
    await expect(prisma.coinLedger.count({ where: { userId } })).resolves.toBe(1);
  });

  it('lets exactly one of two concurrent spends of the last coins succeed', async () => {
    const userId = await createUser(prisma);
    await coins.apply(grant(userId, 50, `t:${userId}:credit`));

    const outcomes = await Promise.allSettled([
      coins.apply(grant(userId, -50, `t:${userId}:spend-a`)),
      coins.apply(grant(userId, -50, `t:${userId}:spend-b`)),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    await expect(coins.balanceOf(userId)).resolves.toBe(0);
  });

  it('rejects a zero movement rather than consuming the key for nothing', async () => {
    const userId = await createUser(prisma);
    await expect(coins.apply(grant(userId, 0, `t:${userId}`))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });
});

describe('coin_ledger immutability (invariant 3)', () => {
  it('raises on UPDATE', async () => {
    const userId = await createUser(prisma);
    await coins.apply(grant(userId, 50, `t:${userId}`));

    await expect(
      prisma.coinLedger.updateMany({ where: { userId }, data: { amount: 5000 } }),
    ).rejects.toThrow(/append-only/);
  });

  it('raises on DELETE — with no retention escape hatch, unlike audit_log', async () => {
    const userId = await createUser(prisma);
    await coins.apply(grant(userId, 50, `t:${userId}`));

    await expect(prisma.coinLedger.deleteMany({ where: { userId } })).rejects.toThrow(
      /append-only/,
    );

    // Even with the retention flag the M15 purge uses elsewhere: deleting a
    // ledger row would break reconciliation for good.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('payetam.retention_purge', 'on', true)`;
        await tx.coinLedger.deleteMany({ where: { userId } });
      }),
    ).rejects.toThrow(/append-only/);

    await expect(prisma.coinLedger.count({ where: { userId } })).resolves.toBe(1);
  });
});

describe('coin_ledger constraints', () => {
  it('rejects a row whose arithmetic does not add up', async () => {
    const userId = await createUser(prisma);

    // A hand-written row, bypassing CoinService entirely — which is the point.
    // The constraint has to hold for a migration or a psql session too.
    await expect(
      prisma.coinLedger.create({
        data: {
          userId,
          idempotencyKey: `t:${userId}`,
          type: 'ADMIN_ADJUSTMENT',
          amount: 50,
          balanceBefore: 0,
          balanceAfter: 500,
          reasonCode: 'test.drift',
          actorType: 'ADMIN',
        },
      }),
    ).rejects.toThrow(/coin_ledger_arithmetic/);
  });

  it('rejects a REVERSAL that names nothing, and a non-reversal that names something', async () => {
    const userId = await createUser(prisma);
    const original = await coins.apply(grant(userId, 50, `t:${userId}`));

    await expect(
      prisma.coinLedger.create({
        data: {
          userId,
          idempotencyKey: `t:${userId}:orphan-reversal`,
          type: 'REVERSAL',
          amount: -50,
          balanceBefore: 50,
          balanceAfter: 0,
          reasonCode: 'test.reversal',
          actorType: 'ADMIN',
        },
      }),
    ).rejects.toThrow(/coin_ledger_reversal_targets_original/);

    await expect(
      prisma.coinLedger.create({
        data: {
          userId,
          idempotencyKey: `t:${userId}:mislabelled`,
          type: 'ADMIN_ADJUSTMENT',
          amount: -50,
          balanceBefore: 50,
          balanceAfter: 0,
          reasonCode: 'test.reversal',
          actorType: 'ADMIN',
          reversesLedgerId: original.ledgerId,
        },
      }),
    ).rejects.toThrow(/coin_ledger_reversal_targets_original/);
  });

  it('allows a ledger row to be reversed only once', async () => {
    const userId = await createUser(prisma);
    const original = await coins.apply(grant(userId, 50, `t:${userId}`));

    const reversal = {
      userId,
      type: 'REVERSAL' as const,
      amount: -50,
      balanceBefore: 50,
      balanceAfter: 0,
      reasonCode: 'test.reversal',
      actorType: 'ADMIN' as const,
      reversesLedgerId: original.ledgerId,
    };

    await prisma.coinLedger.create({
      data: { ...reversal, idempotencyKey: `t:${userId}:reversal-1` },
    });

    // A second reversal of the same row would silently double the refund.
    await expect(
      prisma.coinLedger.create({
        data: { ...reversal, idempotencyKey: `t:${userId}:reversal-2` },
      }),
    ).rejects.toThrow();
  });
});
