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

// ── Gift codes (M18, campaigns in M19) ───────────────────────────────────────

/**
 * How a code is addressed and how it is shown (ADR-0016).
 *
 * A gift code is a **bearer secret**: whoever holds the string gets the coins.
 * ADR-0015 treated it as an identifier — it routed on it and returned it in every
 * list — and this file is where that is corrected. Everything below addresses a
 * code by `publicId` and shows it as `codeMasked`; the plaintext appears in
 * exactly two responses, both of which are the act of creating it.
 */
export const giftCodeState = z.enum(['SCHEDULED', 'ACTIVE', 'DISABLED', 'EXPIRED', 'EXHAUSTED']);
export type GiftCodeState = z.infer<typeof giftCodeState>;

/**
 * Minting a campaign code the operator chose themselves.
 *
 * Every number that decides what a redemption is worth is here and nowhere else:
 * the coins, the two limits and the window. The Mini App's redeem request carries
 * a string and nothing more, so there is no path by which a user's client can
 * influence any of them (invariant 9).
 *
 * `maxRedemptions` is nullable rather than defaulted to a large number, because
 * "no cap" and "a cap somebody chose" are different facts and an operator reading
 * the list six months from now should be able to tell them apart.
 *
 * `perUserLimit` is capped at **1** (ADR-0016). A campaign is bounded by two
 * numbers and loosening the second collapses them into one: with three per
 * person, one account with a script takes three slots of the global cap, and
 * "500 people get 50 coins" becomes "167 people get 150" at best. The cap is
 * `giftcode.max_per_user_limit` in `app_setting`, so raising it is a recorded
 * decision rather than a deploy — and the *column* is deliberately not
 * constrained, so historical codes above 1 keep working.
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
  /** One, and the service refuses more (ADR-0016). */
  perUserLimit: z.literal(1).default(1),
  startsAt: z.iso.datetime().nullish(),
  expiresAt: z.iso.datetime().nullish(),
  /** Groups codes for the analytics roll-up. Never shown to a user. */
  campaign: z.string().trim().max(80).nullish(),
  /** What this campaign is, for whoever reads the list later. */
  note: z.string().trim().max(280).nullish(),
});
export type CreateGiftCodeRequest = z.infer<typeof createGiftCodeRequest>;

/**
 * Minting N single-use codes at once (M19).
 *
 * There is no `codes` field and there never will be: the codes are drawn on the
 * server with `randomInt`, because a browser's entropy is a page nobody controls,
 * a sequence is enumerable by construction, and `Math.random` is seeded per
 * process — two API replicas minting together would produce the same batch.
 *
 * `count` is bounded here at the same number `giftcode.max_batch_size` defaults
 * to. The setting is what actually decides; this bound exists so an obviously
 * absurd request is refused before it reaches a transaction.
 */
export const bulkCreateGiftCodesRequest = z.object({
  count: z.number().int().positive().max(1000),
  coins: z.number().int().positive().max(100_000),
  /**
   * Prepended to every code — «NOWRUZ» → `NOWRUZ7K2M9QXB`.
   *
   * Normalized and then checked against the code alphabet, because a prefix with
   * an `O` in it reintroduces exactly the ambiguity the alphabet exists to
   * remove: these are read off one screen and typed into another.
   */
  prefix: z.string().trim().max(12).nullish(),
  /** Random characters after the prefix. Twelve unless a campaign says otherwise. */
  length: z.number().int().min(6).max(24).default(12),
  maxRedemptions: z.number().int().positive().max(1_000_000).nullish(),
  perUserLimit: z.literal(1).default(1),
  startsAt: z.iso.datetime().nullish(),
  expiresAt: z.iso.datetime().nullish(),
  /** Mint disabled, for a campaign that is not meant to start yet. */
  isActive: z.boolean().default(true),
  campaign: z.string().trim().max(80).nullish(),
  note: z.string().trim().max(280).nullish(),
});
export type BulkCreateGiftCodesRequest = z.infer<typeof bulkCreateGiftCodesRequest>;

/** Retuning a campaign. Every field optional; every field affects only the future. */
export const updateGiftCodeRequest = z.object({
  coins: z.number().int().positive().max(100_000).optional(),
  maxRedemptions: z.number().int().positive().max(1_000_000).nullish(),
  perUserLimit: z.literal(1).optional(),
  startsAt: z.iso.datetime().nullish(),
  expiresAt: z.iso.datetime().nullish(),
  isActive: z.boolean().optional(),
  campaign: z.string().trim().max(80).nullish(),
  note: z.string().trim().max(280).nullish(),
});
export type UpdateGiftCodeRequest = z.infer<typeof updateGiftCodeRequest>;

export const setGiftCodeActiveRequest = z.object({
  isActive: z.boolean(),
});
export type SetGiftCodeActiveRequest = z.infer<typeof setGiftCodeActiveRequest>;

