import { z } from 'zod';
import { policyType } from './auth';

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

/**
 * What `POST /auth/login` and `GET /me` both answer with.
 *
 * One shape for both, because the panel needs the same two things in both cases:
 * who it is signed in as, and the token to echo. A reloaded tab has the cookie
 * and no token — the token is deliberately never persisted client-side — so `/me`
 * is what restores its ability to mutate. Returning it on an authenticated
 * same-origin GET is the ordinary synchroniser-token delivery: a cross-site page
 * can cause the request and can never read the response.
 */
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

// ── The panel's read surface (M19) ───────────────────────────────────────────

/**
 * The ledger types, restated here rather than imported from `economy.ts`.
 *
 * The two files are separate contracts for separate audiences — the Mini App
 * reads one and only the panel reads the other — and `errors.test.ts`'s
 * discipline applies: a value added to one and not the other is a mismatch a
 * reviewer can see, where a shared import would silently widen the admin filter
 * the moment somebody added a type for a different reason.
 */
const coinLedgerTypeForAdmin = z.enum([
  'ONBOARDING_REWARD',
  'REFERRAL_REWARD',
  'REVIEW_REWARD',
  'GIFT_CODE_REDEEM',
  'BOOST_SPEND',
  'VIP_SPEND',
  'EVENT_CREATE_SPEND',
  'CHANNEL_POST_SPEND',
  'INVITE_SPEND',
  'CANCELLATION_PENALTY',
  'NO_SHOW_PENALTY',
  'HOST_CANCELLATION_REFUND',
  'ADMIN_ADJUSTMENT',
  'REVERSAL',
]);

/**
 * A `{ status: count }` roll-up.
 *
 * Sparse on purpose: a status with no rows is **absent** rather than zero,
 * because inventing zeros would mean the panel could not tell "nobody is
 * waitlisted" from "this deployment has no waitlist". The screen fills the gaps
 * it wants to show.
 */
export const tally = z.record(z.string(), z.number().int().nonnegative());
export type Tally = z.infer<typeof tally>;

export const adminDashboardResponse = z.object({
  users: z.object({
    total: z.number().int().nonnegative(),
    byStatus: tally,
    newLast7Days: z.number().int().nonnegative(),
    /** Somebody who *did* something, not somebody who exists. */
    activeLast7Days: z.number().int().nonnegative(),
  }),
  events: z.object({ total: z.number().int().nonnegative(), byStatus: tally }),
  participations: z.object({ byStatus: tally }),
  chats: z.object({ byStatus: tally }),
  reports: z.object({ byStatus: tally }),
  cases: z.object({ byStatus: tally }),
  economy: z.object({
    /** What users hold right now: `SUM(coin_account.balance)`. */
    coinsHeld: z.number().int(),
    coinsGranted: z.number().int(),
    /** A magnitude, because «۴۰۰ سکه خرج شد» reads and «−۴۰۰» does not. */
    coinsSpent: z.number().int().nonnegative(),
    ledgerLast24h: z.number().int().nonnegative(),
  }),
  referrals: z.object({ byStatus: tally, flagged: z.number().int().nonnegative() }),
  giftCodes: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    redemptions: z.number().int().nonnegative(),
    coinsGranted: z.number().int().nonnegative(),
    /** From `audit_log`, not from the counter — see ADR-0016 §5. */
    failedAttemptsLast24h: z.number().int().nonnegative(),
  }),
  moderationBacklog: z.object({
    openCases: z.number().int().nonnegative(),
    openReports: z.number().int().nonnegative(),
    /** How long the queue's oldest item has been waiting. Null when it is empty. */
    oldestOpenCaseAt: z.iso.datetime().nullable(),
  }),
  /** Live dependency state, so the panel is also the "is it up?" screen. */
  health: z.object({
    database: z.enum(['up', 'down']),
    redis: z.enum(['up', 'down']),
  }),
});
export type AdminDashboardResponse = z.infer<typeof adminDashboardResponse>;

export const userStatus = z.enum(['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED']);
export type UserStatusView = z.infer<typeof userStatus>;

/**
 * A user as the panel lists them.
 *
 * `trustScore` is nullable and **null is not zero** (ADR-0014): the row is
 * written lazily by the first movement, so an account that has done nothing has
 * none, and 0 is the worst possible reputation shown to somebody who earned no
 * reputation at all. `coinBalance` is genuinely 0 in the same situation, because
 * an account with no movements holds no coins.
 *
 * There is no Telegram anything here, and no path to one: answering "who is this
 * really?" is break-glass with an open case and a written reason (T14).
 */
