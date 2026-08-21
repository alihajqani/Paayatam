import { z } from 'zod';

/**
 * Admin and reporting contracts (M12, ADR-0010).
 *
 * The admin surface is a **separate API** from the Mini App's — a different base
 * path, a different session mechanism, a different identity system. These schemas
 * live beside the others because they are still the FE↔BE contract the panel is
 * built against, but nothing here is reachable with a Mini App token.
 */

// ── Reporting, which is a *user* action ──────────────────────────────────────

export const reportReason = z.enum([
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE',
  'SCAM',
  'IMPERSONATION',
  'SAFETY',
  'OTHER',
]);
export type ReportReason = z.infer<typeof reportReason>;

export const reportTargetType = z.enum(['EVENT', 'USER', 'MESSAGE', 'REVIEW']);
export type ReportTargetType = z.infer<typeof reportTargetType>;

export const fileReportRequest = z.object({
  reason: reportReason,
  /** Optional free text. Read by a moderator, never shown to the person reported. */
  description: z.string().trim().min(1).max(1000).optional(),
});
export type FileReportRequest = z.infer<typeof fileReportRequest>;

/**
 * What a reporter is told back.
 *
 * `triggeredReview` says whether this report was the one that crossed the
 * threshold — which the client uses to say "thank you, this is now with our team"
 * rather than the vaguer acknowledgement. It says nothing about who else reported,
 * or how many: a count would let somebody probe how close a rival's event is to
 * being hidden.
 */
export const fileReportResponse = z.object({
  publicId: z.string(),
  status: z.literal('OPEN'),
  triggeredReview: z.boolean(),
});
export type FileReportResponse = z.infer<typeof fileReportResponse>;

// ── Admin authentication ─────────────────────────────────────────────────────

export const adminLoginRequest = z.object({
  email: z.email().max(255),
  /** Length only. Composition rules push people towards `Password1!` (ADR-0010). */
  password: z.string().min(12).max(200),
  /** Mandatory, never optional (D11). */
  totpCode: z.string().regex(/^\d{6}$/),
});
export type AdminLoginRequest = z.infer<typeof adminLoginRequest>;

export const adminSessionView = z.object({
  email: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  /**
   * The caller's own capabilities, so the panel can hide what it cannot do.
   *
   * Hiding is a courtesy, never the control: every one of these is checked again
   * in the service layer, because a client that omits a button is not a client
   * that cannot send the request.
   */
  permissions: z.array(z.string()),
});
export type AdminSessionView = z.infer<typeof adminSessionView>;

export const adminLoginResponse = z.object({
  /** Echoed in a header on every mutating request; the session rides in a cookie. */
  csrfToken: z.string(),
  session: adminSessionView,
});
export type AdminLoginResponse = z.infer<typeof adminLoginResponse>;

// ── Moderation queue ─────────────────────────────────────────────────────────

export const moderationCaseStatus = z.enum([
  'OPEN',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'ESCALATED',
]);
export type ModerationCaseStatus = z.infer<typeof moderationCaseStatus>;

export const moderationCaseView = z.object({
  id: z.string(),
  subjectType: reportTargetType,
  subjectId: z.string(),
  status: moderationCaseStatus,
  trigger: z.string(),
  reportCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type ModerationCaseView = z.infer<typeof moderationCaseView>;

export const moderationQueueResponse = z.object({
  cases: z.array(moderationCaseView),
});
export type ModerationQueueResponse = z.infer<typeof moderationQueueResponse>;

export const decideCaseRequest = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  /** §7: a terminal state needs `decided_by` **and** `decision_note`. */
  note: z.string().trim().min(3).max(1000),
  /**
   * Set when the automation was wrong. This is what turns ADR-0012's
   * false-positive rate into a number rather than an impression.
   */
  falsePositive: z.boolean().optional(),
});
export type DecideCaseRequest = z.infer<typeof decideCaseRequest>;

// ── Economy adjustments ──────────────────────────────────────────────────────

/**
 * A hand-written balance change.
 *
 * `reference` is the caller's idempotency key: a retried request is one adjustment
 * rather than two. Requiring it from the client rather than generating one here is
 * deliberate — only the caller knows whether this is a retry.
 */
export const adjustCoinsRequest = z.object({
  userPublicId: z.uuid(),
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, 'amount must not be zero'),
  reason: z.string().trim().min(5).max(500),
  reference: z.string().trim().min(8).max(128),
});
export type AdjustCoinsRequest = z.infer<typeof adjustCoinsRequest>;

export const adjustTrustRequest = z.object({
  userPublicId: z.uuid(),
  delta: z
    .number()
    .int()
    .refine((value) => value !== 0, 'delta must not be zero'),
  reason: z.string().trim().min(5).max(500),
  reference: z.string().trim().min(8).max(128),
});
export type AdjustTrustRequest = z.infer<typeof adjustTrustRequest>;

