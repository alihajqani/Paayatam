import { z } from 'zod';

/**
 * The permission catalogue (ADR-0010 rule 1).
 *
 * It lives in `@payetam/shared` rather than in `@payetam/domain` because it is a
 * **contract**: `GET /admin/v1/me` returns a list of these strings, and the admin
 * panel reads them to decide which navigation entries and which buttons to show.
 * A second copy in the frontend would be a second list to keep correct, and the
 * failure mode is silent — a renamed permission produces a menu entry that leads
 * to a page the API refuses.
 *
 * `packages/domain` re-exports this from `adminaccess/permissions.ts`, which is
 * still where the **role grants** live: which role holds which permission is a
 * backend decision that no client is entitled to assume anything about.
 *
 * Hiding a button is a courtesy. Every one of these is checked again in the
 * service layer, because a client that omits a button is not a client that cannot
 * send the request.
 */

export const PERMISSIONS = {
  /** Read the dashboard's aggregates. The least a staff account can have. */
  DASHBOARD_READ: 'dashboard.read',
  /** See user records, including the ones a support conversation needs. */
  USER_READ: 'user.read',
  /** Suspend or ban an account. */
  USER_BAN: 'user.ban',
  /** Hide, approve or reject an event, and decide a moderation case. */
  EVENT_MODERATE: 'event.moderate',
  /** Work the report queue. */
  REPORT_REVIEW: 'report.review',
  /** Add, retire or edit blacklist terms. */
  BLACKLIST_MANAGE: 'blacklist.manage',
  /** Read coin and trust ledgers. */
  LEDGER_READ: 'ledger.read',
  /** Move somebody's balance. The single most dangerous non-privacy capability. */
  COIN_ADJUST: 'coin.adjust',
  /** Move somebody's Trust Score by hand. */
  TRUST_ADJUST: 'trust.adjust',
  /** Break-glass: read a private conversation. Never sufficient on its own (T14). */
  CHAT_READ: 'chat.read',
  /** Cities, districts, categories, interests. */
  CATALOG_MANAGE: 'catalog.manage',
  /** Publish a new terms or privacy version. */
  POLICY_MANAGE: 'policy.manage',
  /** Change a policy number in `app_setting`. */
  SETTINGS_MANAGE: 'settings.manage',
  /**
   * Mint, disable and monitor gift codes (M18).
   *
   * Its own permission rather than a reuse of `settings.manage`, because it is
   * not the same kind of act: a settings change retunes a policy that already
   * exists, and this one creates coins out of nothing. It is granted to
   * `SUPER_ADMIN` alone, for the reason ADR-0010 keeps `coin.adjust` away from
   * `SUPPORT` — the role most exposed to "please just give them the coins" is
   * the one that must not be able to.
   */
  GIFT_CODE_MANAGE: 'giftcode.manage',
  /**
   * Review a referral's fraud signals, reject it, or put a rejected one back to
   * `PENDING` (M19).
   *
   * Its own permission rather than a reuse of `coin.adjust`, because it is the
   * *opposite* capability: nothing behind this key can pay anybody. A rejection
   * withholds a reward that has not been earned yet, and a reinstatement only
   * restores the referral's ability to earn one — the attendance condition is
   * still checked by `ReferralService`, which is why `MODERATOR` can hold this
   * while `coin.adjust` stays with `SUPER_ADMIN` alone.
   *
   * It exists at all because T6 recorded velocity signals "for admin review" and
   * gave the admin no way to act on the review. An enum value nothing writes and
   * a signal nobody can act on are the same bug seen from two sides.
   */
  REFERRAL_MANAGE: 'referral.manage',
  /** Read the audit trail. */
  AUDIT_READ: 'audit.read',
  /** Request or approve a role change. Four-eyes applies on top (rule 4). */
  ROLE_MANAGE: 'role.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** For a route that names one on the wire, so a typo is a validation error. */
export const permissionKey = z.enum(Object.values(PERMISSIONS) as [Permission, ...Permission[]]);