export const adminUserView = z.object({
  publicId: z.uuid(),
  displayName: z.string().nullable(),
  status: userStatus,
  onboardingState: z.string(),
  trustScore: z.number().int().min(0).max(100).nullable(),
  coinBalance: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type AdminUserView = z.infer<typeof adminUserView>;

export const adminUserDetailView = adminUserView.extend({
  cityNameFa: z.string().nullable(),
  districtNameFa: z.string().nullable(),
  birthYear: z.number().int().nullable(),
  /**
   * The bio with contact details **masked** — «حذف شد» in place of a phone
   * number, an `@handle`, a `t.me/` link or an email.
   *
   * A user who typed their number into their bio has not consented to hand it to
   * staff, and the bio reaches no other user anywhere in the product — so an
   * unmasked one here would be the only place those digits are ever projected.
   * The leak scan found this the day the screen was added.
   */
  bio: z.string().nullable(),
  /** How many fragments the masking removed, so a moderator knows it happened. */
  bioRedactions: z.number().int().nonnegative(),
  coins: z.object({
    granted: z.number().int().nonnegative(),
    spent: z.number().int().nonnegative(),
    entries: z.number().int().nonnegative(),
  }),
  referrals: z.object({
    made: z.number().int().nonnegative(),
    qualified: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    receivedStatus: z.string().nullable(),
  }),
  events: z.object({
    hosted: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
  }),
  participations: tally,
  reportsAgainst: z.number().int().nonnegative(),
  reportsFiled: z.number().int().nonnegative(),
  giftCodeRedemptions: z.object({
    count: z.number().int().nonnegative(),
    coins: z.number().int().nonnegative(),
  }),
});
export type AdminUserDetailView = z.infer<typeof adminUserDetailView>;

export const adminUserListQuery = z.object({
  /** A display name, or a `publicId` pasted from a report. */
  query: z.string().trim().min(1).max(120).optional(),
  status: userStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type AdminUserListQuery = z.infer<typeof adminUserListQuery>;

export const adminUserListResponse = z.object({
  users: z.array(adminUserView),
  total: z.number().int().nonnegative(),
});
export type AdminUserListResponse = z.infer<typeof adminUserListResponse>;

export const adminEventStatus = z.enum([
  'DRAFT',
  'PENDING_MODERATION',
  'PUBLISHED',
  'HIDDEN',
  'REJECTED',
  'CANCELLED_BY_HOST',
  'ONGOING',
  'COMPLETED',
  'EXPIRED',
  'DELETED',
]);
export type AdminEventStatus = z.infer<typeof adminEventStatus>;

export const adminEventView = z.object({
  publicId: z.uuid(),
  title: z.string(),
  status: adminEventStatus,
  moderationStatus: z.string(),
  hostPublicId: z.uuid(),
  hostDisplayName: z.string().nullable(),
  cityNameFa: z.string(),
  startsAt: z.iso.datetime(),
  capacity: z.number().int().positive(),
  acceptedCount: z.number().int().nonnegative(),
  requestCount: z.number().int().nonnegative(),
  /** Open reports against this event, counted in one grouped query per page. */
  reportCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type AdminEventView = z.infer<typeof adminEventView>;

export const adminEventListQuery = z.object({
  query: z.string().trim().min(1).max(120).optional(),
  status: adminEventStatus.optional(),
  hostPublicId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type AdminEventListQuery = z.infer<typeof adminEventListQuery>;

export const adminEventListResponse = z.object({
  events: z.array(adminEventView),
  total: z.number().int().nonnegative(),
});
export type AdminEventListResponse = z.infer<typeof adminEventListResponse>;

/**
 * Hiding or restoring an event directly, without a case.
 *
 * Both directions go through `assertEventTransition`, so this is not a back door
 * around the lifecycle: an event the host already cancelled is not resurrected by
 * a moderator agreeing with a complaint about it.
 */
export const moderateEventRequest = z.object({
  action: z.enum(['HIDE', 'PUBLISH', 'REJECT']),
  reason: z.string().trim().min(5).max(500),
});
export type ModerateEventRequest = z.infer<typeof moderateEventRequest>;

export const reportStatus = z.enum(['OPEN', 'ACTIONED', 'DISMISSED']);
export type ReportStatusView = z.infer<typeof reportStatus>;

export const adminReportView = z.object({
  publicId: z.uuid(),
  targetType: reportTargetType,
  targetId: z.string(),
  reason: reportReason,
  description: z.string().nullable(),
  status: reportStatus,
  moderationCaseId: z.string().nullable(),
  /** The reporter, as a public id. Never shown to the reported party. */
  reporterPublicId: z.uuid(),
  createdAt: z.iso.datetime(),
});
export type AdminReportView = z.infer<typeof adminReportView>;

export const adminReportListQuery = z.object({
  status: reportStatus.optional(),
  targetType: reportTargetType.optional(),
  targetId: z.string().max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type AdminReportListQuery = z.infer<typeof adminReportListQuery>;

export const adminReportListResponse = z.object({
  reports: z.array(adminReportView),
  total: z.number().int().nonnegative(),
});
export type AdminReportListResponse = z.infer<typeof adminReportListResponse>;

export const decideReportRequest = z.object({
  status: z.enum(['ACTIONED', 'DISMISSED']),
  note: z.string().trim().min(3).max(1000),
});
export type DecideReportRequest = z.infer<typeof decideReportRequest>;

/**
 * One coin ledger row, as the panel reads it.
 *
 * Immutable by construction rather than by permission: `coin_ledger` carries a
 * `BEFORE UPDATE OR DELETE` trigger, so there is no writing path to withhold.
 * `metadata` is deliberately **not** projected — it is a per-type bag, and
 * showing it would make every future writer's choice of contents a disclosure
 * decision made by somebody who was thinking about something else.
 */
export const adminLedgerEntryView = z.object({
  userPublicId: z.uuid(),
  amount: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  type: coinLedgerTypeForAdmin,
  reasonCode: z.string(),
  actorType: z.string(),
  refType: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminLedgerEntryView = z.infer<typeof adminLedgerEntryView>;

export const adminLedgerQuery = z.object({
  userPublicId: z.uuid().optional(),
  type: coinLedgerTypeForAdmin.optional(),
  reasonCode: z.string().trim().max(64).optional(),
  refType: z.string().trim().max(32).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type AdminLedgerQuery = z.infer<typeof adminLedgerQuery>;

export const adminLedgerResponse = z.object({
  entries: z.array(adminLedgerEntryView),
  total: z.number().int().nonnegative(),
  /** Summed over the whole filter, not the page. "What did this cost us?" */
  net: z.number().int(),
});
export type AdminLedgerResponse = z.infer<typeof adminLedgerResponse>;

/**
 * ADR-0007's invariant, asked of the live database.
 *
 * `drifted` rather than a boolean, because "reconciliation failed" is not
 * something anybody can act on. An empty array is the healthy answer.
 */
export const reconciliationResponse = z.object({
  accounts: z.number().int().nonnegative(),
  drifted: z.array(
    z.object({
      userPublicId: z.uuid(),
      balance: z.number().int(),
      ledger: z.number().int(),
    }),
  ),
});
export type ReconciliationResponse = z.infer<typeof reconciliationResponse>;

/**
 * One audit row, with its payloads.
 *
 * `before` and `after` are shown as stored. They are an allowlist at every call
 * site by `AuditService`'s contract — never a spread of an entity — which is what
 * makes showing them safe, and is why nothing in this product ever put a gift
 * code or a Telegram id into one.
 */
export const adminAuditEntryView = z.object({
  id: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminAuditEntryView = z.infer<typeof adminAuditEntryView>;

export const adminAuditQuery = z.object({
  actorId: z.string().trim().max(64).optional(),
  actorType: z.enum(['USER', 'ADMIN', 'SYSTEM']).optional(),
  /** A prefix, so `giftcode.` finds all six actions without naming them. */
  action: z.string().trim().max(64).optional(),
  targetType: z.string().trim().max(64).optional(),
  targetId: z.string().trim().max(64).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type AdminAuditQuery = z.infer<typeof adminAuditQuery>;

export const adminAuditResponse = z.object({
  entries: z.array(adminAuditEntryView),
  total: z.number().int().nonnegative(),
});
export type AdminAuditResponse = z.infer<typeof adminAuditResponse>;

/**
 * One policy number, with the default behind it.
 *
 * `defaultValue` travels with the current value so the panel can say
 * «تغییر داده‌شده» rather than making an operator remember what §11 says. The list
 * is driven by the code catalogue, not by the table: a key in the database and
 * not in the code is a leftover nothing reads, and showing it would invite
 * somebody to tune it.
 */
// ── Legal documents (M22 phase 8) ────────────────────────────────────────────

export const policyStatus = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']);
export type PolicyStatusView = z.infer<typeof policyStatus>;

/**
 * One legal version as the panel reads it.
 *
 * `contentMd` is included even in the list, because a legal document is short and
 * the screen that lists versions is the screen somebody compares them on. The
 * alternative — a second fetch per row — would make "what changed?" a chore.
 */
export const adminPolicyView = z.object({
  id: z.uuid(),
  type: policyType,
  version: z.number().int().positive(),
  status: policyStatus,
  titleFa: z.string().nullable(),
  contentMd: z.string(),
  summaryFa: z.string().nullable(),
  changeSummaryFa: z.string().nullable(),
  isCurrent: z.boolean(),
  /** Optimistic-concurrency token. Echo it back on an edit or the write is refused. */
  revision: z.number().int().nonnegative(),
  createdByAdminId: z.uuid().nullable(),
  publishedByAdminId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  publishedAt: z.iso.datetime().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  /** How many people have accepted this exact version. */
  acceptanceCount: z.number().int().nonnegative(),
});
export type AdminPolicyView = z.infer<typeof adminPolicyView>;

export const adminPolicyListQuery = z.object({
  type: policyType.optional(),
  status: policyStatus.optional(),
});
export type AdminPolicyListQuery = z.infer<typeof adminPolicyListQuery>;

export const adminPolicyListResponse = z.object({
  policies: z.array(adminPolicyView),
});
export type AdminPolicyListResponse = z.infer<typeof adminPolicyListResponse>;

/**
 * A new draft.
 *
 * No `version` field: the next number for a type is the server's to allocate, and
 * a client that could choose one could collide with a published version or skip
 * ahead of it. `UNIQUE (type, version)` would refuse the collision; not offering
 * the field is what stops the attempt.
 */
export const createPolicyDraftRequest = z.object({
  type: policyType,
  titleFa: z.string().trim().min(2).max(120),
  contentMd: z.string().trim().min(50).max(60_000),
  summaryFa: z.string().trim().max(280).optional(),
  changeSummaryFa: z.string().trim().max(1_000).optional(),
});
export type CreatePolicyDraftRequest = z.infer<typeof createPolicyDraftRequest>;

/**
 * Editing a draft.
 *
 * `expectedRevision` is required rather than optional. Two people editing one
 * draft is the ordinary case for legal text — somebody writes it, somebody else
 * corrects it — and a last-write-wins update silently discards whichever of them
 * saved first.
 */
export const updatePolicyDraftRequest = z.object({
  expectedRevision: z.number().int().nonnegative(),
  titleFa: z.string().trim().min(2).max(120).optional(),
  contentMd: z.string().trim().min(50).max(60_000).optional(),
  summaryFa: z.string().trim().max(280).nullable().optional(),
  changeSummaryFa: z.string().trim().max(1_000).nullable().optional(),
});
export type UpdatePolicyDraftRequest = z.infer<typeof updatePolicyDraftRequest>;

/**
 * Publishing, and the confirmation that has to come with it.
 *
 * `confirmVersion` must equal the version being published. It is not a checkbox
 * and not a boolean: an operator has to read the number off the screen and type
 * it, which is the cheapest available defence against publishing the wrong draft
 * on a page with three of them.
 */
export const publishPolicyRequest = z.object({
  confirmVersion: z.number().int().positive(),
  /** Required. Recorded in the audit row — publishing is the legally significant act. */
  reason: z.string().trim().min(3).max(280),
});
export type PublishPolicyRequest = z.infer<typeof publishPolicyRequest>;

export const policyConsentView = z.object({
  userPublicId: z.uuid(),
  policyVersionId: z.uuid(),
  /** Snapshotted at acceptance — `TERMS v3`. Survives the version being archived. */
  label: z.string().nullable(),
  context: z.enum(['ONBOARDING', 'REACCEPT', 'CONTACT_SHARE']),
  acceptedAt: z.iso.datetime(),
  appVersion: z.string().nullable(),
  requestId: z.string().nullable(),
});
export type PolicyConsentView = z.infer<typeof policyConsentView>;

export const policyConsentQuery = z.object({
  policyVersionId: z.uuid().optional(),
  userPublicId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type PolicyConsentQuery = z.infer<typeof policyConsentQuery>;

export const policyConsentResponse = z.object({
  consents: z.array(policyConsentView),
  total: z.number().int().nonnegative(),
});
export type PolicyConsentResponse = z.infer<typeof policyConsentResponse>;

export const appSettingView = z.object({
  key: z.string(),
  value: z.number(),
  defaultValue: z.number(),
  overridden: z.boolean(),
});
export type AppSettingView = z.infer<typeof appSettingView>;

export const appSettingsResponse = z.object({ settings: z.array(appSettingView) });
export type AppSettingsResponse = z.infer<typeof appSettingsResponse>;

/**
 * Changing one.
 *
 * The key is checked against the code catalogue in the service, so there is no
 * arbitrary-key write and no "edit any environment variable" screen. The reason
 * is mandatory: a policy number changed in production with nothing recording why
 * is exactly what invariant 12 exists to prevent.
 */
export const updateSettingRequest = z.object({
  value: z.number().nonnegative(),
  reason: z.string().trim().min(5).max(500),
});
export type UpdateSettingRequest = z.infer<typeof updateSettingRequest>;

// ─────────────────────────────────────────────────────────────────────────────
// Activity tags — the «تفریحات» catalogue (M21)
//
// `catalog.manage` has existed in the permission catalogue since M12 and had no
// API behind it: the panel could authorise an act nobody could perform. This is
// that act. Adding an activity was a code change and a deploy, which is the
// wrong shape for a list that grows every time the product enters a new city.
//
// Categories only. Cities, districts and interests are still seed-managed —
// widening this to the whole catalog would have meant four CRUD screens where
// the pressing need is one, and `catalog.manage` covers them all when they come.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The slug rule, in one place.
 *
 * Lowercase ASCII, digits and single hyphens. Slugs are **identifiers, not
 * labels** — the Persian name is the label, and it is freely editable. A slug is
 * what code, seeds and fixtures refer to, so it is ASCII (a Persian slug in a URL
 * is percent-encoded into unreadability) and it is the one field the update
 * endpoint refuses to change.
 */
export const activityTagSlug = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'slug must be lowercase ASCII words joined by single hyphens',
  );

export const activityTagView = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
  /** An emoji or icon key. Never a URL — the CSP forbids external hosts (ADR-0003). */
  icon: z.string().nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  allowsCustomLabel: z.boolean(),
  /** The cities it is offered in, or `null` for everywhere. */
  cityIds: z.array(z.uuid()).nullable(),
  /**
   * How many events already reference it.
   *
   * On the list so the panel can explain *why* a delete was refused before the
   * operator clicks it, rather than after.
   */
  eventCount: z.number().int().nonnegative(),
});
export type ActivityTagView = z.infer<typeof activityTagView>;

export const activityTagsResponse = z.object({ tags: z.array(activityTagView) });
export type ActivityTagsResponse = z.infer<typeof activityTagsResponse>;

export const createActivityTagRequest = z.object({
  slug: activityTagSlug,
  nameFa: z.string().trim().min(1).max(60),
  icon: z.string().trim().max(16).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  allowsCustomLabel: z.boolean().optional(),
  cityIds: z.array(z.uuid()).max(2000).nullable().optional(),
});
export type CreateActivityTagRequest = z.infer<typeof createActivityTagRequest>;

/**
 * Everything except the slug.
 *
 * Every field optional, and an omitted field is left alone — so the panel can
 * send one changed toggle rather than the whole row, and two operators editing
 * different fields do not overwrite each other.
 *
 * The slug's absence is the point. It is the identifier seeds, tests and
 * documentation refer to; renaming it silently repoints every one of them at
 * nothing. Deactivate the row and make a new one instead.
 */
export const updateActivityTagRequest = z
  .object({
    nameFa: z.string().trim().min(1).max(60).optional(),
    icon: z.string().trim().max(16).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    allowsCustomLabel: z.boolean().optional(),
    cityIds: z.array(z.uuid()).max(2000).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });
export type UpdateActivityTagRequest = z.infer<typeof updateActivityTagRequest>;

/**
 * Reordering, as one call.
 *
 * A screen where an operator drags five rows must not be five requests that can
 * half-fail and leave the list in an order nobody chose. The service writes them
 * in one transaction.
 */
export const reorderActivityTagsRequest = z.object({
  order: z.array(z.uuid()).min(1).max(500),
});
export type ReorderActivityTagsRequest = z.infer<typeof reorderActivityTagsRequest>;

/**
 * Provinces and cities for the tag scope picker.
 *
 * Its own admin endpoint rather than a reuse of the public catalog: that one is
 * cached, public and active-only, and widening it to carry inactive rows for one
 * admin screen would publish them to everybody.
 */
export const adminPlacesResponse = z.object({
  provinces: z.array(z.object({ id: z.uuid(), slug: z.string(), nameFa: z.string() })),
  cities: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      nameFa: z.string(),
      provinceId: z.uuid().nullable(),
      isActive: z.boolean(),
    }),
  ),
});
export type AdminPlacesResponse = z.infer<typeof adminPlacesResponse>;
