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
  /** Read the audit trail. */
  AUDIT_READ: 'audit.read',
  /** Request or approve a role change. Four-eyes applies on top (rule 4). */
  ROLE_MANAGE: 'role.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

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
    PERMISSIONS.AUDIT_READ,
  ],

  SUPPORT: [
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.USER_READ,
    PERMISSIONS.REPORT_REVIEW,
    PERMISSIONS.LEDGER_READ,
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
