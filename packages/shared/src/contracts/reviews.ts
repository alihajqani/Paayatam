import { z } from 'zod';

/**
 * Review contracts (M11, ADR-0011 D7/D7a).
 *
 * The shape worth noticing is what is **absent**. A revealed review carries no
 * reviewer: on a public profile the reader is entitled to know what was said about
 * this person, not who said it. The author's own read is a different endpoint with
 * a different shape, because it answers a different question.
 *
 * There is no contract anywhere in this file for "the counterparty's review before
 * reveal". That is not an omission — it is the feature.
 */

export const reviewerRole = z.enum(['HOST', 'GUEST']);
export type ReviewerRole = z.infer<typeof reviewerRole>;

/**
 * The tag vocabulary, fixed rather than free text.
 *
 * A closed list needs no moderation and no normalisation, and it makes ratings
 * comparable across reviewers in a way free text never is. Free text still exists,
 * in `comment`, and that is the field moderation reads.
 */
export const reviewTag = z.enum([
  'PUNCTUAL',
  'FRIENDLY',
  'GOOD_CONVERSATION',
  'WELL_ORGANISED',
  'AS_DESCRIBED',
  'WOULD_MEET_AGAIN',
  'LATE',
  'UNCOMMUNICATIVE',
]);
export type ReviewTag = z.infer<typeof reviewTag>;

export const submitReviewRequest = z.object({
  rating: z.number().int().min(1).max(5),
  tags: z.array(reviewTag).max(5).default([]),
  comment: z.string().trim().min(1).max(500).optional(),
});
export type SubmitReviewRequest = z.infer<typeof submitReviewRequest>;

/** A review the caller still owes somebody, and by when. */
export const pendingReviewView = z.object({
  participantPublicId: z.string(),
  eventPublicId: z.string(),
  eventTitle: z.string(),
  /**
   * Who the caller would be reviewing. Named, because by this point the two of
   * them have met — the anonymity boundary ends at the meeting, by design
   * (ADR-0009), and a review of «میهمان ۲» would be useless to write.
   */
  revieweePublicId: z.string(),
  revieweeDisplayName: z.string(),
  role: reviewerRole,
  opensAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
});
export type PendingReviewView = z.infer<typeof pendingReviewView>;

export const pendingReviewsResponse = z.object({
  reviews: z.array(pendingReviewView),
});
export type PendingReviewsResponse = z.infer<typeof pendingReviewsResponse>;

/** What the caller wrote, which is always theirs to read back. */
export const ownReviewView = z.object({
  publicId: z.string(),
  participantPublicId: z.string(),
  rating: z.number().int().min(1).max(5),
  tags: z.array(reviewTag),
  comment: z.string().nullable(),
  submittedAt: z.iso.datetime(),
  /**
   * Null once it can no longer be changed — the hour has passed, or the pair has
   * revealed. Editing after reveal is refused even inside the hour, because once
   * the other side can see it, an edit is a reply.
   */
  editableUntil: z.iso.datetime().nullable(),
  revealed: z.boolean(),
});
export type OwnReviewView = z.infer<typeof ownReviewView>;

/**
 * A review as the world sees it.
 *
 * No reviewer field, deliberately.
 */
export const revealedReviewView = z.object({
  publicId: z.string(),
  rating: z.number().int().min(1).max(5),
  tags: z.array(reviewTag),
  comment: z.string().nullable(),
  submittedAt: z.iso.datetime(),
  revealedAt: z.iso.datetime().nullable(),
  /**
   * D7a: «بدون بازخورد متقابل». True when the deadline revealed this one because
   * the other side never wrote. Marked rather than hidden, so a reader can weigh
   * it knowing it was never answered.
   */
  withoutCounterpart: z.boolean(),
});
export type RevealedReviewView = z.infer<typeof revealedReviewView>;

export const userReviewsResponse = z.object({
  reviews: z.array(revealedReviewView),
  /** Across revealed reviews only, so it cannot leak an unrevealed rating. */
  averageRating: z.number().nullable(),
  count: z.number().int().nonnegative(),
});
export type UserReviewsResponse = z.infer<typeof userReviewsResponse>;
