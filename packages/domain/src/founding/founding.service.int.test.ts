import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { createTestPrisma, createUser, resetDatabase } from '../../../../test/integration/db';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { FoundingService, foundingRewardKey } from './founding.service';

/**
 * The launch campaign, against a real Postgres.
 *
 * Everything this file asserts is a claim about a row lock, a conditional UPDATE
 * or a UNIQUE index. None of it is meaningful against a mock: the whole design
 * exists because `MAX(rank) + 1` races and a sequence leaves gaps, and neither
 * failure is reachable without a database and real concurrency.
 */
const prisma = createTestPrisma();
const service = prisma as unknown as PrismaService;
const clock = new FakeClock(new Date('2026-03-01T09:00:00.000Z'));
const settings = new SettingsService(service);
const coins = new CoinService(service, clock);
const founding = new FoundingService(service, settings, coins);

/** Runs `award` in its own transaction, the way `ProfileService` does. */
async function award(userId: string) {
  return prisma.$transaction((tx) => founding.award(userId, tx));
}

async function setCap(maxRank: number): Promise<void> {
  await prisma.foundingCampaign.update({ where: { id: 1 }, data: { maxRank } });
}

/** Overrides one policy number. `resetDatabase` truncates `app_setting`. */
async function setSetting(key: string, value: number): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  /**
   * Switched on explicitly, because the shipped default is **off**.
   *
   * That default is the deploy-safety property — a rank is irreversible, so the
   * campaign must not begin when the code lands — and it means every test here
   * has to opt in. Reading the campaign as on by accident is exactly the bug the
   * default exists to prevent, so no test is allowed to inherit it.
   */
  await setSetting('founding.enabled', 1);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('FoundingService.award', () => {
  it('hands out 1, 2, 3 in order and snapshots the tier and the coins', async () => {
    const first = await createUser(prisma);
    const second = await createUser(prisma);

    expect(await award(first)).toEqual({ rank: 1, tier: 1, coins: 150 });
    expect(await award(second)).toEqual({ rank: 2, tier: 1, coins: 150 });

    const row = await prisma.foundingMember.findUnique({ where: { userId: second } });
    expect(row).toMatchObject({ rank: 2, tier: 1, coins: 150 });
    // The grant and the row are one fact: the member points at the ledger row
    // that paid it, which is what makes "why does this account have 150 coins?"
    // answerable from either end.
    expect(row?.coinLedgerId).not.toBeNull();

    const ledger = await prisma.coinLedger.findUnique({
      where: { idempotencyKey: foundingRewardKey(second) },
    });
    expect(ledger).toMatchObject({ amount: 150, type: 'FOUNDING_REWARD' });
    expect(ledger?.id).toBe(row?.coinLedgerId);
  });

  /**
   * The property the whole design exists for.
   *
   * Two transactions racing for a rank must not both read the same `next_rank`.
   * `Promise.all` rather than sequential awaits, because sequential calls would
   * pass against the broken implementation too — and the broken implementation
   * is the one somebody writes when they replace this with `MAX(rank) + 1`.
   */
  it('gives two concurrent allocations two different ranks', async () => {
    const users = await Promise.all([
      createUser(prisma),
      createUser(prisma),
      createUser(prisma),
      createUser(prisma),
      createUser(prisma),
    ]);

    const awarded = await Promise.all(users.map((userId) => award(userId)));
    const ranks = awarded.map((a) => a?.rank).sort((a, b) => (a ?? 0) - (b ?? 0));

    expect(ranks).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a second rank to the same user', async () => {
    const userId = await createUser(prisma);

    expect(await award(userId)).toEqual({ rank: 1, tier: 1, coins: 150 });
    expect(await award(userId)).toBeNull();

    // And the second call took no number: the next member is 2, not 3. A rank
    // burned by a repeat is a gap, and a gap is the one thing the counter row
    // exists to prevent.
    const next = await createUser(prisma);
    expect(await award(next)).toMatchObject({ rank: 2 });

    const rows = await prisma.foundingMember.count({ where: { userId } });
    expect(rows).toBe(1);
  });

  it('pays the second tier past the first boundary', async () => {
    await setSetting('founding.tier1_max_rank', 1);

    const first = await createUser(prisma);
    const second = await createUser(prisma);

    expect(await award(first)).toEqual({ rank: 1, tier: 1, coins: 150 });
    expect(await award(second)).toEqual({ rank: 2, tier: 2, coins: 80 });
  });

  it('stops at the cap and keeps working afterwards', async () => {
    await setCap(2);

    const users = await Promise.all(Array.from({ length: 3 }, () => createUser(prisma)));
    const awarded = await Promise.all(users.map((userId) => award(userId)));

    expect(awarded.filter((a) => a !== null)).toHaveLength(2);
    expect(await prisma.foundingMember.count()).toBe(2);

    // The refused user was not charged, not credited, and not recorded.
    const rejectedAt = awarded.findIndex((a) => a === null);
    const rejected = users[rejectedAt] as string;
    expect(await prisma.coinLedger.count({ where: { userId: rejected } })).toBe(0);
    expect(await prisma.foundingMember.count({ where: { userId: rejected } })).toBe(0);
  });

  /**
   * The cap is a count, not a read-then-write. Ten transactions competing for
   * one remaining slot must produce one member, not ten.
   */
  it('gives the last slot to exactly one of ten racers', async () => {
    await setCap(1);

    const users = await Promise.all(Array.from({ length: 10 }, () => createUser(prisma)));
    const awarded = await Promise.all(users.map((userId) => award(userId)));

    expect(awarded.filter((a) => a !== null)).toHaveLength(1);
    expect(await prisma.foundingMember.count()).toBe(1);
  });

  it('allocates nothing while the campaign is switched off', async () => {
    // Back to the shipped default, which is what a freshly deployed instance
    // does before anybody opens the campaign.
    await setSetting('founding.enabled', 0);

    const userId = await createUser(prisma);
    expect(await award(userId)).toBeNull();
    expect(await prisma.foundingMember.count()).toBe(0);

    // And the counter did not move: switching the campaign back on resumes at 1
    // rather than skipping everybody who arrived while it was off.
    const campaign = await prisma.foundingCampaign.findUnique({ where: { id: 1 } });
    expect(campaign?.nextRank).toBe(1);
  });

  /**
   * A tier that pays nothing still produces a member. The nullable
   * `coin_ledger_id` is what makes that representable, and the alternative —
   * writing a zero-amount ledger row — is refused by `coin_ledger`'s own CHECK.
   */
  it('records a member for a tier that grants no coins', async () => {
    await setSetting('founding.tier1_coins', 0);

    const userId = await createUser(prisma);
    expect(await award(userId)).toEqual({ rank: 1, tier: 1, coins: 0 });

    const row = await prisma.foundingMember.findUnique({ where: { userId } });
    expect(row).toMatchObject({ rank: 1, coins: 0, coinLedgerId: null });
    expect(await prisma.coinLedger.count({ where: { userId } })).toBe(0);
  });

  /**
   * A rank is only consumed if the transaction that took it commits. This is the
   * difference between the counter row and a Postgres sequence, and it is the
   * reason the table exists at all.
   */
  it('returns the rank when the surrounding transaction rolls back', async () => {
    const doomed = await createUser(prisma);
    const survivor = await createUser(prisma);

    await expect(
      prisma.$transaction(async (tx) => {
        await founding.award(doomed, tx);
        throw new Error('the caller failed after the rank was taken');
      }),
    ).rejects.toThrow('the caller failed');

    // Not 2. The abandoned transaction gave its number back.
    expect(await award(survivor)).toMatchObject({ rank: 1 });
    expect(await prisma.foundingMember.count()).toBe(1);
  });
});

describe('FoundingService.progress', () => {
  it('counts what has been handed out, not what is left', async () => {
    expect(await founding.progress()).toEqual({ awarded: 0, max: 1000 });

    await award(await createUser(prisma));
    await award(await createUser(prisma));

    expect(await founding.progress()).toEqual({ awarded: 2, max: 1000 });
  });
});

describe('FoundingService.memberOf', () => {
  it('answers null for somebody who has no rank', async () => {
    expect(await founding.memberOf(await createUser(prisma))).toBeNull();
  });

  it('reads back exactly what was stored', async () => {
    const userId = await createUser(prisma);
    const awarded = await award(userId);
    expect(await founding.memberOf(userId)).toEqual(awarded);
  });
});
