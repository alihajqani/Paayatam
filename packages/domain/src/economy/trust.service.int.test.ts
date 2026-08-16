import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@payetam/platform';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { SettingsService } from '../catalog/settings.service';
import {
  TRUST_ALGO_VERSION,
  TRUST_INITIAL_REASON,
  TRUST_MAX_SCORE,
  TRUST_MIN_SCORE,
  TrustService,
  trustInitialKey,
} from './trust.service';

/**
 * Trust Score against a real database.
 *
 * The properties here are the ones ADR-0007 sets out, and every one of them is a
 * property of Postgres rather than of this code: the unique index that makes a
 * movement exactly-once, the trigger that makes the ledger immutable, the CHECK
 * that keeps the score in range, and the arithmetic constraint that keeps
 * `score = SUM(delta)` true no matter what a caller asks for. Mocking any of that
 * would be mocking the thing under test.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-15T09:00:00.000Z'));
const settings = new SettingsService(service);
const trust = new TrustService(service, clock, settings);

let userId: string;

/** A movement with the boilerplate filled in. */
function movement(overrides: { delta: number; key: string; reason?: string }) {
  return {
    userId,
    delta: overrides.delta,
    type: 'ADMIN_ADJUSTMENT' as const,
    reasonCode: overrides.reason ?? 'test.adjustment',
    idempotencyKey: overrides.key,
    actorType: 'SYSTEM' as const,
  };
}

async function ledgerSum(): Promise<number> {
  const result = await prisma.trustScoreLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return result._sum.delta ?? 0;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  userId = await createUser(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the starting score', () => {
  /**
   * Fifty, not zero. A user who has done nothing has not done anything *wrong*,
   * and reading a missing row as the worst possible reputation would bury every
   * new account — the outcome plan §12's "neutral bucket" exists to prevent.
   */
  it('is the configured default for somebody who has never moved', async () => {
    expect(await trust.scoreOf(userId)).toBe(50);
    expect(await prisma.trustScore.findUnique({ where: { userId } })).toBeNull();
  });

  /**
   * The seed is a ledger row like any other, which is what makes
   * `score = SUM(delta)` true from the first entry rather than from the second.
   * A column seeded to 50 directly would be fifty points no entry accounts for.
   */
  it('arrives as an INITIAL entry on the first movement', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));

    const entries = await prisma.trustScoreLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'INITIAL',
      reasonCode: TRUST_INITIAL_REASON,
      delta: 50,
      scoreBefore: 0,
      scoreAfter: 50,
      idempotencyKey: trustInitialKey(userId),
    });
    expect(entries[1]).toMatchObject({ delta: 5, scoreBefore: 50, scoreAfter: 55 });
    expect(await trust.scoreOf(userId)).toBe(55);
  });

  it('is granted once, however many movements follow', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));
    await trust.apply(movement({ delta: -3, key: 'k2' }));
    await trust.apply(movement({ delta: 1, key: 'k3' }));

    expect(await prisma.trustScoreLedger.count({ where: { userId, type: 'INITIAL' } })).toBe(1);
    expect(await trust.scoreOf(userId)).toBe(53);
  });

  it('stamps the algorithm version on every row', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));

    const versions = await prisma.trustScoreLedger.findMany({
      where: { userId },
      select: { algoVersion: true },
    });
    expect(versions.every((row) => row.algoVersion === TRUST_ALGO_VERSION)).toBe(true);
  });
});