export const setUserStatusRequest = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']),
  reason: z.string().trim().min(5).max(500),
});
export type SetUserStatusRequest = z.infer<typeof setUserStatusRequest>;

// ── Break-glass (T14) ────────────────────────────────────────────────────────

/**
 * The reason is required by the schema, by the service and by a CHECK on the
 * column. Three layers for one field, because this is the field that makes an
 * unseal reviewable afterwards — and a reason nobody has to write is a reason
 * nobody writes.
 */
export const unsealChatRequest = z.object({
  reason: z.string().trim().min(10).max(500),
});
export type UnsealChatRequest = z.infer<typeof unsealChatRequest>;

export const unsealGrantResponse = z.object({
  grantId: z.string(),
  chatPublicId: z.string(),
  expiresAt: z.iso.datetime(),
});
export type UnsealGrantResponse = z.infer<typeof unsealGrantResponse>;

/** A conversation as a moderator reads it: aliases, never identities. */
export const unsealedMessageView = z.object({
  seq: z.number().int(),
  senderAlias: z.string().nullable(),
  kind: z.string(),
  body: z.string(),
  sentAt: z.iso.datetime(),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
});
export type UnsealedMessageView = z.infer<typeof unsealedMessageView>;

export const unsealedChatResponse = z.object({
  messages: z.array(unsealedMessageView),
});
export type UnsealedChatResponse = z.infer<typeof unsealedChatResponse>;

// ── Roles (four-eyes) ────────────────────────────────────────────────────────

export const roleKey = z.enum(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ANALYST']);
export type RoleKeyView = z.infer<typeof roleKey>;

export const requestRoleChangeRequest = z.object({
  subjectAdminId: z.uuid(),
  roleKey,
  granting: z.boolean(),
  reason: z.string().trim().min(5).max(500),
});
export type RequestRoleChangeRequest = z.infer<typeof requestRoleChangeRequest>;

export const auditEntryView = z.object({
  action: z.string(),
  actorType: z.string(),
  targetType: z.string(),
  createdAt: z.iso.datetime(),
});
export type AuditEntryView = z.infer<typeof auditEntryView>;

export const auditLogResponse = z.object({
  entries: z.array(auditEntryView),
});
export type AuditLogResponse = z.infer<typeof auditLogResponse>;

// ── Gift codes (M18) ─────────────────────────────────────────────────────────

/**
 * Minting a campaign code.
 *
 * Every number that decides what a redemption is worth is here and nowhere else:
 * the coins, the two limits and the window. The Mini App's redeem request carries
 * a string and nothing more, so there is no path by which a user's client can
 * influence any of them (invariant 9).
 *
 * `maxRedemptions` is nullable rather than defaulted to a large number, because
 * "no cap" and "a cap somebody chose" are different facts and an operator reading
 * the list six months from now should be able to tell them apart.
 */
export const createGiftCodeRequest = z.object({
  /**
   * Normalized server-side — upper-cased, spaces and dashes removed — so the
   * operator who types «summer-24» and the user who types «SUMMER24» mean one
   * code. Bounded rather than pattern-matched for the same reason the referral
   * claim is.
   */
  code: z.string().trim().min(4).max(32),
  coins: z.number().int().positive().max(100_000),
  /** Null or absent is unlimited. */
  maxRedemptions: z.number().int().positive().max(1_000_000).nullish(),
  /** How many one person may take. One unless a campaign says otherwise. */
  perUserLimit: z.number().int().positive().max(100).default(1),
  startsAt: z.iso.datetime().nullish(),
  expiresAt: z.iso.datetime().nullish(),
  /** What this campaign is, for whoever reads the list later. */
  note: z.string().trim().max(280).nullish(),
});
export type CreateGiftCodeRequest = z.infer<typeof createGiftCodeRequest>;

export const setGiftCodeActiveRequest = z.object({
  isActive: z.boolean(),
});
export type SetGiftCodeActiveRequest = z.infer<typeof setGiftCodeActiveRequest>;

/**
 * A campaign as the panel sees it.
 *
 * `redeemedCount` against `maxRedemptions` is the monitoring surface: it is how an
 * operator sees a campaign being drained, and it is a column maintained under the
 * same row lock the redemption takes rather than a count computed on read.
 */
export const giftCodeView = z.object({
  code: z.string(),
  coins: z.number().int().positive(),
  maxRedemptions: z.number().int().positive().nullable(),
  perUserLimit: z.number().int().positive(),
  redeemedCount: z.number().int().nonnegative(),
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  isActive: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type GiftCodeView = z.infer<typeof giftCodeView>;

export const giftCodeListResponse = z.object({
  codes: z.array(giftCodeView),
});
export type GiftCodeListResponse = z.infer<typeof giftCodeListResponse>;
