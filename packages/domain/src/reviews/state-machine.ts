import type { ReviewPairStatus, ReviewStatus } from '@payetam/db';
import { assertTransition, type TransitionTable } from '../state-machine';

/**
 * A single review's lifecycle, exactly as plan §7 draws it.
 *
 * ```
 *  SUBMITTED ─► REVEALED ─► HIDDEN     (moderation)
 * ```
 *
 * `SUBMITTED → HIDDEN` is here and not in the diagram: moderation must be able to
 * take down a review that never reached reveal — a comment reported inside the
 * edit window is exactly the case — and forcing it through REVEALED to do so would
 * mean publishing the thing being taken down.
 *
 * There is no edge back out of HIDDEN. Restoring a hidden review is an admin
 * decision that M12 owns, and it belongs in that milestone's transition table
 * rather than being left open here for nothing to use.
 */
export const REVIEW_TRANSITIONS: TransitionTable<ReviewStatus> = {
  SUBMITTED: ['REVEALED', 'HIDDEN'],
  REVEALED: ['HIDDEN'],
  HIDDEN: [],
};

export function assertReviewTransition(
  from: ReviewStatus,
  to: ReviewStatus,
  reviewId?: string,
): void {
  assertTransition(REVIEW_TRANSITIONS, from, to, {
    entity: 'review',
    ...(reviewId !== undefined ? { id: reviewId } : {}),
  });
}

/**
 * The pair's lifecycle (plan §7, ADR-0011 D7/D7a).
 *
 * ```
 *  PENDING ─► PARTIAL ─► REVEALED
 *      │          └────► EXPIRED_PARTIAL   (deadline, one side — D7a)
 *      └───────────────► EXPIRED_EMPTY     (deadline, neither side)
 * ```
 *
 * `PENDING → REVEALED` is deliberately **absent**. Two sides cannot arrive at
 * once: each submission is its own transaction taking its own row lock, so the
 * second one always finds the first already there and moves PARTIAL → REVEALED.
 * Admitting the edge would be admitting a path that says a pair went from empty to
 * complete in one step, which is a thing that cannot happen and would hide a bug
 * if it appeared to.
 *
 * All four terminal states really are terminal. A revealed pair does not reopen,
 * and an expired one does not accept a late review — the deadline is the whole
 * mechanism by which a blind review stops being blind.
 */
export const REVIEW_PAIR_TRANSITIONS: TransitionTable<ReviewPairStatus> = {
  PENDING: ['PARTIAL', 'EXPIRED_EMPTY'],
  PARTIAL: ['REVEALED', 'EXPIRED_PARTIAL'],
  REVEALED: [],
  EXPIRED_PARTIAL: [],
  EXPIRED_EMPTY: [],
};

export function assertReviewPairTransition(
  from: ReviewPairStatus,
  to: ReviewPairStatus,
  pairId?: string,
): void {
  assertTransition(REVIEW_PAIR_TRANSITIONS, from, to, {
    entity: 'review_pair',
    ...(pairId !== undefined ? { id: pairId } : {}),
  });
}

/**
 * The statuses in which a pair's reviews are readable by anybody but their author.
 *
 * **This is invariant 8, expressed once.** Every public read path filters on it,
 * so "no review is readable before reveal" is a property of this list rather than
 * of each query remembering the rule — and `EXPIRED_PARTIAL` is in it because D7a
 * reveals the one side that was written.
 */
export const REVEALED_PAIR_STATUSES: readonly ReviewPairStatus[] = ['REVEALED', 'EXPIRED_PARTIAL'];
