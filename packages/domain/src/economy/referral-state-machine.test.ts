import { describe, expect, it } from 'vitest';
import { canTransition, terminalStates } from '../state-machine';
import { REFERRAL_TRANSITIONS, assertReferralTransition } from './referral-state-machine';

/**
 * The three edges, and the two that are deliberately missing.
 *
 * A transition table is the kind of thing that reads as obviously correct and is
 * asserted nowhere, so the absences below matter more than the presences: each
 * one is protecting a property that lives somewhere else in the product, and a
 * future edge added "for symmetry" would break it silently.
 */
describe('the referral state machine', () => {
  it('lets a pending referral qualify or be rejected', () => {
    expect(canTransition(REFERRAL_TRANSITIONS, 'PENDING', 'QUALIFIED')).toBe(true);
    expect(canTransition(REFERRAL_TRANSITIONS, 'PENDING', 'REJECTED')).toBe(true);
  });

  /**
   * A qualified referral has produced two `coin_ledger` rows, and the ledger is
   * append-only (invariant 3). A status saying "rejected" over them would be a
   * record disagreeing with itself; clawing coins back is `CoinService.reverse`.
   */
  it('never lets a paid referral be rejected or re-qualified', () => {
    expect(terminalStates(REFERRAL_TRANSITIONS)).toEqual(['QUALIFIED']);
    expect(canTransition(REFERRAL_TRANSITIONS, 'QUALIFIED', 'REJECTED')).toBe(false);
    expect(canTransition(REFERRAL_TRANSITIONS, 'QUALIFIED', 'PENDING')).toBe(false);
  });

  /**
   * A rejection is a judgement, so it is reversible — but only back to
   * `PENDING`. An admin may restore a chance to earn a reward and may not grant
   * one, which is why `REJECTED → QUALIFIED` does not exist: the attendance
   * condition is `ReferralService`'s to check, not a moderator's to assert.
   */
  it('lets a rejection be undone, and never turned into a payment', () => {
    expect(canTransition(REFERRAL_TRANSITIONS, 'REJECTED', 'PENDING')).toBe(true);
    expect(canTransition(REFERRAL_TRANSITIONS, 'REJECTED', 'QUALIFIED')).toBe(false);
  });

  it('throws a conflict rather than a crash on an illegal move', () => {
    expect(() => {
      assertReferralTransition('QUALIFIED', 'REJECTED', 'some-referral');
    }).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
  });
});
