import { describe, expect, it } from 'vitest';
import {
  CATEGORY_HISTORY_CAP,
  rankCandidates,
  scoreCandidate,
  type InviteCandidate,
  type InviteWeights,
} from './score';

/**
 * The scorer, with no database in sight (M22 phase 11).
 *
 * It is a pure function precisely so this file can exist: the properties that
 * matter — determinism, tie-breaking, the trust term never punishing a new
 * account, the ceiling on history — are all arithmetic, and asserting them
 * through a query would be asserting the query instead.
 */

const WEIGHTS: InviteWeights = {
  sameCity: 30,
  interestMatch: 20,
  categoryHistory: 25,
  recentActivity: 15,
  trust: 10,
  recentInvitePenalty: 20,
};

const TARGET = { cityId: 'city-tehran', categoryId: 'cat-boardgames' };

function candidate(overrides: Partial<InviteCandidate> = {}): InviteCandidate {
  return {
    userId: '01a00000-0000-7000-8000-000000000001',
    cityId: 'city-other',
    interestCategoryIds: [],
    categoryAttendances: 0,
    recentlyActive: false,
    trustScore: null,
    invitedRecently: false,
    ...overrides,
  };
}

describe('scoreCandidate', () => {
  it('scores nothing for somebody who matches nothing', () => {
    expect(scoreCandidate(candidate(), TARGET, WEIGHTS).total).toBe(0);
  });

  it('adds the city term only for the event’s own city', () => {
    expect(scoreCandidate(candidate({ cityId: 'city-tehran' }), TARGET, WEIGHTS).sameCity).toBe(30);
    expect(scoreCandidate(candidate({ cityId: 'city-karaj' }), TARGET, WEIGHTS).sameCity).toBe(0);
  });

  it('adds the interest term when a declared interest matches the category', () => {
    const scored = scoreCandidate(
      candidate({ interestCategoryIds: ['cat-hiking', 'cat-boardgames'] }),
      TARGET,
      WEIGHTS,
    );

    expect(scored.interestMatch).toBe(20);
  });

  it('scales history and stops at the cap', () => {
    const at = (attendances: number) =>
      scoreCandidate(candidate({ categoryAttendances: attendances }), TARGET, WEIGHTS)
        .categoryHistory;

    expect(at(0)).toBe(0);
    expect(at(1)).toBe(8);
    expect(at(CATEGORY_HISTORY_CAP)).toBe(25);
    // Past the cap the term stops growing, so one very frequent attendee cannot
    // outrank every plausible newcomer on this alone.
    expect(at(50)).toBe(25);
  });

  /**
   * ADR-0014: a missing score is not a bad score. The people a negative default
   * would push down are new users who have done nothing wrong.
   */
  it('never penalises an account that has never been judged', () => {
    expect(scoreCandidate(candidate({ trustScore: null }), TARGET, WEIGHTS).trust).toBe(0);
    expect(scoreCandidate(candidate({ trustScore: 0 }), TARGET, WEIGHTS).trust).toBe(0);
    expect(scoreCandidate(candidate({ trustScore: 50 }), TARGET, WEIGHTS).trust).toBe(5);
    expect(scoreCandidate(candidate({ trustScore: 100 }), TARGET, WEIGHTS).trust).toBe(10);
  });

  it('subtracts for a recent invitation', () => {
    const scored = scoreCandidate(
      candidate({ cityId: 'city-tehran', invitedRecently: true }),
      TARGET,
      WEIGHTS,
    );

    expect(scored.recentInvitePenalty).toBe(-20);
    expect(scored.total).toBe(10);
  });

  it('sums to the total it reports', () => {
    const scored = scoreCandidate(
      candidate({
        cityId: 'city-tehran',
        interestCategoryIds: ['cat-boardgames'],
        categoryAttendances: 3,
        recentlyActive: true,
        trustScore: 100,
      }),
      TARGET,
      WEIGHTS,
    );

    expect(scored.total).toBe(30 + 20 + 25 + 15 + 10);
  });

  /**
   * The breakdown is what gets stored, so it must describe numbers and nothing
   * else. A field naming the city or the interest would be a profile of the
   * recipient sitting in a column somebody can export.
   */
  it('reports numbers only', () => {
    const scored = scoreCandidate(candidate({ cityId: 'city-tehran' }), TARGET, WEIGHTS);

    for (const value of Object.values(scored)) expect(typeof value).toBe('number');
    expect(JSON.stringify(scored)).not.toContain('city-tehran');
  });
});

describe('rankCandidates', () => {
  it('takes the highest scores, in order', () => {
    const ranked = rankCandidates(
      [
        candidate({ userId: 'u-1' }),
        candidate({ userId: 'u-2', cityId: 'city-tehran' }),
        candidate({ userId: 'u-3', cityId: 'city-tehran', recentlyActive: true }),
      ],
      TARGET,
      WEIGHTS,
      2,
    );

    expect(ranked.map((row) => row.userId)).toEqual(['u-3', 'u-2']);
  });

  /**
   * Deterministic ties are the property an operator confirming a charge depends
   * on: a preview and the send that follows it must pick the same twenty.
   */
  it('breaks ties on the user id, the same way every time', () => {
    const tied = ['u-c', 'u-a', 'u-b'].map((userId) =>
      candidate({ userId, cityId: 'city-tehran' }),
    );

    expect(rankCandidates(tied, TARGET, WEIGHTS, 3).map((row) => row.userId)).toEqual([
      'u-a',
      'u-b',
      'u-c',
    ]);
    // Same input in a different order, same answer.
    expect(
      rankCandidates([...tied].reverse(), TARGET, WEIGHTS, 3).map((row) => row.userId),
    ).toEqual(['u-a', 'u-b', 'u-c']);
  });

  it('returns everybody when there are fewer than the limit', () => {
    expect(rankCandidates([candidate()], TARGET, WEIGHTS, 20)).toHaveLength(1);
  });

  it('returns nothing for an empty pool, rather than throwing', () => {
    expect(rankCandidates([], TARGET, WEIGHTS, 20)).toEqual([]);
  });

  it('never returns more than the limit, however large the pool', () => {
    const pool = Array.from({ length: 100 }, (_, index) =>
      candidate({ userId: `u-${String(index).padStart(3, '0')}`, cityId: 'city-tehran' }),
    );

    expect(rankCandidates(pool, TARGET, WEIGHTS, 20)).toHaveLength(20);
  });
});