export const giftCodeListQuery = z.object({
  campaign: z.string().trim().max(80).optional(),
  batchId: z.uuid().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  /**
   * An **exact** code, normalized before lookup — never a prefix.
   *
   * The distinction is the whole design: an operator holding a code a user quoted
   * at them can find its row, and an operator holding nothing cannot enumerate a
   * campaign. `LIKE 'NOW%'` would have handed the campaign over.
   */
  code: z.string().trim().min(4).max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type GiftCodeListQuery = z.infer<typeof giftCodeListQuery>;

/**
 * A campaign as the panel sees it.
 *
 * **No `code`.** `redeemedCount` against `maxRedemptions` is the monitoring
 * surface and it needs no secret to be useful; `codeMasked` is there so an
 * operator can recognise a code somebody quoted at them, and `publicId` is what
 * every action addresses. A stolen admin session can therefore watch every
 * campaign and spend none of them (ADR-0016).
 */
export const giftCodeView = z.object({
  publicId: z.uuid(),
  /** `NOWR••••4F2Z`. Recognisable, never redeemable. */
  codeMasked: z.string(),
  campaign: z.string().nullable(),
  batchId: z.uuid().nullable(),
  coins: z.number().int().positive(),
  maxRedemptions: z.number().int().positive().nullable(),
  perUserLimit: z.number().int().positive(),
  redeemedCount: z.number().int().nonnegative(),
  /** Null when uncapped. Precomputed so no client subtracts and gets it wrong. */
  remainingRedemptions: z.number().int().nonnegative().nullable(),
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  isActive: z.boolean(),
  /**
   * What the three columns and the clock add up to, decided **server-side**.
   *
   * A panel that computed "expired" itself would compare an ISO string against
   * the browser's clock, and invariant 9 says no surface in this product does
   * that. The order matches the order a redemption checks them in, so the badge
   * on the screen and the refusal a user would get are the same fact.
   */
  state: giftCodeState,
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type GiftCodeView = z.infer<typeof giftCodeView>;

export const giftCodeListResponse = z.object({
  codes: z.array(giftCodeView),
  /** How many match the filter, so "is that all of them?" has an answer. */
  total: z.number().int().nonnegative(),
});
export type GiftCodeListResponse = z.infer<typeof giftCodeListResponse>;

/**
 * The one response that carries a plaintext code, and only because the operator
 * typed it themselves — they already have it.
 */
export const createGiftCodeResponse = z.object({
  code: z.string(),
  giftCode: giftCodeView,
});
export type CreateGiftCodeResponse = z.infer<typeof createGiftCodeResponse>;

/**
 * A batch, returned **once**.
 *
 * `codes` is not recoverable afterwards by any endpoint, which is the property
 * that makes bulk minting safe to expose at all: what the panel does not keep, a
 * stolen session cannot read. `warningFa` is carried in the response rather than
 * hardcoded in the panel so that the bot, a script or a future surface cannot
 * show the list without the sentence that explains it.
 */
export const bulkCreateGiftCodesResponse = z.object({
  batchId: z.uuid(),
  campaign: z.string().nullable(),
  codes: z.array(z.string()),
  giftCodes: z.array(giftCodeView),
  warningFa: z.string(),
});
export type BulkCreateGiftCodesResponse = z.infer<typeof bulkCreateGiftCodesResponse>;

// ── Gift-code analytics (M19) ────────────────────────────────────────────────

/**
 * A date window for any of the three analytics reads.
 *
 * Both bounds optional, both ISO-8601 UTC, and neither ever compared against a
 * client's clock — the server resolves them and the server decides (invariant 9,
 * ADR-0008).
 */
export const analyticsWindowQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
export type AnalyticsWindowQuery = z.infer<typeof analyticsWindowQuery>;

/**
 * Everything a person can ask about one campaign.
 *
 * The numbers come from **durable rows**, not from the Prometheus counter:
 * `payetam_gift_code_redemptions_total` resets on deploy, is per-replica, and
 * carries no time, which makes it right for an alert and wrong for a report.
 * Successful redemptions are counted from `gift_code_redemption`, coins are
 * summed from its immutable snapshot, and refusals come from `audit_log`.
 */
export const giftCodeAnalyticsResponse = z.object({
  giftCode: giftCodeView,
  /** Redemptions that produced a ledger row. The financial number. */
  successfulRedemptions: z.number().int().nonnegative(),
  /** Distinct people. Equal to `successfulRedemptions` while the cap is 1. */
  uniqueUsers: z.number().int().nonnegative(),
  /** Summed from the snapshot on each redemption, never from the current config. */
  coinsGranted: z.number().int().nonnegative(),
  failedAttempts: z.number().int().nonnegative(),
  /** `invalid` · `expired` · `already_redeemed` · `exhausted` · `error`. */
  failuresByReason: z.record(z.string(), z.number().int().nonnegative()),
  firstRedeemedAt: z.iso.datetime().nullable(),
  lastRedeemedAt: z.iso.datetime().nullable(),
  /** One row per UTC day that saw a redemption, oldest first. */
  trend: z.array(
    z.object({
      day: z.string(),
      redemptions: z.number().int().nonnegative(),
      coins: z.number().int().nonnegative(),
    }),
  ),
});
export type GiftCodeAnalyticsResponse = z.infer<typeof giftCodeAnalyticsResponse>;

export const campaignSummaryView = z.object({
  campaign: z.string(),
  codes: z.number().int().nonnegative(),
  activeCodes: z.number().int().nonnegative(),
  redemptions: z.number().int().nonnegative(),
  coinsGranted: z.number().int().nonnegative(),
  uniqueUsers: z.number().int().nonnegative(),
  firstRedeemedAt: z.iso.datetime().nullable(),
  lastRedeemedAt: z.iso.datetime().nullable(),
});
export type CampaignSummaryView = z.infer<typeof campaignSummaryView>;

export const campaignListResponse = z.object({
  campaigns: z.array(campaignSummaryView),
});
export type CampaignListResponse = z.infer<typeof campaignListResponse>;

/**
 * One redemption, as the panel lists it.
 *
 * `coins` is read from the redemption row and not from the code, which is the
 * whole point of the snapshot: a campaign retuned from 50 to 80 shows 50 against
 * the redemptions that happened at 50, and the panel can *prove* that changing
 * configuration did not rewrite history (ADR-0016).
 *
 * A user is a `publicId` and nothing else. Not a display name, not a Telegram
 * anything: a list of who took a promotion is not a reason to project profiles.
 */
export const giftCodeRedemptionView = z.object({
  userPublicId: z.uuid(),
  seq: z.number().int().positive(),
  coins: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type GiftCodeRedemptionView = z.infer<typeof giftCodeRedemptionView>;

export const giftCodeRedemptionsResponse = z.object({
  redemptions: z.array(giftCodeRedemptionView),
  total: z.number().int().nonnegative(),
});
export type GiftCodeRedemptionsResponse = z.infer<typeof giftCodeRedemptionsResponse>;

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

// ── Referral review (M19) ────────────────────────────────────────────────────

/**
 * Why a referral was refused.
 *
 * A code rather than free text, so it can be counted ("how many do we reject for
 * velocity?") and rendered in Persian to the person it happened to. The free-text
 * half is `reviewNote`, which stays on the admin surface — telling a suspected
 * farmer which signal fired is telling them what to change.
 */
export const referralRejectionReason = z.enum([
  'SELF_REFERRAL',
  'DUPLICATE',
  'INVALID_CODE',
  'FRAUD',
  'INELIGIBLE',
  'ADMIN_DECISION',
]);
export type ReferralRejectionReasonView = z.infer<typeof referralRejectionReason>;

export const referralStatus = z.enum(['PENDING', 'QUALIFIED', 'REJECTED']);
export type ReferralStatusView = z.infer<typeof referralStatus>;

/**
 * A referral as the review queue shows it.
 *
 * Two people by `publicId` and nothing else. Reviewing a referral for fraud is a
 * question about *behaviour* — how many, how fast, from where — and a display
 * name answers none of it while putting two profiles on a screen with no reason
 * to show them.
 */
export const referralReviewView = z.object({
  id: z.uuid(),
  referrerPublicId: z.uuid(),
  referredPublicId: z.uuid(),
  status: referralStatus,
  /** Whether a velocity or pattern signal fired (T6). The queue sorts on this. */
  flagged: z.boolean(),
  /** The signals themselves. Admin-only, and never projected to either user. */
  fraudSignals: z.unknown().nullable(),
  qualifiedAt: z.iso.datetime().nullable(),
  rejectedAt: z.iso.datetime().nullable(),
  rejectionReason: referralRejectionReason.nullable(),
  /** Internal free text, for the next moderator. Same rule as `fraudSignals`. */
  reviewNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ReferralReviewView = z.infer<typeof referralReviewView>;

export const referralListQuery = z.object({
  status: referralStatus.optional(),
  /** The queue a moderator actually works: only the ones a signal fired on. */
  flagged: z.enum(['true', 'false']).optional(),
  referrerPublicId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type ReferralListQuery = z.infer<typeof referralListQuery>;

export const referralListResponse = z.object({
  referrals: z.array(referralReviewView),
  total: z.number().int().nonnegative(),
});
export type ReferralListResponse = z.infer<typeof referralListResponse>;

/**
 * Refusing a referral, in writing.
 *
 * Both fields mandatory. §7's rule for a moderation case is that a terminal state
 * needs a signature and an explanation, and this is the other terminal decision
 * in the product that withholds money — a rejection nobody signed and nobody
 * explained is not reviewable six weeks later.
 */
export const rejectReferralRequest = z.object({
  reason: referralRejectionReason,
  note: z.string().trim().min(5).max(1000),
});
export type RejectReferralRequest = z.infer<typeof rejectReferralRequest>;

/**
 * Putting a rejected referral back.
 *
 * **This pays nobody.** It restores `PENDING`, and the referral then earns its
 * reward the ordinary way — the attendance condition is still checked by
 * `ReferralService` and the payout is still guarded by an idempotency key. There
 * is deliberately no route from `REJECTED` to `QUALIFIED`: an admin may restore a
 * chance and may not grant a reward.
 */
export const reinstateReferralRequest = z.object({
  note: z.string().trim().min(5).max(1000),
});
export type ReinstateReferralRequest = z.infer<typeof reinstateReferralRequest>;
