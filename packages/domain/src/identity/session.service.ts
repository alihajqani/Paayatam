import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, RedisService, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';

const REFRESH_PREFIX = 'session:refresh:';
const REVOKED_FAMILY_PREFIX = 'session:revoked-family:';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface AccessTokenClaims {
  /** `user.public_id`. The internal id is never put in a token a client can read. */
  sub: string;
  onboardingState: string;
}

interface RefreshRecord {
  userPublicId: string;
  familyId: string;
  used: boolean;
}

/**
 * Mini App sessions (ADR-0004).
 *
 * `initData` is exchanged for our own tokens exactly once, so the expensive HMAC
 * check does not run per request and the freshness window can stay tight without
 * hurting usability.
 *
 * - **Access token**: a short-lived JWT. Stateless, so no Redis read per request.
 *   It carries `public_id`, never the internal id and never the Telegram id.
 * - **Refresh token**: opaque random bytes held in Redis, rotated on every use.
 *   A token that is presented twice means it leaked, so the whole family is revoked
 *   — the legitimate user is logged out, which is the correct outcome when their
 *   token is in someone else's hands.
 */
@Injectable()
export class SessionService {
  private readonly accessSecret: Uint8Array;
  private readonly refreshTtlSeconds: number;
  private readonly accessTtlSeconds: number;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {
    if (!env.JWT_ACCESS_SECRET || !env.JWT_REFRESH_SECRET) {
      throw new Error('SessionService requires JWT_ACCESS_SECRET and JWT_REFRESH_SECRET');
    }
    this.accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.accessTtlSeconds = parseDuration(env.JWT_ACCESS_TTL);
    this.refreshTtlSeconds = parseDuration(env.JWT_REFRESH_TTL);
  }

  async issue(
    userPublicId: string,
    onboardingState: string,
    familyId: string = randomId(),
  ): Promise<SessionTokens> {
    return this.mint(userPublicId, onboardingState, familyId);
  }

  /**
   * Validates and retires a refresh token, returning who it belonged to.
   *
   * Deliberately does not mint the replacement: the caller must re-read the user
   * first, so a session refreshed straight after onboarding reflects the new state
   * rather than the stale copy carried in the old token.
   *
   * Reuse detection: a token presented twice revokes its entire family.
   */
  async consumeRefreshToken(
    refreshToken: string,
  ): Promise<{ userPublicId: string; familyId: string }> {
    const key = `${REFRESH_PREFIX}${refreshToken}`;
    const raw = await this.redis.client.get(key);

    if (raw === null) {
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }

    const record = JSON.parse(raw) as RefreshRecord;

    if (await this.isFamilyRevoked(record.familyId)) {
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }

    if (record.used) {
      // Presented twice. Either the token leaked or a client is replaying it;
      // both mean we can no longer trust this chain of sessions.
      await this.revokeFamily(record.familyId);
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }

    // Mark used rather than deleting: deleting would make a replay indistinguishable
    // from an expired token, so the leak would go undetected.
    await this.redis.client.set(
      key,
      JSON.stringify({ ...record, used: true }),
      'EX',
      this.refreshTtlSeconds,
    );

    return { userPublicId: record.userPublicId, familyId: record.familyId };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.accessSecret, {
        issuer: 'payetam',
        audience: 'payetam-miniapp',
        clockTolerance: 5,
        currentDate: this.clock.now(),
      });

      const sub = payload.sub;
      const onboardingState = payload['onboardingState'];

      if (typeof sub !== 'string' || typeof onboardingState !== 'string') {
        throw new AppError(ErrorCode.UNAUTHENTICATED);
      }

      return { sub, onboardingState };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }
  }

  /** Used on ban and on logout. */
  async revokeFamily(familyId: string): Promise<void> {
    await this.redis.client.set(
      `${REVOKED_FAMILY_PREFIX}${familyId}`,
      '1',
      'EX',
      this.refreshTtlSeconds,
    );
  }

  private async isFamilyRevoked(familyId: string): Promise<boolean> {
    return (await this.redis.client.exists(`${REVOKED_FAMILY_PREFIX}${familyId}`)) === 1;
  }

  private async mint(
    userPublicId: string,
    onboardingState: string,
    familyId: string,
  ): Promise<SessionTokens> {
    const now = this.clock.now();

    const accessToken = await new SignJWT({ onboardingState })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userPublicId)
      .setIssuer('payetam')
      .setAudience('payetam-miniapp')
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + this.accessTtlSeconds)
      .sign(this.accessSecret);

    const refreshToken = randomId();
    const record: RefreshRecord = { userPublicId, familyId, used: false };

    await this.redis.client.set(
      `${REFRESH_PREFIX}${refreshToken}`,
      JSON.stringify(record),
      'EX',
      this.refreshTtlSeconds,
    );

    return { accessToken, refreshToken, expiresInSeconds: this.accessTtlSeconds };
  }
}

function randomId(): string {
  return randomBytes(32).toString('base64url');
}

/** Parses `15m` / `7d` / `3600`. Exported for its test. */
export function parseDuration(value: string): number {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'd':
      return amount * 86_400;
    case 'h':
      return amount * 3_600;
    case 'm':
      return amount * 60;
    default:
      return amount;
  }
}