describe('clamping to [0, 100]', () => {
  it('never exceeds the maximum, however hard it is pushed', async () => {
    await trust.apply(movement({ delta: 200, key: 'up' }));

    expect(await trust.scoreOf(userId)).toBe(TRUST_MAX_SCORE);
  });

  it('never goes below the minimum, however hard it is pushed', async () => {
    await trust.apply(movement({ delta: -200, key: 'down' }));

    expect(await trust.scoreOf(userId)).toBe(TRUST_MIN_SCORE);
  });

  /**
   * The stored delta is what *moved*, not what was asked for. Storing the
   * requested value would break `score = SUM(delta)` the moment anybody reached a
   * bound, which is the one property the reconciliation test checks.
   */
  it('records the effective movement and remembers what was requested', async () => {
    await trust.apply(movement({ delta: 90, key: 'up' }));

    const entry = await prisma.trustScoreLedger.findUniqueOrThrow({
      where: { idempotencyKey: 'up' },
    });
    expect(entry.delta).toBe(50);
    expect(entry.scoreAfter).toBe(100);
    expect(entry.metadata).toMatchObject({ requestedDelta: 90 });
  });

  it('leaves no `requestedDelta` behind when nothing was clipped', async () => {
    await trust.apply(movement({ delta: 10, key: 'ok' }));

    const entry = await prisma.trustScoreLedger.findUniqueOrThrow({
      where: { idempotencyKey: 'ok' },
    });
    expect(entry.metadata).toBeNull();
  });

  /**
   * The case that decides whether clamping is safe: a rule that fires against
   * somebody already at the ceiling **still writes a row**, because the row is
   * what consumes the idempotency key. Skip it and a redelivered job finds the
   * key unused and pays out for real the moment the score has room again.
   */
  it('writes a zero row rather than leaving the key unused', async () => {
    await trust.apply(movement({ delta: 100, key: 'ceiling' }));
    expect(await trust.scoreOf(userId)).toBe(100);

    const capped = await trust.apply(movement({ delta: 3, key: 'review-42' }));
    expect(capped.effectiveDelta).toBe(0);

    const entry = await prisma.trustScoreLedger.findUniqueOrThrow({
      where: { idempotencyKey: 'review-42' },
    });
    expect(entry).toMatchObject({ delta: 0, scoreBefore: 100, scoreAfter: 100 });
    expect(entry.metadata).toMatchObject({ requestedDelta: 3 });

    // …and now the score has room, the same cause must still not pay out.
    await trust.apply(movement({ delta: -20, key: 'penalty' }));
    await trust.apply(movement({ delta: 3, key: 'review-42' }));
    expect(await trust.scoreOf(userId)).toBe(80);
  });

  it('rejects a caller asking for no movement at all', async () => {
    await expect(trust.apply(movement({ delta: 0, key: 'nothing' }))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(await prisma.trustScoreLedger.count({ where: { userId } })).toBe(0);
  });
});

describe('exactly once', () => {
  it('is a no-op the second time the same key is applied', async () => {
    const first = await trust.apply(movement({ delta: 7, key: 'same' }));
    const second = await trust.apply(movement({ delta: 7, key: 'same' }));

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.ledgerId).toBe(first.ledgerId);
    expect(await trust.scoreOf(userId)).toBe(57);
  });

  /**
   * The idempotency check happens under the row lock, which is what makes this
   * pass. Read it before locking and twenty callers all see "not yet applied";
   * nineteen then fail at the unique index, aborting whatever transaction they
   * were part of.
   */
  it('applies exactly once under 20 concurrent calls with the same key', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => trust.apply(movement({ delta: 4, key: 'concurrent' }))),
    );

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await trust.scoreOf(userId)).toBe(54);
    expect(await prisma.trustScoreLedger.count({ where: { userId } })).toBe(2);
  });

  it('keeps the score equal to the sum of the ledger under concurrent movements', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        trust.apply(movement({ delta: index % 2 === 0 ? 2 : -1, key: `k${String(index)}` })),
      ),
    );

    expect(await trust.scoreOf(userId)).toBe(await ledgerSum());
  });
});

