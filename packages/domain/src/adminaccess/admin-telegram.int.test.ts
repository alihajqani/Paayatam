import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import {
  createTestPrisma,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { AdminTelegramService, BOT_PERMISSIONS } from './admin-telegram.service';
import { PERMISSIONS, ROLE_KEYS } from './permissions';

/**
 * A moderator's Telegram identity (ADR-0018).
 *
 * ADR-0010 says admin access must **not** follow from a staff member's personal
 * Telegram being taken over, and this table is the documented exception. So what
 * this suite is really asserting is the *bound* on that exception: what a taken
 * over Telegram account can reach, and what it cannot.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-30T09:00:00.000Z');
const clock = new FakeClock(NOW);

const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const links = new AdminTelegramService(service, access, audit);

const MODERATOR_TELEGRAM = 573_914_882n;

let SUPER: AdminSession;
let moderatorId: string;

/** A staff account with roles, without going through the password path. */
async function seedAdmin(email: string, roleKeys: readonly string[]): Promise<string> {
  const admin = await prisma.adminUser.create({
    data: {
      email,
      passwordHash: 'not-a-real-hash',
      totpSecretEnc: 'not-a-real-secret',
      displayName: email,
    },
    select: { id: true },
  });

  for (const key of roleKeys) {
    const role = await prisma.role.upsert({
      where: { key },
      create: { key, name: key },
      update: {},
      select: { id: true },
    });
    await prisma.adminUserRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
  }

  return admin.id;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);

  const superId = await seedAdmin('super@payetam.test', [ROLE_KEYS.SUPER_ADMIN]);
  moderatorId = await seedAdmin('mod@payetam.test', [ROLE_KEYS.MODERATOR]);

  SUPER = {
    adminUserId: superId,
    email: 'super@payetam.test',
    displayName: 'مدیر ارشد',
    roles: [ROLE_KEYS.SUPER_ADMIN],
    permissions: permissionsFor([ROLE_KEYS.SUPER_ADMIN]),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('resolving a Telegram account to a staff session', () => {
  /**
   * The default answer, and the one almost every update gets. Absence of a link
   * is not an error, an empty session or a partially-populated one — it is null,
   * so a caller cannot accidentally treat "nobody" as "somebody with no
   * permissions".
   */
  it('answers null for an account nobody linked', async () => {
    expect(await links.sessionFor(MODERATOR_TELEGRAM)).toBeNull();
    expect(await links.isLinked(MODERATOR_TELEGRAM)).toBe(false);
  });

  it('resolves a linked moderator', async () => {
    await links.link(SUPER, {
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'on-call moderation',
    });

    const session = await links.sessionFor(MODERATOR_TELEGRAM);
    expect(session?.adminUserId).toBe(moderatorId);
    expect(session?.permissions).toContain(PERMISSIONS.EVENT_MODERATE);
    expect(await links.isLinked(MODERATOR_TELEGRAM)).toBe(true);
  });

  /**
   * **The bound on the exception.** A `SUPER_ADMIN` on the bot is a moderator and
   * no more: the session is their real permissions *intersected* with
   * `BOT_PERMISSIONS`, so a taken-over Telegram account reaches a case queue and
   * cannot move a coin, adjust a Trust Score, unseal a conversation, change a
   * role, ban an account or edit a setting.
   */
  it('gives a SUPER_ADMIN on the bot exactly what a moderator gets', async () => {
    await links.link(SUPER, {
      adminUserId: SUPER.adminUserId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'the founder moderates too',
    });

    const session = await links.sessionFor(MODERATOR_TELEGRAM);

    expect(session?.roles).toEqual([ROLE_KEYS.SUPER_ADMIN]);
    expect([...(session?.permissions ?? [])].sort()).toEqual([...BOT_PERMISSIONS].sort());
    for (const forbidden of [
      PERMISSIONS.COIN_ADJUST,
      PERMISSIONS.TRUST_ADJUST,
      PERMISSIONS.CHAT_READ,
      PERMISSIONS.ROLE_MANAGE,
      PERMISSIONS.USER_BAN,
      PERMISSIONS.SETTINGS_MANAGE,
      PERMISSIONS.USER_TELEGRAM_READ,
      PERMISSIONS.MESSAGE_BROADCAST,
    ]) {
      expect(session?.permissions).not.toContain(forbidden);
    }
  });

  /**
   * The intersection is in this direction on purpose: the bot can never *grant*
   * what a role does not hold. An `ANALYST` who somehow acquires a link gets a
   * session with no permissions at all, and every operation refuses it.
   */
  it('gives a role without event.moderate an empty session rather than a queue', async () => {
    const analystId = await seedAdmin('analyst@payetam.test', [ROLE_KEYS.ANALYST]);
    await links.link(SUPER, {
      adminUserId: analystId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'mistake worth being harmless',
    });

    const session = await links.sessionFor(MODERATOR_TELEGRAM);
    expect(session?.permissions).toEqual([]);
    expect(() => access.assertPermission(session!, PERMISSIONS.EVENT_MODERATE)).toThrow(AppError);
  });

  /**
   * A suspended account and a missing link answer identically. Distinguishing
   * them in a bot reply would tell whoever holds the Telegram account that it
   * *is* linked to a staff member.
   */
  it('answers null for a suspended admin, exactly as for no link at all', async () => {
    await links.link(SUPER, {
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'on-call moderation',
    });
    await prisma.adminUser.update({ where: { id: moderatorId }, data: { status: 'SUSPENDED' } });

    expect(await links.sessionFor(MODERATOR_TELEGRAM)).toBeNull();
    expect(await links.isLinked(MODERATOR_TELEGRAM)).toBe(false);
  });
});

describe('what the bot session can actually reach', () => {
  /**
   * The allowlist is not decoration: it is the answer to "what does an attacker
   * who has taken over a moderator's Telegram get?", and the answer has to be
   * checkable rather than asserted in a comment.
   */
  it('holds exactly the two permissions the channel is bounded to', () => {
    expect([...BOT_PERMISSIONS].sort()).toEqual(
      [PERMISSIONS.EVENT_MODERATE, PERMISSIONS.REPORT_REVIEW].sort(),
    );
  });

  /**
   * The four capabilities ADR-0010 spends the most words protecting, named one
   * by one so that adding any of them to the allowlist fails here rather than
   * shipping.
   */
  it.each([
    PERMISSIONS.COIN_ADJUST,
    PERMISSIONS.TRUST_ADJUST,
    PERMISSIONS.CHAT_READ,
    PERMISSIONS.ROLE_MANAGE,
    PERMISSIONS.USER_TELEGRAM_READ,
  ])('never reaches %s from the bot', (permission) => {
    expect(BOT_PERMISSIONS).not.toContain(permission);
  });
});

describe('granting and revoking the link', () => {
  /** Invariant 12: a permission check in the service layer, and an audit row. */
  it('refuses an admin without role.manage, and writes nothing', async () => {
    const moderatorSession: AdminSession = {
      adminUserId: moderatorId,
      email: 'mod@payetam.test',
      displayName: 'ناظر',
      roles: [ROLE_KEYS.MODERATOR],
      permissions: permissionsFor([ROLE_KEYS.MODERATOR]),
    };

    await expect(
      links.link(moderatorSession, {
        adminUserId: moderatorId,
        telegramUserId: MODERATOR_TELEGRAM,
        reason: 'granting myself the queue',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    expect(await prisma.adminTelegramLink.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it('records who granted it and why, and never the Telegram id', async () => {
    await links.link(SUPER, {
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'on-call moderation from a phone',
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'admin.telegram_linked' },
    });
    expect(entry.actorId).toBe(SUPER.adminUserId);
    expect(entry.targetId).toBe(moderatorId);
    expect(entry.after).toMatchObject({ reason: 'on-call moderation from a phone' });
    // Invariant 7 has no exception for `audit_log`, which `MODERATOR` can read.
    expect(JSON.stringify(entry.after)).not.toContain(MODERATOR_TELEGRAM.toString());
  });

  /** A grant nobody explained is not reviewable later — the `decision_note` rule. */
  it('refuses a reason too short to be one', async () => {
    await expect(
      links.link(SUPER, {
        adminUserId: moderatorId,
        telegramUserId: MODERATOR_TELEGRAM,
        reason: ' x ',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  /**
   * Refused rather than overwritten. An overwrite would silently move somebody
   * else's access, and "who has this" would then be answerable only from the
   * audit log.
   */
  it('refuses a second link on either side', async () => {
    await links.link(SUPER, {
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'on-call moderation',
    });

    const otherId = await seedAdmin('other@payetam.test', [ROLE_KEYS.MODERATOR]);
    await expect(
      links.link(SUPER, {
        adminUserId: otherId,
        telegramUserId: MODERATOR_TELEGRAM,
        reason: 'same phone, different person',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DUPLICATE_REQUEST });

    await expect(
      links.link(SUPER, {
        adminUserId: moderatorId,
        telegramUserId: 999_111_222n,
        reason: 'a second phone',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DUPLICATE_REQUEST });

    expect(await prisma.adminTelegramLink.count()).toBe(1);
  });

  it('stops working immediately when revoked', async () => {
    await links.link(SUPER, {
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'on-call moderation',
    });
    expect(await links.sessionFor(MODERATOR_TELEGRAM)).not.toBeNull();

    await links.unlink(SUPER, moderatorId, 'left the team');

    // There is no cached session anywhere to outlive the delete.
    expect(await links.sessionFor(MODERATOR_TELEGRAM)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'admin.telegram_unlinked' } })).toBe(1);
  });

  /**
   * «I removed their access» and «there was none» are different things for
   * somebody acting on an incident, so this is not quietly idempotent.
   */
  it('says so when there was nothing to revoke', async () => {
    await expect(links.unlink(SUPER, moderatorId, 'left the team')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  /** A deleted staff account must not leave a row that still resolves. */
  it('goes with the admin account', async () => {
    await links.link(SUPER, {
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      reason: 'on-call moderation',
    });

    await prisma.adminUser.delete({ where: { id: moderatorId } });

    expect(await prisma.adminTelegramLink.count()).toBe(0);
    expect(await links.sessionFor(MODERATOR_TELEGRAM)).toBeNull();
  });
});
