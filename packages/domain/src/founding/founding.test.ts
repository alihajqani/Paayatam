import { describe, expect, it } from 'vitest';
import { foundingRewardKey, tierFor } from './founding.service';

/**
 * The tier lookup, which is arithmetic over six settings and needs no database.
 *
 * The interesting cases are all boundaries. A campaign that pays the founder
 * rate to rank 101 costs real coins and, worse, tells somebody they are a
 * founder when they are not — and the failure is silent, because nothing
 * downstream re-derives the tier once it is snapshotted on the row.
 */
const TIERS = {
  'founding.tier1_max_rank': 100,
  'founding.tier1_coins': 150,
  'founding.tier2_max_rank': 400,
  'founding.tier2_coins': 80,
  'founding.tier3_max_rank': 1000,
  'founding.tier3_coins': 40,
};

describe('tierFor', () => {
  it('puts the first rank in tier 1', () => {
    expect(tierFor(1, TIERS)).toEqual({ tier: 1, coins: 150 });
  });

  it.each([
    [100, 1, 150],
    [101, 2, 80],
    [400, 2, 80],
    [401, 3, 40],
    [1000, 3, 40],
  ])('rank %i is tier %i at %i coins', (rank, tier, coins) => {
    expect(tierFor(rank, TIERS)).toEqual({ tier, coins });
  });

  /**
   * `founding.tier3_max_rank` and `founding_campaign.max_rank` are two numbers
   * that can be tuned apart. The cap normally makes this unreachable; when it
   * does not, a member who was allocated a rank must still be given a tier —
   * a mislabelled member is a far smaller failure than one holding a rank the
   * product refuses to name.
   */
  it('gives a rank past the last boundary the last tier rather than none', () => {
    expect(tierFor(1001, TIERS)).toEqual({ tier: 3, coins: 40 });
    expect(tierFor(99_999, TIERS)).toEqual({ tier: 3, coins: 40 });
  });

  it('handles a single-tier campaign, where every boundary is the same', () => {
    const flat = {
      'founding.tier1_max_rank': 1000,
      'founding.tier1_coins': 100,
      'founding.tier2_max_rank': 1000,
      'founding.tier2_coins': 100,
      'founding.tier3_max_rank': 1000,
      'founding.tier3_coins': 100,
    };
    expect(tierFor(1, flat)).toEqual({ tier: 1, coins: 100 });
    expect(tierFor(1000, flat)).toEqual({ tier: 1, coins: 100 });
  });

  /**
   * A tier configured to pay nothing is legitimate — it is how a wave is turned
   * into recognition only — and must not be confused with "no tier".
   */
  it('allows a tier that grants zero coins', () => {
    const unpaid = { ...TIERS, 'founding.tier3_coins': 0 };
    expect(tierFor(500, unpaid)).toEqual({ tier: 3, coins: 0 });
  });
});

describe('foundingRewardKey', () => {
  /**
   * This string *is* the exactly-once guarantee. The test is here so that a
   * refactor which "tidies" the format has to change an assertion that says why
   * — a changed key grants every existing member a second time.
   */
  it('is derived from the user and nothing else', () => {
    expect(foundingRewardKey('u1')).toBe('founding:u1');
    expect(foundingRewardKey('u1')).toBe(foundingRewardKey('u1'));
    expect(foundingRewardKey('u1')).not.toBe(foundingRewardKey('u2'));
  });
});
