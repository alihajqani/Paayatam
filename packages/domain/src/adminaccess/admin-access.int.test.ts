import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { AdminAccessService, MAX_FAILED_ATTEMPTS } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { ROLE_KEYS, PERMISSIONS } from './permissions';
import { base32Decode, totpCode } from './totp';

/**
 * Admin authentication (M12, ADR-0010 D11).
 *
 * Three factors are checked here and one of them is the *account*: email, password
 * and TOTP, with lockout counting failures at both the password and the code. A
 * panel that can move currency and read private conversations gets deliberate
 * friction, and this is where the friction is asserted.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = {
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:56379',
} as unknown as Env;

const credentials = new AdminCredentials(env);
const audit = new AuditService(service, clock);

// The real `RedisService`, because sessions live in Redis and a stub would test
// the stub. Session keys are random per login, so this suite cannot collide with
// anything else using the same instance.
const redis = new RedisService(env);
const access = new AdminAccessService(service, clock, redis, credentials, audit);

const PASSWORD = 'a-long-enough-admin-password';
let totpSecret: string;
let adminId: string;

function codeNow(offsetMs = 0): string {
  return totpCode(base32Decode(totpSecret), NOW.getTime() + offsetMs);
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);

  // Roles have to exist for `createAdmin` to grant them — the same seed the
  // deploy runs.
  for (const key of Object.values(ROLE_KEYS)) {
    await prisma.role.create({ data: { key, name: key } });
  }

  const created = await access.createAdmin({
    email: 'Moderator@Payetam.test',
    password: PASSWORD,
    displayName: 'ناظر',
    roles: [ROLE_KEYS.MODERATOR],
  });
  adminId = created.adminUserId;
  totpSecret = created.totpSecret;
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.onModuleDestroy();
});

describe('logging in needs all three factors (D11)', () => {
  it('accepts the right email, password and code', async () => {
    const result = await access.login({
      email: 'moderator@payetam.test',
      password: PASSWORD,
      totpCode: codeNow(),
    });

    expect(result.session.roles).toEqual([ROLE_KEYS.MODERATOR]);
    expect(result.session.permissions).toContain(PERMISSIONS.EVENT_MODERATE);
    // Two distinct secrets: one is stolen by reading a cookie, the other is not.
    expect(result.sessionToken).not.toBe(result.csrfToken);
  });

  /** CITEXT: `Ali@x.com` and `ali@x.com` are one account, not two. */
  it('treats the email case-insensitively', async () => {
    await expect(
      access.login({
        email: 'MODERATOR@PAYETAM.TEST',
        password: PASSWORD,
        totpCode: codeNow(),
      }),
    ).resolves.toMatchObject({ session: { displayName: 'ناظر' } });
  });

  it('refuses a wrong password', async () => {
    await expect(
      access.login({
        email: 'moderator@payetam.test',
        password: 'wrong-password',
        totpCode: codeNow(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  /** Having the password is not enough. That is the whole point of the second factor. */
  it('refuses a wrong TOTP code even with the right password', async () => {
    await expect(
      access.login({ email: 'moderator@payetam.test', password: PASSWORD, totpCode: '000000' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('refuses a code from two time steps ago', async () => {
    await expect(
      access.login({
        email: 'moderator@payetam.test',
        password: PASSWORD,
        totpCode: codeNow(-90_000),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  /**
   * An unknown email answers exactly like a wrong password. Distinguishing them
   * would turn this endpoint into an oracle for which staff addresses exist.
   */
  it('answers identically for an unknown account', async () => {
    await expect(
      access.login({ email: 'nobody@payetam.test', password: PASSWORD, totpCode: codeNow() }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('refuses a suspended account without saying so', async () => {
    await prisma.adminUser.update({ where: { id: adminId }, data: { status: 'SUSPENDED' } });

    await expect(
      access.login({ email: 'moderator@payetam.test', password: PASSWORD, totpCode: codeNow() }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });
});

describe('lockout (D11: five attempts)', () => {
  async function failOnce(): Promise<void> {
    await access
      .login({ email: 'moderator@payetam.test', password: 'wrong-password', totpCode: codeNow() })
      .catch(() => undefined);
  }

  it('locks the account after five failures', async () => {
    for (let index = 0; index < MAX_FAILED_ATTEMPTS; index += 1) await failOnce();

    // Correct credentials now, and still refused.
    await expect(
      access.login({ email: 'moderator@payetam.test', password: PASSWORD, totpCode: codeNow() }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  /**
   * The counter advances on a wrong *code* too, so somebody who has the password
   * but not the phone cannot brute-force six digits at leisure.
   */
  it('counts a wrong TOTP code as a failure', async () => {
    for (let index = 0; index < MAX_FAILED_ATTEMPTS; index += 1) {
      await access
        .login({ email: 'moderator@payetam.test', password: PASSWORD, totpCode: '000000' })
        .catch(() => undefined);
    }

    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    expect(row.failedAttempts).toBe(MAX_FAILED_ATTEMPTS);
    expect(row.lockedUntil).not.toBeNull();
  });

  it('lets a locked account back in once the window passes', async () => {
    for (let index = 0; index < MAX_FAILED_ATTEMPTS; index += 1) await failOnce();

    clock.set(new Date(NOW.getTime() + 2 * 60_000));
    await expect(
      access.login({
        email: 'moderator@payetam.test',
        password: PASSWORD,
        totpCode: totpCode(base32Decode(totpSecret), NOW.getTime() + 2 * 60_000),
      }),
    ).resolves.toMatchObject({ session: { displayName: 'ناظر' } });
  });

  it('resets the counter on a successful login', async () => {
    await failOnce();
    await failOnce();
    await access.login({
      email: 'moderator@payetam.test',
      password: PASSWORD,
      totpCode: codeNow(),
    });

    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    expect(row.failedAttempts).toBe(0);
  });

  /** A burst against one account is visible even when none of it succeeded. */
  it('records every failure in the audit log', async () => {
    await failOnce();
    await failOnce();

    const rows = await prisma.auditLog.findMany({ where: { action: 'admin.login_failed' } });
    expect(rows).toHaveLength(2);
  });
});

describe('sessions', () => {
  it('resolves a live session and forgets a logged-out one', async () => {
    const result = await access.login({
      email: 'moderator@payetam.test',
      password: PASSWORD,
      totpCode: codeNow(),
    });

    await expect(access.resolveSession(result.sessionToken)).resolves.toMatchObject({
      adminUserId: adminId,
    });

    await access.logout(result.sessionToken);
    await expect(access.resolveSession(result.sessionToken)).resolves.toBeNull();
  });

  it('resolves nothing for a token nobody issued', async () => {
    await expect(access.resolveSession('not-a-real-token')).resolves.toBeNull();
  });
});

describe('credentials at rest', () => {
  /** A TOTP secret in plaintext is a second factor a database dump defeats. */
  it('stores the TOTP secret encrypted, and round-trips it', async () => {
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    expect(row.totpSecretEnc).not.toContain(totpSecret);
    expect(credentials.decryptTotpSecret(row.totpSecretEnc)).toBe(totpSecret);
  });

  it('stores an argon2id hash, never the password', async () => {
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
  });

  it('refuses a password shorter than the minimum', async () => {
    await expect(credentials.hashPassword('short')).rejects.toThrow(/at least/);
  });

  /** A corrupted hash fails a login rather than taking the endpoint down. */
  it('returns false for a malformed hash instead of throwing', async () => {
    await expect(credentials.verifyPassword('not-a-hash', PASSWORD)).resolves.toBe(false);
  });
});
