import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { MessageCipher } from '../chat/message-cipher';
import { CoinService } from '../economy/coin.service';
import { TrustService } from '../economy/trust.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { AdminOperationsService } from './admin-operations.service';
import { ChatUnsealService } from './chat-unseal.service';
import { AdminInsightService } from './admin-insight.service';
import { CatalogAdminService } from './catalog-admin.service';
import { GiftCodeAdminService } from './gift-code-admin.service';
import { ReferralAdminService } from './referral-admin.service';
import {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
} from './permissions';

/**
 * The RBAC matrix: **every role × every admin operation** (ADR-0010, rule 5).
 *
 * ADR-0010 says this is "the only way a matrix like this stays correct as
 * endpoints are added", and the shape below is what makes that true. Each entry
 * names an operation and the permission it requires; the expectation for a role is
 * *derived* from `ROLE_PERMISSIONS` rather than written out by hand. A hand-written
 * grid would be a second copy of the policy, and the first thing a second copy does
 * is disagree with the first.
 *
 * Two properties are asserted here and neither is about a controller:
 *
 *  - **Deny by default.** An operation whose permission a role lacks throws
 *    `FORBIDDEN` — reached through the *service*, because ADR-0010 rule 2 puts the
 *    check there so it holds for jobs and scripts too.
 *  - **Every operation declares a permission.** An operation missing from the list
 *    below fails the completeness check, so an endpoint added without a
 *    declaration is unreachable-by-omission rather than open-by-omission.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-15T09:00:00.000Z'));
const env = { CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials(env);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const cipher = new MessageCipher(env);

// The matrix never authenticates, so Redis is never reached. A stub rather than a
// live connection keeps this suite about authorisation and nothing else.
const redis = { client: {} } as unknown as RedisService;

const access = new AdminAccessService(service, clock, redis, credentials, audit);
const operations = new AdminOperationsService(service, clock, access, coins, trust, audit);
const unseal = new ChatUnsealService(service, clock, settings, cipher, access, audit);
const giftCodes = new GiftCodeAdminService(service, clock, access, settings, audit);
const referrals = new ReferralAdminService(service, clock, access, audit);
const insight = new AdminInsightService(service, clock, access);
const catalogAdmin = new CatalogAdminService(service, access, audit);

/**
 * One admin operation, and the permission it demands.
 *
 * `run` is called with a session that is *missing* the permission, so what is being
 * asserted is the refusal — and the call is deliberately made with arguments that
 * would fail later anyway. If authorisation is checked first, as it must be, the
 * arguments are never reached.
 */
interface Operation {
  name: string;
  permission: Permission;
  run: (session: AdminSession) => Promise<unknown>;
}

