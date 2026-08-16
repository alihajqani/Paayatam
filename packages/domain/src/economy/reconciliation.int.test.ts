import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeClock } from '@payetam/platform';
import type { CoinLedgerType, PrismaClient, PrismaService } from '@payetam/db';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from './coin.service';
import { TrustService, clampScore } from './trust.service';

/**
 * ADR-0007's acceptance criterion, and the reason both ledgers exist:
 *
 *   > A reconciliation test over 1000 random operations proves `balance ==
 *   > SUM(amount)`.
 *
 * The cached `balance` and `score` columns are read on nearly every screen, which
 * is why they are cached at all — and a cache that can drift from its source is a
 * number nobody can trust and nobody can repair, because the drift is invisible
 * until somebody adds up the rows by hand. `balance_before`/`balance_after` are
 * denormalized too, so this checks the *chain* as well as the total: every row's
 * `after` must be the next row's `before`, or the history has a hole in it even
 * though the endpoints agree.
 *
 * Randomised rather than enumerated, deliberately. The interleavings that break
 * ledger arithmetic are the ones nobody thought to write down: a reversal landing
 * between two spends, an overdraft rejected mid-sequence, a trust movement
 * clipped by a bound it only just reached. A seeded generator explores those and
 * reports the seed when it finds one.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const START = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(START);
const settings = new SettingsService(service);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);

/** How many operations, and over how many accounts. */
const OPERATIONS = 1000;
const USERS = 8;

/**
 * A deterministic generator, so a failure is reproducible from the seed in the
 * message rather than "it went red once on CI".
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEED = 20_260_816;
const random = mulberry32(SEED);

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty choice list');
  return item;
}

function between(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

const EARNING_TYPES: readonly CoinLedgerType[] = [
  'ONBOARDING_REWARD',
  'REFERRAL_REWARD',
  'REVIEW_REWARD',
  'HOST_CANCELLATION_REFUND',
];
const SPENDING_TYPES: readonly CoinLedgerType[] = [
  'BOOST_SPEND',
  'VIP_SPEND',
  'CANCELLATION_PENALTY',
  'NO_SHOW_PENALTY',
];

let users: string[];
/** Ledger ids still eligible for reversal — credits nobody has reversed yet. */
let reversible: string[];

beforeAll(async () => {
  await resetDatabase(prisma);
  users = await Promise.all(Array.from({ length: USERS }, () => createUser(prisma)));
  reversible = [];

  for (let index = 0; index < OPERATIONS; index += 1) {
    // The ledgers stamp `created_at` from the clock (M10), so a fixed clock would
    // give all thousand rows the same timestamp — which is not what production
    // looks like and would make any read ordered by time arbitrary. Advancing it
    // a second at a time keeps the data shaped like real history.
    clock.set(new Date(START.getTime() + index * 1_000));
    await performOne(index);
  }
}, 600_000);

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * One randomly chosen economic operation.
 *
 * Failures are swallowed only where the domain is *entitled* to refuse —
 * an overdraft, or a reversal that would overdraw. Anything else rethrows, or
 * the test would be measuring a system that quietly stopped doing anything.
 */
