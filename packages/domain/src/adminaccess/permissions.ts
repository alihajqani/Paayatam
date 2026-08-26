/**
 * The permission catalogue and the role grants (ADR-0010).
 *
 * Permissions are **fine-grained strings granted to roles**, never role names
 * checked in code. That is rule 1, and the reason for it is that adding a
 * capability should be a row and a constant here, not a new branch in every
 * service that has to know which roles are "senior enough".
 *
 * This file is the seed for `permission` and `role_permission`, and it is also
 * what the RBAC matrix test reads. Keeping the two from drifting is the point: a
 * matrix test written against a second copy of the table would pass while the
 * database said something else.
 */

/**
 * Re-exported from `@payetam/shared`, which is where the catalogue lives (M19).
 *
 * It moved because it is a contract rather than a domain detail: `GET /me`
 * returns these strings and the admin panel reads them to decide what to show.
 * What stays here is the part no client may assume anything about — **which role
 * holds which permission**.
 */
import { PERMISSIONS, type Permission } from '@payetam/shared';

export { PERMISSIONS };
export type { Permission };

export const ROLE_KEYS = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  MODERATOR: 'MODERATOR',
  SUPPORT: 'SUPPORT',
  ANALYST: 'ANALYST',
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

/**
 * ADR-0010's table, as data.
 *
 * The two lines worth reading twice are the ones the plan tests by name:
 * **`SUPPORT` does not get `coin.adjust`** — moving currency is not a support
 * action, and a support account is the one most exposed to social engineering —
 * and **`ANALYST` gets `dashboard.read` and nothing else**, because "read-only
 * aggregates" means aggregates, not a licence to read every user record.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  SUPER_ADMIN: Object.values(PERMISSIONS),

  MODERATOR: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.USER_READ,
    PERMISSIONS.USER_BAN,
    PERMISSIONS.EVENT_MODERATE,
    PERMISSIONS.REPORT_REVIEW,
    PERMISSIONS.BLACKLIST_MANAGE,
    PERMISSIONS.LEDGER_READ,
    PERMISSIONS.CHAT_READ,
    // Fraud review is moderation, and this is the half of it that was missing:
    // `fraud_signals` have been recorded since M9 for a human who had no button.
    PERMISSIONS.REFERRAL_MANAGE,
    PERMISSIONS.AUDIT_READ,
    // A moderator judging an event against the rules needs to be able to read
    // the rules. Nothing here lets them change one (M22).
    PERMISSIONS.POLICY_READ,
  ],

  SUPPORT: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.USER_READ,
    PERMISSIONS.REPORT_REVIEW,
    PERMISSIONS.LEDGER_READ,
    // Reading the current terms is what answers half the questions support gets.
    // Writing them is not, which is why `policy.manage` and `policy.publish` are
    // not here (M22).
    PERMISSIONS.POLICY_READ,
  ],

  ANALYST: [PERMISSIONS.DASHBOARD_READ],
};

export const ROLE_NAMES_FA: Record<RoleKey, string> = {
  SUPER_ADMIN: 'مدیر ارشد',
  MODERATOR: 'ناظر',
  SUPPORT: 'پشتیبانی',
  ANALYST: 'تحلیل‌گر',
};

/** Whether a role holds a permission, from the table above. */
export function roleHas(role: RoleKey, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