const OPERATIONS: Operation[] = [
  {
    name: 'GET /admin/v1/moderation/cases',
    permission: PERMISSIONS.EVENT_MODERATE,
    run: (session) => operations.listCases(session),
  },
  {
    name: 'POST /admin/v1/moderation/cases/:id/decide',
    permission: PERMISSIONS.EVENT_MODERATE,
    run: (session) =>
      operations.decideCase(session, 'no-such-case', { decision: 'APPROVED', note: 'note' }),
  },
  {
    name: 'POST /admin/v1/coins/adjust',
    permission: PERMISSIONS.COIN_ADJUST,
    run: (session) =>
      operations.adjustCoins(session, {
        userPublicId: '00000000-0000-4000-8000-000000000000',
        amount: 10,
        reason: 'goodwill',
        reference: 'matrix-test-ref',
      }),
  },
  {
    name: 'POST /admin/v1/trust/adjust',
    permission: PERMISSIONS.TRUST_ADJUST,
    run: (session) =>
      operations.adjustTrust(session, {
        userPublicId: '00000000-0000-4000-8000-000000000000',
        delta: 5,
        reason: 'correction',
        reference: 'matrix-test-ref',
      }),
  },
  {
    name: 'POST /admin/v1/users/:publicId/status',
    permission: PERMISSIONS.USER_BAN,
    run: (session) =>
      operations.setUserStatus(session, {
        userPublicId: '00000000-0000-4000-8000-000000000000',
        status: 'SUSPENDED',
        reason: 'abuse',
      }),
  },
  {
    name: 'POST /admin/v1/roles/requests',
    permission: PERMISSIONS.ROLE_MANAGE,
    run: (session) =>
      operations.requestRoleChange(session, {
        subjectAdminId: '00000000-0000-4000-8000-000000000000',
        roleKey: 'MODERATOR',
        granting: true,
        reason: 'promotion',
      }),
  },
  {
    name: 'POST /admin/v1/roles/requests/:id/approve',
    permission: PERMISSIONS.ROLE_MANAGE,
    run: (session) => operations.approveRoleChange(session, 'no-such-request'),
  },
  {
    name: 'GET /admin/v1/audit',
    permission: PERMISSIONS.AUDIT_READ,
    run: (session) => operations.listAuditLog(session),
  },
  {
    name: 'POST /admin/v1/chats/:publicId/unseal',
    permission: PERMISSIONS.CHAT_READ,
    run: (session) => unseal.grant(session, 'no-such-chat', 'investigating a report of abuse'),
  },
  {
    name: 'GET /admin/v1/chats/unseal/:grantId',
    permission: PERMISSIONS.CHAT_READ,
    run: (session) => unseal.read(session, 'no-such-grant'),
  },
  /**
   * M18. `giftcode.manage` is `SUPER_ADMIN`-only, so these three rows are what
   * assert that `MODERATOR` — which holds `user.ban` and `chat.read` — still
   * cannot mint coins.
   */
  {
    name: 'POST /admin/v1/gift-codes',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.create(session, { code: 'MATRIXTEST', coins: 0 }),
  },
  {
    name: 'GET /admin/v1/gift-codes',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.list(session),
  },
  {
    name: 'POST /admin/v1/gift-codes/:publicId/active',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.setActive(session, NO_SUCH_ID, false),
  },
  /**
   * M19. Six more rows under the same key, and the reason they are enumerated
   * rather than assumed is rule 3's completeness half: a service method that
   * forgot `assertPermission` would be reachable by `ANALYST`, and nothing else
   * in the product would notice.
   */
  {
    name: 'POST /admin/v1/gift-codes/batch',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.createBatch(session, { count: 0, coins: 0 }),
  },
  {
    name: 'PATCH /admin/v1/gift-codes/:publicId',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.update(session, NO_SUCH_ID, { coins: 0 }),
  },
  {
    name: 'GET /admin/v1/gift-codes/:publicId/analytics',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.analytics(session, NO_SUCH_ID),
  },
  {
    name: 'GET /admin/v1/gift-codes/campaigns',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.campaigns(session),
  },
  {
    name: 'GET /admin/v1/gift-codes/:publicId/redemptions',
    permission: PERMISSIONS.GIFT_CODE_MANAGE,
    run: (session) => giftCodes.redemptions(session, NO_SUCH_ID),
  },
  /**
   * M19's referral review (T6). `referral.manage` is held by `SUPER_ADMIN` and
   * `MODERATOR` and by neither `SUPPORT` nor `ANALYST` — which is what these four
   * rows assert, and the reason it can be wider than `coin.adjust` is that
   * nothing behind it can move a balance.
   */
  {
    name: 'GET /admin/v1/referrals',
    permission: PERMISSIONS.REFERRAL_MANAGE,
    run: (session) => referrals.list(session),
  },
  {
    name: 'GET /admin/v1/referrals/:id',
    permission: PERMISSIONS.REFERRAL_MANAGE,
    run: (session) => referrals.get(session, NO_SUCH_ID),
  },
  {
    name: 'POST /admin/v1/referrals/:id/reject',
    permission: PERMISSIONS.REFERRAL_MANAGE,
    run: (session) => referrals.reject(session, NO_SUCH_ID, { reason: 'FRAUD', note: 'x' }),
  },
  {
    name: 'POST /admin/v1/referrals/:id/reinstate',
    permission: PERMISSIONS.REFERRAL_MANAGE,
    run: (session) => referrals.reinstate(session, NO_SUCH_ID, 'x'),
  },
  /**
   * M19's panel surface, and the reason every read is enumerated here rather
   * than trusted: `ANALYST` holds `dashboard.read` and nothing else, so exactly
   * one of the fourteen rows below is allowed for that role. A read method that
   * forgot `assertPermission` would be reachable by an account whose whole
   * purpose is aggregates, and nothing outside this matrix would notice.
   */
  {
    name: 'GET /admin/v1/dashboard',
    permission: PERMISSIONS.DASHBOARD_READ,
    run: (session) => insight.dashboard(session),
  },
  {
    name: 'GET /admin/v1/users',
    permission: PERMISSIONS.USER_READ,
    run: (session) => insight.listUsers(session),
  },
  {
    name: 'GET /admin/v1/users/:publicId',
    permission: PERMISSIONS.USER_READ,
    run: (session) => insight.getUser(session, NO_SUCH_ID),
  },
  {
    name: 'GET /admin/v1/events',
    permission: PERMISSIONS.EVENT_MODERATE,
    run: (session) => insight.listEvents(session),
  },
  {
    name: 'GET /admin/v1/events/:publicId',
    permission: PERMISSIONS.EVENT_MODERATE,
    run: (session) => insight.getEvent(session, NO_SUCH_ID),
  },
  {
    name: 'POST /admin/v1/events/:publicId/moderate',
    permission: PERMISSIONS.EVENT_MODERATE,
    run: (session) =>
      operations.moderateEvent(session, NO_SUCH_ID, { action: 'HIDE', reason: 'x' }),
  },
  {
    name: 'GET /admin/v1/reports',
    permission: PERMISSIONS.REPORT_REVIEW,
    run: (session) => insight.listReports(session),
  },
  {
    name: 'POST /admin/v1/reports/:publicId/decide',
    permission: PERMISSIONS.REPORT_REVIEW,
    run: (session) =>
      operations.decideReport(session, NO_SUCH_ID, { status: 'DISMISSED', note: '' }),
  },
  {
    name: 'GET /admin/v1/ledger',
    permission: PERMISSIONS.LEDGER_READ,
    run: (session) => insight.searchLedger(session),
  },
  {
    name: 'GET /admin/v1/ledger/reconcile',
    permission: PERMISSIONS.LEDGER_READ,
    run: (session) => insight.reconcile(session),
  },
  {
    name: 'GET /admin/v1/audit/search',
    permission: PERMISSIONS.AUDIT_READ,
    run: (session) => insight.listAudit(session),
  },
  {
    name: 'GET /admin/v1/settings',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    run: (session) => operations.listSettings(session),
  },
  {
    name: 'POST /admin/v1/settings/:key',
    permission: PERMISSIONS.SETTINGS_MANAGE,
    run: (session) => operations.updateSetting(session, 'no.such.key', 1, 'x'),
  },
  // Activity tags (M21). `catalog.manage` had been in the catalogue since M12
  // with no operation behind it — these are the first entries it has ever had.
  {
    name: 'GET /admin/v1/activity-tags',
    permission: PERMISSIONS.CATALOG_MANAGE,
    run: (session) => catalogAdmin.listTags(session),
  },
  {
    name: 'POST /admin/v1/activity-tags',
    permission: PERMISSIONS.CATALOG_MANAGE,
    run: (session) => catalogAdmin.createTag(session, { slug: 'no-such-tag', nameFa: 'x' }),
  },
  {
    name: 'PATCH /admin/v1/activity-tags/:id',
    permission: PERMISSIONS.CATALOG_MANAGE,
    run: (session) => catalogAdmin.updateTag(session, NO_SUCH_ID, { nameFa: 'x' }),
  },
  {
    name: 'DELETE /admin/v1/activity-tags/:id',
    permission: PERMISSIONS.CATALOG_MANAGE,
    run: (session) => catalogAdmin.deleteTag(session, NO_SUCH_ID),
  },
  {
    name: 'POST /admin/v1/activity-tags/reorder',
    permission: PERMISSIONS.CATALOG_MANAGE,
    run: (session) => catalogAdmin.reorderTags(session, [NO_SUCH_ID]),
  },
  {
    name: 'GET /admin/v1/places',
    permission: PERMISSIONS.CATALOG_MANAGE,
    run: (session) => catalogAdmin.listPlaces(session),
  },
];