async function performOne(index: number): Promise<void> {
  const userId = pick(users);
  const roll = random();

  try {
    if (roll < 0.35) {
      const movement = await coins.apply({
        userId,
        amount: between(5, 120),
        type: pick(EARNING_TYPES),
        reasonCode: 'reconciliation.earn',
        idempotencyKey: `earn:${String(index)}`,
        actorType: 'SYSTEM',
      });
      if (movement.applied) reversible.push(movement.ledgerId);
      return;
    }

    if (roll < 0.6) {
      await coins.apply({
        userId,
        amount: -between(5, 90),
        type: pick(SPENDING_TYPES),
        reasonCode: 'reconciliation.spend',
        idempotencyKey: `spend:${String(index)}`,
        actorType: 'USER',
        actorId: userId,
      });
      return;
    }

    if (roll < 0.68 && reversible.length > 0) {
      // Reversals are the operation most likely to break the arithmetic, since
      // they are the only ones whose amount is derived from another row.
      const position = Math.floor(random() * reversible.length);
      const [ledgerId] = reversible.splice(position, 1);
      if (ledgerId === undefined) return;
      await coins.reverse({
        ledgerId,
        reasonCode: 'reconciliation.reverse',
        actorType: 'ADMIN',
        actorId: 'reconciliation',
      });
      return;
    }

    if (roll < 0.74) {
      // A replay of an earlier key. Must change nothing at all.
      await coins.apply({
        userId,
        amount: between(5, 40),
        type: 'ADMIN_ADJUSTMENT',
        reasonCode: 'reconciliation.replay',
        idempotencyKey: `earn:${String(between(0, Math.max(index - 1, 0)))}`,
        actorType: 'ADMIN',
      });
      return;
    }

    await trust.apply({
      userId,
      // Wide enough that both bounds are reached repeatedly, which is the point:
      // clamping is where `score = SUM(delta)` is easiest to break.
      delta: between(-40, 40) || 7,
      type: pick(['ATTENDANCE', 'REVIEW', 'CANCELLATION', 'NO_SHOW', 'MODERATION'] as const),
      reasonCode: 'reconciliation.trust',
      idempotencyKey: `trust:${String(index)}`,
      actorType: 'SYSTEM',
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    // The two refusals the domain is entitled to make. Anything else is a bug
    // this test must not hide.
    if (code === 'INSUFFICIENT_COINS') return;
    throw new Error(`operation ${String(index)} failed (seed ${String(SEED)})`, { cause: error });
  }
}

describe(`reconciliation over ${String(OPERATIONS)} random operations (ADR-0007)`, () => {
  it('did enough work to be worth checking', async () => {
    const [coinRows, trustRows] = await Promise.all([
      prisma.coinLedger.count(),
      prisma.trustScoreLedger.count(),
    ]);

    expect(coinRows).toBeGreaterThan(300);
    expect(trustRows).toBeGreaterThan(150);
    // Both bounds must actually have been hit, or the clamping half of this test
    // proved nothing.
    expect(await prisma.trustScore.count({ where: { score: 100 } })).toBeGreaterThan(0);
    expect(await prisma.trustScoreLedger.count({ where: { delta: 0 } })).toBeGreaterThan(0);
  });

  it('keeps every balance equal to the sum of its ledger', async () => {
    for (const userId of users) {
      const [account, sum] = await Promise.all([
        prisma.coinAccount.findUnique({ where: { userId }, select: { balance: true } }),
        prisma.coinLedger.aggregate({ where: { userId }, _sum: { amount: true } }),
      ]);

      expect(account?.balance ?? 0, `user ${userId} (seed ${String(SEED)})`).toBe(
        sum._sum.amount ?? 0,
      );
    }
  });

  it('keeps every score equal to the sum of its ledger', async () => {
    for (const userId of users) {
      const [row, sum] = await Promise.all([
        prisma.trustScore.findUnique({ where: { userId }, select: { score: true } }),
        prisma.trustScoreLedger.aggregate({ where: { userId }, _sum: { delta: true } }),
      ]);
      if (!row) continue;

      expect(row.score, `user ${userId} (seed ${String(SEED)})`).toBe(sum._sum.delta ?? 0);
    }
  });

  it('never let a balance go negative', async () => {
    const accounts = await prisma.coinAccount.findMany({ select: { balance: true } });
    expect(accounts.every((account) => account.balance >= 0)).toBe(true);
  });

  it('never let a score leave [0, 100]', async () => {
    const scores = await prisma.trustScore.findMany({ select: { score: true } });
    expect(scores.every((row) => row.score === clampScore(row.score))).toBe(true);
  });

  /**
   * The chain, not just the total.
   *
   * `balance_before`/`balance_after` are denormalized, and ADR-0007 names them as
   * the thing that could theoretically drift. Two ledgers can sum correctly while
   * every row's stated running balance is nonsense — which would make the ledger
   * unreadable as a statement even though the endpoints agree.
   */
  it('keeps each coin entry continuous with the one before it', async () => {
    for (const userId of users) {
      const entries = await prisma.coinLedger.findMany({
        where: { userId },
        // `(created_at, id)`, not `created_at` alone. Two movements can share a
        // timestamp — the clock has millisecond resolution and a transaction can
        // write two rows inside one — and a tie makes the order arbitrary, which
        // turns a continuity check into a coin toss. `id` is UUIDv7, so it is
        // time-ordered and unique: the same tiebreak the waitlist queue uses.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { amount: true, balanceBefore: true, balanceAfter: true, createdAt: true },
      });

      let running = 0;
      for (const [position, entry] of entries.entries()) {
        expect(entry.balanceBefore, `user ${userId} entry ${String(position)}`).toBe(running);
        expect(entry.balanceAfter).toBe(running + entry.amount);
        running = entry.balanceAfter;
      }
    }
  });

  it('keeps each trust entry continuous with the one before it', async () => {
    for (const userId of users) {
      const entries = await prisma.trustScoreLedger.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { delta: true, scoreBefore: true, scoreAfter: true },
      });

      let running = 0;
      for (const [position, entry] of entries.entries()) {
        expect(entry.scoreBefore, `user ${userId} entry ${String(position)}`).toBe(running);
        expect(entry.scoreAfter).toBe(running + entry.delta);
        running = entry.scoreAfter;
      }
    }
  });

  /** Every reversal cancels its original exactly, and reverses only one row. */
  it('leaves every reversal paired with exactly one original', async () => {
    const reversals = await prisma.coinLedger.findMany({
      where: { type: 'REVERSAL' },
      select: { amount: true, reversesLedgerId: true, userId: true },
    });
    expect(reversals.length).toBeGreaterThan(0);

    for (const reversal of reversals) {
      expect(reversal.reversesLedgerId).not.toBeNull();
      const original = await prisma.coinLedger.findUniqueOrThrow({
        where: { id: reversal.reversesLedgerId ?? '' },
        select: { amount: true, userId: true },
      });
      expect(reversal.amount).toBe(-original.amount);
      expect(reversal.userId).toBe(original.userId);
    }
  });
});
