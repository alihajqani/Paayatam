import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, RedisService, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { AdminCredentials } from './admin-credentials';
import { ROLE_PERMISSIONS, type Permission, type RoleKey } from './permissions';
import { base32Decode, verifyTotp } from './totp';

/** Redis namespace, deliberately disjoint from the Mini App's (ADR-0010). */
const SESSION_PREFIX = 'admin:session:';

/** Five failures, then a lockout that grows (D11). */
export const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_STEPS_MINUTES = [1, 5, 15, 60, 240];

export interface AdminSession {
  adminUserId: string;
  email: string;
  displayName: string;
  roles: RoleKey[];
  permissions: Permission[];
}

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  session: AdminSession;
}

/**
 * Staff identity and authorisation (ADR-0010).
 *
 * Three decisions are worth reading before the code:
 *
 * **The identity system is separate, and the separation is the security control.**
 * `admin_user` has no foreign key to `user`, the session namespace is disjoint
 * from the Mini App's, and the token format is different. A privilege-escalation
 * bug in user-facing code therefore cannot become an admin compromise, and admin
 * access does not follow from a staff member's personal Telegram being taken over.
 *
 * **Authorisation is checked here, not in a controller guard.** A guard protects
 * one route; a service check protects every caller, including the jobs and scripts
 * that do not exist yet. `assertPermission` is the only way in, and it throws.
 *
 * **Deny by default.** `permissionsFor` starts from an empty set and adds only
 * what a role grants. An admin with no roles can reach nothing, and an endpoint
 * that forgets to declare a permission is unreachable rather than open — which is
 * the failure mode worth having.
 */
