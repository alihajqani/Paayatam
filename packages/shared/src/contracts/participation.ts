import { z } from 'zod';

/**
 * Participation contracts (M6).
 *
 * Notably thin on the request side: joining takes no body at all, and neither
 * does accepting or rejecting. Everything that decides the outcome — who is
 * asking, whether a seat is free, whether the event's restrictions admit them —
 * is resolved on the server from the server's own copy of the facts. There is no
 * field here for a client to be wrong or dishonest about (invariant 9).
 */

export const participantStatus = z.enum([
  'PENDING',
  'WAITLISTED',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED_BY_PARTICIPANT',
  'CANCELLED_BY_HOST',
  'COMPLETED',
  'NO_SHOW',
]);
export type ParticipantStatus = z.infer<typeof participantStatus>;

export const cancellationBucket = z.enum(['GRACE', 'GT_24H', 'H24_TO_H3', 'LT_3H', 'NO_SHOW']);
export type CancellationBucket = z.infer<typeof cancellationBucket>;

/**
 * The one piece of input in the module, and it is optional.
 *
 * Free text, so it is capped and it is the participant's own words about
 * themselves — it stays on the row and never reaches the audit trail admins read
 * (ADR-0009).
 */
export const cancelParticipationRequest = z.object({
  reason: z.string().trim().min(1).max(280).optional(),
});
export type CancelParticipationRequest = z.infer<typeof cancelParticipationRequest>;

/** What a participant sees about their own request. */
export const participationView = z.object({
  publicId: z.string(),
  eventPublicId: z.string(),
  status: participantStatus,
  requestedAt: z.iso.datetime(),
  /** When the host's window to decide runs out. Null while waitlisted. */
  hostDeadlineAt: z.iso.datetime().nullable(),
  /** Cancel before this and it costs nothing. Null until accepted. */
  graceExpiresAt: z.iso.datetime().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  cancellationBucket: cancellationBucket.nullable(),
  /** 1-based place in the queue, present only while WAITLISTED. */
  waitlistRank: z.number().int().positive().nullable(),
  /**
   * The anonymous chat this request opened (plan §3.4).
   *
   * Present from the request, not from the acceptance: talking to a stranger
   * before either side has committed to anything is what the product is for.
   */
  chatPublicId: z.string().nullable(),
});
export type ParticipationView = z.infer<typeof participationView>;

export const myParticipationsResponse = z.object({
  participations: z.array(participationView),
});
export type MyParticipationsResponse = z.infer<typeof myParticipationsResponse>;

/**
 * What the host sees about somebody who asked to join.
 *
 * A public id and a display name, and nothing else about the person. The host of
 * an event is not entitled to a stranger's profile just because that stranger
 * asked to come (§3.6 layer 2).
 */
export const participantSummaryView = z.object({
  publicId: z.string(),
  userPublicId: z.string(),
  displayName: z.string(),
  status: participantStatus,
  requestedAt: z.iso.datetime(),
  hostDeadlineAt: z.iso.datetime().nullable(),
  waitlistRank: z.number().int().positive().nullable(),
});
export type ParticipantSummaryView = z.infer<typeof participantSummaryView>;

export const eventParticipantsResponse = z.object({
  participants: z.array(participantSummaryView),
});
export type EventParticipantsResponse = z.infer<typeof eventParticipantsResponse>;
