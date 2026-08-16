import type { OwnReview, PendingReview, RevealedReview } from '@payetam/domain';
import type {
  OwnReviewView,
  PendingReviewView,
  RevealedReviewView,
  ReviewTag,
} from '@payetam/shared';

/**
 * Maps reviews to the wire shape.
 *
 * Field by field, never a spread — §3.6 layer 2. The row carries
 * `reviewer_user_id` and `reviewee_user_id`, both internal, and a spread would put
 * them on the wire the moment somebody widened a `select`. On the public read the
 * reviewer is absent by design: a reader is entitled to know what was said about
 * this person, not who said it.
 *
 * `tags` is narrowed to the published vocabulary here rather than trusted from the
 * column. The column is `TEXT[]`, so a row written before a tag was retired — or
 * by a future admin tool — could carry a value the client has no rendering for.
 */
export function toPendingReviewView(review: PendingReview): PendingReviewView {
  return {
    participantPublicId: review.participantPublicId,
    eventPublicId: review.eventPublicId,
    eventTitle: review.eventTitle,
    revieweePublicId: review.revieweePublicId,
    revieweeDisplayName: review.revieweeDisplayName,
    role: review.role,
    opensAt: review.opensAt.toISOString(),
    deadlineAt: review.deadlineAt.toISOString(),
  };
}

export function toOwnReviewView(review: OwnReview): OwnReviewView {
  return {
    publicId: review.publicId,
    participantPublicId: review.participantPublicId,
    rating: review.rating,
    tags: review.tags as ReviewTag[],
    comment: review.comment,
    submittedAt: review.submittedAt.toISOString(),
    editableUntil: review.editableUntil?.toISOString() ?? null,
    revealed: review.revealed,
  };
}

export function toRevealedReviewView(review: RevealedReview): RevealedReviewView {
  return {
    publicId: review.publicId,
    rating: review.rating,
    tags: review.tags as ReviewTag[],
    comment: review.comment,
    submittedAt: review.submittedAt.toISOString(),
    revealedAt: review.revealedAt?.toISOString() ?? null,
    withoutCounterpart: review.withoutCounterpart,
  };
}
