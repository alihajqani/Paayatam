import { describe, expect, it } from 'vitest';
import type { ParticipantStatus } from '@payetam/db';
import { terminalStates } from '../state-machine';
import {
  PARTICIPANT_TRANSITIONS,
  SEAT_HOLDING_STATUSES,
  SLOT_HOLDING_STATUSES,
  holdsSlot,
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
   * `event.accepted_count` counts **people the host accepted**, and nothing else.
   *
   * It used to count PENDING as well, on the reading that a request "holds" the
   * seat it is asking for. What that produced in production was an activity with
   * two places reporting «ظرفیت تکمیل» while one request had been rejected and
   * another had expired unanswered: each release promoted somebody off the
   * waiting list into PENDING, which re-took the seat, so the counter never came
   * down and nobody had been accepted at all.
   *
   * `capacity - accepted_count` is rendered to users as «جای خالی». A seat held
   * by a question the host has not answered is not an empty seat or a full one,
   * and the number stopped being about seats. Now it is.
   */
  it('is exactly ACCEPTED', () => {
    expect([...SEAT_HOLDING_STATUSES]).toEqual(['ACCEPTED']);
  });

  it.each<[ParticipantStatus, boolean]>([
    ['ACCEPTED', true],
    ['PENDING', false],
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
        expect(holdsSeat(next), `${status} → ${next} must free the seat`).toBe(false);
      }
    }
  });

  /**
   * PENDING → ACCEPTED is now the **only** edge that takes one.
   *
   * Which is what makes `ParticipationService.accept`'s capacity assertion a live
   * guard rather than the defensive one it used to be: before this change no
   * reachable path could accept a row that held no seat, so it could not fire.
   */
  it('takes a seat on exactly one transition', () => {
    const acquiring = (Object.keys(PARTICIPANT_TRANSITIONS) as ParticipantStatus[]).flatMap(
      (from) =>
        PARTICIPANT_TRANSITIONS[from]
          .filter((to) => !holdsSeat(from) && holdsSeat(to))
          .map((to) => `${from} → ${to}`),
    );

    expect(acquiring).toEqual(['PENDING → ACCEPTED']);
  });
});

/**
 * The counterpart, and the reason the change above did not kill the waiting
 * list.
 *
 * If PENDING held nothing and nothing else changed, `join` would admit everybody
 * and nobody would ever be waitlisted. A PENDING request holds a **slot in the
 * host's queue** instead, and `join` admits while `accepted_count + slots <
 * capacity` — the same arithmetic as before, with the two quantities kept apart
 * rather than summed into one column.
 */
describe('which statuses hold a queue slot', () => {
  it('is exactly PENDING', () => {
    expect([...SLOT_HOLDING_STATUSES]).toEqual(['PENDING']);
  });

  it('is disjoint from the seat-holding set', () => {
    for (const status of SLOT_HOLDING_STATUSES) {
      expect(holdsSeat(status), `${status} must not hold both`).toBe(false);
    }
  });

  it.each<[ParticipantStatus, boolean]>([
    ['PENDING', true],
    ['WAITLISTED', false],
    ['ACCEPTED', false],
    ['REJECTED', false],
    ['EXPIRED', false],
  ])('%s holds a slot: %s', (status, expected) => {
    expect(holdsSlot(status)).toBe(expected);
  });
});