/** A well-formed UUID that addresses nothing, so a permitted call reaches 404. */
const NO_SUCH_ID = '00000000-0000-4000-8000-000000000000';

function sessionFor(role: RoleKey): AdminSession {
  return {
    adminUserId: `matrix-${role}`,
    email: `${role.toLowerCase()}@payetam.test`,
    displayName: role,
    roles: [role],
    permissions: permissionsFor([role]),
  };
}

const ROLES = Object.values(ROLE_KEYS);

beforeAll(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the RBAC matrix (ADR-0010, rule 5)', () => {
  /**
   * The completeness half of rule 3: "an endpoint with no declared permission is
   * unreachable, and a test asserts that no endpoint lacks a declaration".
   *
   * Counted rather than merely listed, so adding an operation to the services
   * without adding it here is a failure rather than a silent gap.
   */
  it('declares a permission for every admin operation', () => {
    for (const operation of OPERATIONS) {
      expect(Object.values(PERMISSIONS)).toContain(operation.permission);
    }
    expect(OPERATIONS).toHaveLength(35);
  });

  for (const role of ROLES) {
    for (const operation of OPERATIONS) {
      const allowed = ROLE_PERMISSIONS[role].includes(operation.permission);

      it(`${allowed ? 'allows' : 'denies'} ${role} → ${operation.name}`, async () => {
        const session = sessionFor(role);

        if (allowed) {
          /**
           * A permitted call must get **past** authorisation. It may then fail on
           * the nonsense arguments above — that is the point: the failure it
           * reaches proves the permission check let it through, and a `FORBIDDEN`
           * would prove it did not.
           */
          let code: string | undefined;
          try {
            await operation.run(session);
          } catch (error) {
            code = (error as { code?: string }).code;
          }
          expect(code, `${role} should not be forbidden from ${operation.name}`).not.toBe(
            'FORBIDDEN',
          );
        } else {
          await expect(operation.run(session)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
      });
    }
  }
});

/**
 * The three role facts ADR-0010 states in prose and the plan tests by name.
 *
 * Derived from the same constant everything else reads, so these are assertions
 * about the policy rather than a restatement of it.
 */
describe('the role table says what ADR-0010 says', () => {
  it('does not let SUPPORT adjust coins', () => {
    expect(ROLE_PERMISSIONS.SUPPORT).not.toContain(PERMISSIONS.COIN_ADJUST);
  });

  it('does not let SUPPORT unseal a chat or ban a user', () => {
    expect(ROLE_PERMISSIONS.SUPPORT).not.toContain(PERMISSIONS.CHAT_READ);
    expect(ROLE_PERMISSIONS.SUPPORT).not.toContain(PERMISSIONS.USER_BAN);
  });

  it('does not let MODERATOR adjust coins or manage roles', () => {
    expect(ROLE_PERMISSIONS.MODERATOR).not.toContain(PERMISSIONS.COIN_ADJUST);
    expect(ROLE_PERMISSIONS.MODERATOR).not.toContain(PERMISSIONS.ROLE_MANAGE);
  });

  /** "Read-only aggregates" means aggregates, not every user record. */
  it('gives ANALYST the dashboard and nothing else', () => {
    expect(ROLE_PERMISSIONS.ANALYST).toEqual([PERMISSIONS.DASHBOARD_READ]);
  });

  it('gives SUPER_ADMIN everything', () => {
    expect([...ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual(Object.values(PERMISSIONS).sort());
  });

  /** Deny by default: no roles, no capabilities. */
  it('gives an admin with no roles nothing at all', () => {
    expect(permissionsFor([])).toEqual([]);
  });
});
