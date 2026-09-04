import { z } from 'zod';

/**
 * Economy contracts (M9).
 *
 * The shape worth noticing is that **both `/me/coins` and `/me/trust` return a
 * ledger, not just a number**. ADR-0007 makes that the whole point: a balance
 * with no history cannot answer "where did my coins go?", and a reputation score
 * with no history cannot be appealed. The number is a convenience; the rows are
 * the product.
 *
 * Nothing here names another user. A referral summary counts the people who used
 * your code and says nothing about who they are — the referrer is not entitled to
 * a list of their friends' accounts just because they invited them.
 */

export const coinLedgerType = z.enum([
  'ONBOARDING_REWARD',
  'REFERRAL_REWARD',
  'REVIEW_REWARD',
  'GIFT_CODE_REDEEM',
  'BOOST_SPEND',
  'VIP_SPEND',
  // The three M22 sinks (phase 5).
  'EVENT_CREATE_SPEND',
  'CHANNEL_POST_SPEND',
  'INVITE_SPEND',
  // Asking to join an activity (v0.6.3). `economy.event_join_coins` is 0 by
  // default, so no live ledger carries this yet.
  'EVENT_JOIN_SPEND',
  'CANCELLATION_PENALTY',
  'NO_SHOW_PENALTY',
  'HOST_CANCELLATION_REFUND',
  'ADMIN_ADJUSTMENT',
  'REVERSAL',
  // The launch campaign's one-time grant to the first N members (v0.9.0).
  'FOUNDING_REWARD',
]);
export type CoinLedgerType = z.infer<typeof coinLedgerType>;

export const trustLedgerType = z.enum([
  'INITIAL',
  'PROFILE_COMPLETE',
  'ATTENDANCE',
  'REVIEW',
  'CANCELLATION',
  'NO_SHOW',
  'MODERATION',
  'REHABILITATION',
  'ADMIN_ADJUSTMENT',
  'REVERSAL',
]);
export type TrustLedgerType = z.infer<typeof trustLedgerType>;

export const coinEntryView = z.object({
  amount: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  type: coinLedgerType,
  /** Stable and machine-readable; the client renders the Persian. */
  reasonCode: z.string(),
  createdAt: z.iso.datetime(),
});
export type CoinEntryView = z.infer<typeof coinEntryView>;

export const coinsResponse = z.object({
  balance: z.number().int().nonnegative(),
  entries: z.array(coinEntryView),
});
export type CoinsResponse = z.infer<typeof coinsResponse>;

export const trustEntryView = z.object({
  /** What actually moved, after clamping. Zero when the score was at a bound. */
  delta: z.number().int(),
  scoreBefore: z.number().int().min(0).max(100),
  scoreAfter: z.number().int().min(0).max(100),
  type: trustLedgerType,
  reasonCode: z.string(),
  /** Which rules produced this row, so an old entry stays explainable. */
  algoVersion: z.number().int().positive(),
  /**
   * What the policy asked for, present only when the bounds ate some of it.
   * This is what turns "my score did not move" into an explanation.
   */
  requestedDelta: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});
export type TrustEntryView = z.infer<typeof trustEntryView>;

export const trustResponse = z.object({
  score: z.number().int().min(0).max(100),
  entries: z.array(trustEntryView),
});
export type TrustResponse = z.infer<typeof trustResponse>;

export const referralResponse = z.object({
  /** The caller's own code, generated on first read. */
  code: z.string(),
  /** How many people used it — a count, never a list of who. */
  invited: z.number().int().nonnegative(),
  /** How many of those attended an event and paid out. */
  qualified: z.number().int().nonnegative(),
  coinsEarned: z.number().int().nonnegative(),
  /**
   * Set when the caller was themselves referred.
   *
   * `status` was added in M19, when `REJECTED` became a state something writes: a
   * screen that only knew "qualified or not" rendered a refused referral as
   * «در انتظار» forever. `qualified` stays beside it, meaning what it always
   * meant.
   *
   * There is no reason code here on purpose. Why a referral was refused lives on
   * the admin surface — naming the signal that fired to the person it fired on is
   * telling a farmer what to change (T6).
   */
  referredBy: z
    .object({
      status: z.enum(['PENDING', 'QUALIFIED', 'REJECTED']),
      qualified: z.boolean(),
    })
    .nullable(),
});
export type ReferralResponse = z.infer<typeof referralResponse>;

/**
 * Claiming an invite.
 *
 * Length-bounded rather than pattern-matched: the server normalises case and
 * separators before looking the code up, so a user who types their code with a
 * dash or in lower case is not told they were wrong about something they copied
 * correctly.
 */
export const claimReferralRequest = z.object({
  code: z.string().trim().min(4).max(32),
});
export type ClaimReferralRequest = z.infer<typeof claimReferralRequest>;

export const claimReferralResponse = z.object({
  status: z.enum(['PENDING', 'QUALIFIED']),
  /** What the caller receives once they attend an event. Zero once qualified. */
  pendingCoins: z.number().int().nonnegative(),
});
export type ClaimReferralResponse = z.infer<typeof claimReferralResponse>;

/**
 * Gift and discount codes (M18).
 *
 * Length-bounded rather than pattern-matched, exactly as `claimReferralRequest`
 * is: the server upper-cases and strips spaces and dashes before looking the code
 * up, so somebody who types «summer-24» is not told they were wrong about
 * something they copied correctly.
 *
 * **Notice what the request does not carry.** There is no coin amount here, and
 * there is nowhere for one. What a code grants is a column on `gift_code`, read
 * under the row lock that redeems it — the client names an intention and the
 * server decides what it is worth (invariant 9).
 */
export const redeemGiftCodeRequest = z.object({
  code: z.string().trim().min(4).max(32),
});
export type RedeemGiftCodeRequest = z.infer<typeof redeemGiftCodeRequest>;

export const redeemGiftCodeResponse = z.object({
  /** The code as the server matched it — normalized, so the UI echoes truth. */
  code: z.string(),
  /** What this redemption granted. */
  coins: z.number().int().positive(),
  /** The balance after the grant, so the screen never has to add it up itself. */
  balance: z.number().int().nonnegative(),
  /** Redemptions of this code the caller has left. Zero for a single-use code. */
  remainingForUser: z.number().int().nonnegative(),
});
export type RedeemGiftCodeResponse = z.infer<typeof redeemGiftCodeResponse>;
