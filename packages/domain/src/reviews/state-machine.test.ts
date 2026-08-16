import { describe, expect, it } from 'vitest';
import { canTransition, terminalStates } from '../state-machine';
import {
  REVEALED_PAIR_STATUSES,
  REVIEW_PAIR_TRANSITIONS,
  REVIEW_TRANSITIONS,
  assertReviewPairTransition,
  assertReviewTransition,
} from './state-machine';

describe('the review state machine (plan §7)', () => {
  it('moves a submitted review to revealed, and to hidden from either side', () => {
    expect(canTransition(REVIEW_TRANSITIONS, 'SUBMITTED', 'REVEALED')).toBe(true);
    expect(canTransition(REVIEW_TRANSITIONS, 'SUBMITTED', 'HIDDEN')).toBe(true);
    expect(canTransition(REVIEW_TRANSITIONS, 'REVEALED', 'HIDDEN')).toBe(true);
  });

  /** A revealed review is public. Un-publishing it is `HIDDEN`, not a step back. */
  it('never returns a revealed review to submitted', () => {
    expect(canTransition(REVIEW_TRANSITIONS, 'REVEALED', 'SUBMITTED')).toBe(false);
    expect(() => {
      assertReviewTransition('REVEALED', 'SUBMITTED');
    }).toThrow(/INVALID_STATE_TRANSITION/);
  });

  it('treats hidden as terminal', () => {
    expect(terminalStates(REVIEW_TRANSITIONS)).toEqual(['HIDDEN']);
  });
});

describe('the review pair state machine (ADR-0011, D7/D7a)', () => {
  it('follows the plan’s diagram exactly', () => {
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'PENDING', 'PARTIAL')).toBe(true);
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'PARTIAL', 'REVEALED')).toBe(true);
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'PARTIAL', 'EXPIRED_PARTIAL')).toBe(true);
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'PENDING', 'EXPIRED_EMPTY')).toBe(true);
  });

  /**
   * Two sides cannot arrive at once: each submission is its own transaction, so
   * the second always finds the first already there. Admitting the edge would be
   * admitting a path that says a pair went from empty to complete in one step,
   * which would hide a bug rather than describe one.
   */
  it('refuses to go straight from empty to revealed', () => {
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'PENDING', 'REVEALED')).toBe(false);
    expect(() => {
      assertReviewPairTransition('PENDING', 'REVEALED');
    }).toThrow(/INVALID_STATE_TRANSITION/);
  });

  /** The deadline is the whole mechanism. A settled pair does not reopen. */
  it('treats all four settled states as terminal', () => {
    expect(terminalStates(REVIEW_PAIR_TRANSITIONS).sort()).toEqual([
      'EXPIRED_EMPTY',
      'EXPIRED_PARTIAL',
      'REVEALED',
    ]);
  });

  it('never lets an expired pair accept a late review', () => {
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'EXPIRED_PARTIAL', 'REVEALED')).toBe(false);
    expect(canTransition(REVIEW_PAIR_TRANSITIONS, 'EXPIRED_EMPTY', 'PARTIAL')).toBe(false);
  });
});

/**
 * Invariant 8, expressed as one list rather than as a rule each query remembers.
 *
 * `EXPIRED_PARTIAL` is readable because D7a reveals the one side that was written;
 * `PARTIAL` is not, because that is precisely the state in which one person has
 * written and the other has not.
 */
describe('which pair statuses are readable', () => {
  it('includes exactly the two the plan reveals', () => {
    expect([...REVEALED_PAIR_STATUSES].sort()).toEqual(['EXPIRED_PARTIAL', 'REVEALED']);
  });

  it('excludes the state where one side has written and the other has not', () => {
    expect(REVEALED_PAIR_STATUSES).not.toContain('PARTIAL');
    expect(REVEALED_PAIR_STATUSES).not.toContain('PENDING');
  });
});
