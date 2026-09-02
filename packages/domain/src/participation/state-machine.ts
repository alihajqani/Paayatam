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
 *     └─► WAITLISTED ─┬► PENDING   (promotion; sets host_deadline_at)
 *                     ├► ACCEPTED | REJECTED   (the host decides directly)
 *                     └► CANCELLED_BY_PARTICIPANT | EXPIRED
 * ```
 *
 * ── `WAITLISTED → ACCEPTED | REJECTED` (v0.7.0) ─────────────────────────────
 *
 * Both were absent, on the argument that a host picking somebody off the queue
 * jumps it, and ADR-0011 makes promotion strictly FIFO so that being waitlisted
 * means something.
 *
 * The argument was sound and the product did not implement it. «مهمان‌ها» has
 * drawn «✅ پذیرش» and «✖️ رد» on *every* PENDING **and WAITLISTED** row since
 * v0.6.2, and `participation.requested` sends the host the same two buttons for a
 * waitlisted request. So the host was offered two decisions the state machine
 * refused, and both answered «این عملیات در وضعیت فعلی ممکن نیست» — the reported
 * bug, reproducible by creating an activity with one place and letting two people
 * ask.
 *
 * Of the two ways to close that gap — take the buttons away, or let the host
 * decide — taking them away leaves a host who wants the second person with no
 * move except rejecting the first and hoping the promotion sweep reaches the one
 * they meant. Deciding directly is what they were already being offered, and
 * `accept` still refuses when there is no seat free (`assertSeatAvailable`), so
 * the queue is jumped only into a place that was actually empty.
 *
 * `CANCELLED_BY_HOST` is reachable only from ACCEPTED: it is what a host
 * cancelling the whole event does to the people who had seats (M10). Someone
 * still waiting or still pending was never given anything to take away, and
 * their request ends as EXPIRED when the event does.
 */
export const PARTICIPANT_TRANSITIONS: TransitionTable<ParticipantStatus> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED_BY_PARTICIPANT'],
  WAITLISTED: ['PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED_BY_PARTICIPANT', 'EXPIRED'],
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
 * ── What this used to be, and why it changed ────────────────────────────────
 *
 * Until v0.6.5 this was `['PENDING', 'ACCEPTED']`: an undecided request held a
 * seat from the moment it was made. That reading came from plan §5 — the join
 * flow admits a request while `accepted_count < capacity` and waitlists it
 * otherwise — and it made `accepted_count` mean *seats spoken for* rather than
 * what its name says.
 *
 * The behaviour that produced is what an operator reported. An activity with
 * **two** places showed «ظرفیت تکمیل» while one request had been rejected and
 * another had timed out unanswered: each release immediately promoted somebody
 * off the waiting list into PENDING, which re-took the seat, so the counter sat
 * at capacity while nobody had been accepted at all. Every part of that was
 * working as written, and the number on the screen was still wrong — because
 * `capacity - accepted_count` is rendered to users as «جای خالی», and a seat
 * held by a request the host has not answered is not an empty seat *or* a
 * filled one.
 *
 * So the column now means exactly what it is called: **a seat is consumed when a
 * host accepts, and at no other moment.** «۲ جای خالی از ۲» on an activity
 * nobody has been accepted to is the true statement, and it is the one the
 * operator expected to see.
 *
 * ── What still bounds the queue ─────────────────────────────────────────────
 *
 * Not this. If PENDING held nothing and nothing else changed, every request
 * would be admitted as PENDING and the waiting list would never receive anybody
 * — plan §5's second half would be dead code. `ParticipationService.join`
 * therefore admits against `accepted_count + PENDING`, which is the same
 * arithmetic in the same place, with the two quantities kept apart instead of
 * summed into one column. A host still sees at most `capacity` requests at a
 * time; the queue behind them still moves when one is refused; and the number
 * the product renders is now about seats rather than about attention.
 *
 * `host_deadline_at` keeps its job for the same reason it always had it: an
 * unanswered request holds a *slot in the queue*, and the deadline is the bound
 * on how long it can.
 */
export const SEAT_HOLDING_STATUSES: readonly ParticipantStatus[] = ['ACCEPTED'];

export function holdsSeat(status: ParticipantStatus): boolean {
  return SEAT_HOLDING_STATUSES.includes(status);
}

/**
 * Statuses that occupy a **slot in the host's queue** without occupying a seat.
 *
 * The counterpart to `SEAT_HOLDING_STATUSES`, and the reason splitting the two
 * did not simply remove the waiting list. `join` admits a request while
 * `accepted_count + <this many> < capacity`; past that the request is
 * WAITLISTED, exactly as it was before.
 */
export const SLOT_HOLDING_STATUSES: readonly ParticipantStatus[] = ['PENDING'];

export function holdsSlot(status: ParticipantStatus): boolean {
  return SLOT_HOLDING_STATUSES.includes(status);
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
