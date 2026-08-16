import { describe, expect, it } from 'vitest';
import type { ParticipantStatus } from '@payetam/db';
import { terminalStates } from '../state-machine';
import {
  PARTICIPANT_TRANSITIONS,
  SEAT_HOLDING_STATUSES,
  assertParticipantTransition,
  holdsSeat,
} from './state-machine';

/**
 * The table is the specification, so the tests assert its shape rather than
 * re-listing it. A test that repeats the table verbatim passes whatever the table
 * says and catches only typos.
 */

describe('the participation lifecycle', () => {
  it('matches plan §7 on what a pending request may become', () => {
    expect([...PARTICIPANT_TRANSITIONS.PENDING].sort()).toEqual([
      'ACCEPTED',
      'CANCELLED_BY_PARTICIPANT',
      'EXPIRED',
      'REJECTED',
    ]);
  });

  it('lets a waitlisted request be promoted, cancelled or expired — and nothing else', () => {
    expect([...PARTICIPANT_TRANSITIONS.WAITLISTED].sort()).toEqual([
      'CANCELLED_BY_PARTICIPANT',
      'EXPIRED',
      'PENDING',
    ]);
  });

  /**
   * The absence worth a test of its own. A host looking at a waitlist would
   * plausibly expect to pick someone off it, and allowing that would quietly
   * undo ADR-0011's FIFO promotion: being third in the queue would stop meaning
   * anything.
   */
  it('does not let a host accept straight off the waitlist, which would jump the queue', () => {
    expect(PARTICIPANT_TRANSITIONS.WAITLISTED).not.toContain('ACCEPTED');
    expect(() => assertParticipantTransition('WAITLISTED', 'ACCEPTED')).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });

  it('ends every settled request — six terminal states, no way back', () => {
    expect(terminalStates(PARTICIPANT_TRANSITIONS).sort()).toEqual([
      'CANCELLED_BY_HOST',
      'CANCELLED_BY_PARTICIPANT',
      'COMPLETED',
      'EXPIRED',
      'NO_SHOW',
      'REJECTED',
    ]);
  });

  it('reaches every status from somewhere, except the two entry points', () => {
    const reachable = new Set(Object.values(PARTICIPANT_TRANSITIONS).flat());
    const statuses = Object.keys(PARTICIPANT_TRANSITIONS) as ParticipantStatus[];

    // PENDING and WAITLISTED are entry edges from nothing (`(none) ─►`), so a
    // join creates them directly. Everything else must be reachable, or it is a
    // status the product can never be in.
    for (const status of statuses) {
      if (status === 'WAITLISTED') continue;
      expect(reachable.has(status), `${status} is unreachable`).toBe(true);
    }
  });

  it('rejects an illegal transition as a conflict, naming both ends', () => {
    try {
      assertParticipantTransition('REJECTED', 'ACCEPTED', 'participant-1');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        httpStatus: 409,
        details: {
          entity: 'event_participant',
          id: 'participant-1',
          from: 'REJECTED',
          to: 'ACCEPTED',
        },
      });
    }
  });
});

describe('which statuses hold a seat', () => {
  /**
   * `event.accepted_count` counts seats taken, not people accepted. A PENDING
   * request holds one, which is what makes the waitlist meaningful at join time
   * and what gives a cancellation a seat to free.
   */
  it('is exactly PENDING and ACCEPTED', () => {
    expect([...SEAT_HOLDING_STATUSES].sort()).toEqual(['ACCEPTED', 'PENDING']);
  });

  it.each<[ParticipantStatus, boolean]>([
    ['PENDING', true],
    ['ACCEPTED', true],
    ['WAITLISTED', false],
    ['REJECTED', false],
    ['EXPIRED', false],
    ['CANCELLED_BY_PARTICIPANT', false],
    ['CANCELLED_BY_HOST', false],
    ['COMPLETED', false],
    ['NO_SHOW', false],
  ])('%s holds a seat: %s', (status, expected) => {
    expect(holdsSeat(status)).toBe(expected);
  });

  /**
   * Every way out of a seat-holding status must be to one that holds no seat, or
   * the seat is never released. This is the property that keeps `accepted_count`
   * from drifting upward over an event's life.
   */
  it('releases the seat on every transition out of one', () => {
    for (const status of SEAT_HOLDING_STATUSES) {
      for (const next of PARTICIPANT_TRANSITIONS[status]) {
        if (status === 'PENDING' && next === 'ACCEPTED') continue; // seat is kept
        expect(holdsSeat(next), `${status} → ${next} must free the seat`).toBe(false);
      }
    }
  });

  it('takes a seat on the one transition into one', () => {
    // WAITLISTED → PENDING is promotion (M7): the only edge that acquires a seat
    // after the request was made.
    expect(holdsSeat('WAITLISTED')).toBe(false);
    expect(holdsSeat('PENDING')).toBe(true);
  });
});