describe('trust_score_ledger immutability (invariant 3)', () => {
  it('raises on UPDATE', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));
    const entry = await prisma.trustScoreLedger.findFirstOrThrow({ where: { userId } });

    await expect(
      prisma.trustScoreLedger.update({ where: { id: entry.id }, data: { delta: 99 } }),
    ).rejects.toThrow(/append-only/);
  });

  /**
   * No retention escape hatch, unlike `audit_log` and `consent`. Deleting a row
   * here does not lose history, it produces a wrong number with no way to
   * discover that it is wrong — the score is *defined* as the sum of these rows.
   */
  it('raises on DELETE, with no way for the retention job to override it', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));
    const entry = await prisma.trustScoreLedger.findFirstOrThrow({ where: { userId } });

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('payetam.retention_purge', 'on', true)`;
        await tx.trustScoreLedger.delete({ where: { id: entry.id } });
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('the ledger is the explanation (ADR-0007)', () => {
  it('reads back newest first, with what each entry did and why', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1', reason: 'trust.profile_completed' }));
    await trust.apply(movement({ delta: -8, key: 'k2', reason: 'trust.no_show' }));

    const history = await trust.historyOf(userId);

    expect(history.map((entry) => entry.reasonCode)).toEqual([
      'trust.no_show',
      'trust.profile_completed',
      TRUST_INITIAL_REASON,
    ]);
    expect(history[0]).toMatchObject({ delta: -8, scoreBefore: 55, scoreAfter: 47 });
  });

  /** «چرا امتیاز من ۴۷ است؟» — answerable by adding up the rows, exactly. */
  it('adds up to the score, entry by entry', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));
    await trust.apply(movement({ delta: -8, key: 'k2' }));

    const history = await trust.historyOf(userId);
    const sum = history.reduce((total, entry) => total + entry.delta, 0);

    expect(sum).toBe(47);
    expect(await trust.scoreOf(userId)).toBe(47);
  });
});

describe('the CHECK constraints', () => {
  it('rejects a row whose arithmetic does not add up', async () => {
    await expect(
      prisma.trustScoreLedger.create({
        data: {
          userId,
          idempotencyKey: 'bad-arithmetic',
          type: 'ADMIN_ADJUSTMENT',
          delta: 5,
          scoreBefore: 50,
          scoreAfter: 60,
          reasonCode: 'test',
          algoVersion: 1,
          actorType: 'SYSTEM',
        },
      }),
    ).rejects.toThrow(/trust_score_ledger_arithmetic/);
  });

  it('rejects a score outside the range, on either side', async () => {
    await expect(
      prisma.trustScoreLedger.create({
        data: {
          userId,
          idempotencyKey: 'too-high',
          type: 'ADMIN_ADJUSTMENT',
          delta: 1,
          scoreBefore: 100,
          scoreAfter: 101,
          reasonCode: 'test',
          algoVersion: 1,
          actorType: 'SYSTEM',
        },
      }),
    ).rejects.toThrow(/trust_score_ledger_within_range/);
  });

  it('rejects a REVERSAL that names nothing, and a non-reversal that names something', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));
    const entry = await prisma.trustScoreLedger.findFirstOrThrow({ where: { userId } });

    await expect(
      prisma.trustScoreLedger.create({
        data: {
          userId,
          idempotencyKey: 'orphan-reversal',
          type: 'REVERSAL',
          delta: -5,
          scoreBefore: 55,
          scoreAfter: 50,
          reasonCode: 'test',
          algoVersion: 1,
          actorType: 'SYSTEM',
        },
      }),
    ).rejects.toThrow(/reversal_pairing/);

    await expect(
      prisma.trustScoreLedger.create({
        data: {
          userId,
          idempotencyKey: 'lying-adjustment',
          type: 'ADMIN_ADJUSTMENT',
          delta: -5,
          scoreBefore: 55,
          scoreAfter: 50,
          reasonCode: 'test',
          algoVersion: 1,
          actorType: 'SYSTEM',
          reversesLedgerId: entry.id,
        },
      }),
    ).rejects.toThrow(/reversal_pairing/);
  });

  it('rejects a score outside the range on `trust_score` itself', async () => {
    await trust.apply(movement({ delta: 5, key: 'k1' }));

    await expect(
      prisma.trustScore.update({ where: { userId }, data: { score: 120 } }),
    ).rejects.toThrow(/trust_score_within_range/);
  });
});
