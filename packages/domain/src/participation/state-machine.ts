import type { ParticipantStatus } from '@payetam/db';
import { assertTransition, type TransitionTable } from '../state-machine';

/**
 * The participation lifecycle, exactly as plan §7 draws it.
 *
 * ```
 *  (none) ─► PENDING ──────► ACCEPTED ─► COMPLETED
 *     │        │ │ │             │ └──► NO_SHOW
 *     │        │ │ │             └────► CANCELLED_BY_HOST | CANCELLED_BY_PARTICIPANT
 *     │        │ │ └► EXPIRED (host_deadline_at passed)
 *     │        │ └──► CANCELLED_BY_PARTICIPANT
 *     │        └────► REJECTED
 *     └─► WAITLISTED ─► PENDING   (promotion; sets host_deadline_at)
 *              └─────► CANCELLED_BY_PARTICIPANT | EXPIRED
 * ```
 *
 * `WAITLISTED → ACCEPTED` is deliberately absent, though a host looking at a
 * waitlist would plausibly expect to pick someone off it. Allowing it would let
 * a host jump the queue, and ADR-0011 makes promotion strictly FIFO by
 * `(requested_at, id)` precisely so that being waitlisted means something. A host
 * who wants a specific person gets them by the queue reaching them.
 *
 * `CANCELLED_BY_HOST` is reachable only from ACCEPTED: it is what a host
 * cancelling the whole event does to the people who had seats (M10). Someone
 * still waiting or still pending was never given anything to take away, and
 * their request ends as EXPIRED when the event does.
 */
export const PARTICIPANT_TRANSITIONS: TransitionTable<ParticipantStatus> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED_BY_PARTICIPANT'],
  WAITLISTED: ['PENDING', 'CANCELLED_BY_PARTICIPANT', 'EXPIRED'],
  ACCEPTED: ['COMPLETED', 'NO_SHOW', 'CANCELLED_BY_HOST', 'CANCELLED_BY_PARTICIPANT'],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED_BY_PARTICIPANT: [],
  CANCELLED_BY_HOST: [],
  COMPLETED: [],
  NO_SHOW: [],
};

export function assertParticipantTransition(
  from: ParticipantStatus,
  to: ParticipantStatus,
  participantId?: string,
): void {
  assertTransition(PARTICIPANT_TRANSITIONS, from, to, {
    entity: 'event_participant',
    ...(participantId !== undefined ? { id: participantId } : {}),
  });
}

/**
 * The statuses that occupy a seat, and therefore the definition of
 * `event.accepted_count`.
 *
 * The column name is inherited from the plan and reads as "people accepted", but
 * what it counts is **seats taken**, and a PENDING request takes one. That is
 * forced by two independent parts of the spec: the join flow admits a request as
 * PENDING only while `accepted_count < capacity` and waitlists it otherwise
 * (plan §5), and ADR-0011 has a cancellation free a seat that promotion then
 * fills with a *PENDING* row. If PENDING held no seat, the first rule would
 * admit everybody and the second would have nothing to free.
 *
 * The consequence worth stating: a host who never decides still holds seats, so
 * `host_deadline_at` is not a nicety. It is the bound on how long an undecided
 * request can keep a seat out of circulation.
 */
export const SEAT_HOLDING_STATUSES: readonly ParticipantStatus[] = ['PENDING', 'ACCEPTED'];

export function holdsSeat(status: ParticipantStatus): boolean {
  return SEAT_HOLDING_STATUSES.includes(status);
}

/**
 * Statuses a user can hold that stop them requesting the same event again.
 *
 * Not used as a guard — invariant 4's UNIQUE index is the guard, and it covers
 * every status including the settled ones. This exists for the read models that
 * answer "am I in this event?".
 */
export const LIVE_PARTICIPANT_STATUSES: readonly ParticipantStatus[] = [
  'PENDING',
  'WAITLISTED',
  'ACCEPTED',
];