@Injectable()
export class AdminAccessService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RedisService) private readonly redis: RedisService,
    private readonly credentials: AdminCredentials,
    private readonly audit: AuditService,
  ) {}

  /**
   * Email, password **and** TOTP. All three, always.
   *
   * Every failure answers identically — `INVALID_CREDENTIALS` — whether the email
   * is unknown, the password is wrong, the code is wrong or the account is
   * suspended. Distinguishing them would turn this endpoint into an oracle for
   * which staff addresses exist, which is the first thing an attacker wants.
   *
   * The lockout counter advances on a wrong password *and* on a wrong code, so
   * somebody who has the password but not the phone cannot brute-force six digits
   * at leisure.
   */
  async login(input: {
    email: string;
    password: string;
    totpCode: string;
    ipHash?: string;
  }): Promise<LoginResult> {
    const now = this.clock.now();

    const admin = await this.prisma.adminUser.findUnique({
      where: { email: input.email.trim() },
      include: { roles: { include: { role: true } } },
    });

    if (!admin) {
      // Still costs a hash, so a missing account is not distinguishable by how
      // fast this returns. Cheap insurance against user enumeration by timing.
      await this.credentials.verifyPassword(DUMMY_HASH, input.password);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    if (admin.lockedUntil !== null && admin.lockedUntil > now) {
      await this.recordFailure(admin.id, 'locked', input.ipHash);
      throw new AppError(ErrorCode.ACCOUNT_LOCKED);
    }
    if (admin.status !== 'ACTIVE') {
      await this.recordFailure(admin.id, 'inactive', input.ipHash);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    const passwordOk = await this.credentials.verifyPassword(admin.passwordHash, input.password);
    if (!passwordOk) {
      await this.countFailure(admin.id, admin.failedAttempts, now, 'password', input.ipHash);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    const secret = base32Decode(this.credentials.decryptTotpSecret(admin.totpSecretEnc));
    if (!verifyTotp(secret, input.totpCode, now.getTime())) {
      await this.countFailure(admin.id, admin.failedAttempts, now, 'totp', input.ipHash);
      throw new AppError(ErrorCode.INVALID_CREDENTIALS);
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now },
    });

    const roles = admin.roles.map((row) => row.role.key as RoleKey);
    const session: AdminSession = {
      adminUserId: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      roles,
      permissions: permissionsFor(roles),
    };

    // 256 bits from a CSPRNG. The session token is a bearer secret in a cookie and
    // the CSRF token is a separate value the panel echoes in a header — one
    // defends against theft, the other against a cross-site form post, and reusing
    // one value for both would defeat the second.
    const sessionToken = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');

    await this.redis.client.set(
      `${SESSION_PREFIX}${sessionToken}`,
      JSON.stringify({ ...session, csrfToken }),
      'EX',
      SESSION_TTL_SECONDS,
    );

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'admin.login',
      targetType: 'admin_user',
      targetId: admin.id,
      after: { roles },
      ...(input.ipHash !== undefined ? { ipHash: input.ipHash } : {}),
    });

    return { sessionToken, csrfToken, session };
  }

  /**
   * The session behind a cookie, or null.
   *
   * Re-read from Redis on every request rather than trusted from a signed token,
   * which is what makes revocation immediate: removing the key logs somebody out
   * now, not when their token happens to expire. The Mini App makes the opposite
   * trade for its access token (ADR-0004) because a fifteen-minute JWT is cheap to
   * outlast; a panel that can move currency is not.
   */
  async resolveSession(
    sessionToken: string,
  ): Promise<(AdminSession & { csrfToken: string }) | null> {
    const raw = await this.redis.client.get(`${SESSION_PREFIX}${sessionToken}`);
    if (raw === null) return null;

    // Sliding idle timeout: an admin working through a queue stays signed in, one
    // who walked away does not.
    await this.redis.client.expire(`${SESSION_PREFIX}${sessionToken}`, SESSION_TTL_SECONDS);
    return JSON.parse(raw) as AdminSession & { csrfToken: string };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.redis.client.del(`${SESSION_PREFIX}${sessionToken}`);
  }

  /**
   * **The authorisation check.** Throws, so a caller cannot forget to read it.
   *
   * Every mutating admin path calls this before doing anything, and it is what
   * invariant 12 means by "checked in the service layer". Returning a boolean
   * would make the safe usage and the unsafe usage look the same at the call site.
   */
  assertPermission(session: AdminSession, permission: Permission): void {
    if (!session.permissions.includes(permission)) {
      throw new AppError(ErrorCode.FORBIDDEN, { required: permission });
    }
  }

  /** Whether an admin holds a permission, for read paths that shape a response. */
  can(session: AdminSession, permission: Permission): boolean {
    return session.permissions.includes(permission);
  }

  /**
   * Create a staff account.
   *
   * Returns the TOTP secret **once**, in plaintext, because the authenticator app
   * has to be provisioned with it and the stored copy is encrypted. It is never
   * readable again — a lost authenticator is an out-of-band recovery procedure
   * (ADR-0010's stated consequence), not a "show me the secret" endpoint.
   */
  async createAdmin(input: {
    email: string;
    password: string;
    displayName: string;
    roles: RoleKey[];
    actorAdminId?: string;
  }): Promise<{ adminUserId: string; totpSecret: string }> {
    const totpSecret = this.credentials.generateTotpSecret();
    const passwordHash = await this.credentials.hashPassword(input.password);

    const created = await this.prisma.$transaction(async (tx) => {
      const admin = await tx.adminUser.create({
        data: {
          email: input.email.trim(),
          passwordHash,
          totpSecretEnc: this.credentials.encryptTotpSecret(totpSecret),
          displayName: input.displayName,
        },
        select: { id: true },
      });

      await this.grantRoles(tx, admin.id, input.roles);

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: input.actorAdminId ?? admin.id,
          action: 'admin.created',
          targetType: 'admin_user',
          targetId: admin.id,
          // The email is the account's identifier and belongs in the trail; the
          // secret and the hash never do.
          after: { email: input.email, roles: input.roles },
        },
        tx,
      );

      return admin;
    });

    return { adminUserId: created.id, totpSecret };
  }

  private async grantRoles(
    tx: Prisma.TransactionClient,
    adminUserId: string,
    roles: readonly RoleKey[],
  ): Promise<void> {
    if (roles.length === 0) return;

    const rows = await tx.role.findMany({
      where: { key: { in: [...roles] } },
      select: { id: true },
    });
    // A role named in code but missing from the table means the seed did not run;
    // silently granting fewer roles than asked for would be a permission bug
    // nobody notices until somebody cannot do their job.
    if (rows.length !== roles.length) throw new AppError(ErrorCode.INTERNAL_ERROR);

    await tx.adminUserRole.createMany({
      data: rows.map((row) => ({ adminUserId, roleId: row.id })),
      skipDuplicates: true,
    });
  }

  /**
   * Progressive lockout (D11).
   *
   * The delay grows with the number of failures rather than being a flat window,
   * because a flat window is a rate limit an attacker simply waits out. Recorded
   * in `audit_log` either way, so a burst of failures against one account is
   * visible even when none of them succeeded.
   */
  private async countFailure(
    adminUserId: string,
    previousFailures: number,
    now: Date,
    stage: string,
    ipHash?: string,
  ): Promise<void> {
    const attempts = previousFailures + 1;
    const lock =
      attempts >= MAX_FAILED_ATTEMPTS
        ? new Date(now.getTime() + lockoutMinutes(attempts) * 60_000)
        : null;

    await this.prisma.adminUser.update({
      where: { id: adminUserId },
      data: { failedAttempts: attempts, lockedUntil: lock },
    });

    await this.recordFailure(adminUserId, stage, ipHash, attempts);
  }

  private async recordFailure(
    adminUserId: string,
    stage: string,
    ipHash?: string,
    attempts?: number,
  ): Promise<void> {
    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'admin.login_failed',
      targetType: 'admin_user',
      targetId: adminUserId,
      // The stage says *which* factor failed, which a defender needs and an
      // attacker never sees — this goes to the audit log, not to the response.
      after: { stage, ...(attempts !== undefined ? { attempts } : {}) },
      ...(ipHash !== undefined ? { ipHash } : {}),
    });
  }
}

/** Twelve hours of idleness, refreshed on every request. */
const SESSION_TTL_SECONDS = 60 * 60 * 12;

/**
 * A real argon2id hash of a value nobody knows.
 *
 * Verified against when the email is unknown, so a missing account costs the same
 * time as a present one. Without it, "which of our staff addresses are real?" is
 * answerable with a stopwatch.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9yY29uc3RhbnR0aW1lY29tcGFyaXNvbg';

/** Deny by default: an empty set, plus whatever the roles actually grant. */
export function permissionsFor(roles: readonly RoleKey[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return [...granted];
}

function lockoutMinutes(attempts: number): number {
  const index = Math.min(attempts - MAX_FAILED_ATTEMPTS, LOCKOUT_STEPS_MINUTES.length - 1);
  return LOCKOUT_STEPS_MINUTES[index] ?? 1;
}
