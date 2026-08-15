import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '@payetam/shared';
import type { Clock } from '@payetam/platform';

/**
 * Telegram Mini App `initData` validation.
 *
 * This is the front door. Everything downstream trusts the user id this produces,
 * so it is written to be readable and audited rather than clever.
 *
 * The check, per Telegram's specification (ADR-0004):
 *
 *   1. Parse the query string; take `hash` out.
 *   2. Build the data-check-string: remaining pairs as `key=value`, sorted by key,
 *      joined with `\n`.
 *   3. secret  = HMAC_SHA256(key: "WebAppData", message: botToken)
 *   4. expected = HMAC_SHA256(key: secret, message: dataCheckString)
 *   5. Compare to `hash` in constant time.
 *   6. Reject if `auth_date` is older than the freshness window.
 *
 * Replay defence is deliberately NOT here: it needs Redis, and keeping this module
 * pure means the cryptography is unit-testable with no infrastructure. The caller
 * composes this with {@link InitDataReplayGuard}; steps 1-6 alone permit unlimited
 * reuse of a captured blob inside the freshness window.
 */

export interface InitDataUser {
  telegramUserId: bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface ParsedInitData {
  user: InitDataUser;
  authDate: Date;
  /** The verified hash, used by the replay guard as a one-time nonce. */
  hash: string;
  /** `/start` deep-link payload, e.g. a referral code. */
  startParam?: string;
}

/** Telegram rejects anything older than this; we match it rather than being laxer. */
export const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * Fields excluded from the data-check-string.
 *
 * `hash` is the value being verified. `signature` carries Telegram's newer Ed25519
 * third-party signature and is not part of the HMAC payload — including it makes
 * every check fail on clients that send it, which presents as "login works on some
 * devices and not others".
 */
const EXCLUDED_FROM_CHECK_STRING = new Set(['hash', 'signature']);

export class InitDataValidator {
  constructor(
    private readonly botToken: string,
    private readonly clock: Clock,
    private readonly maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
  ) {
    if (!botToken) {
      // A misconfigured validator would accept nothing, which looks like a bug in
      // the client. Fail where the cause is obvious instead.
      throw new Error('InitDataValidator requires a bot token');
    }
  }

  validate(rawInitData: string): ParsedInitData {
    if (typeof rawInitData !== 'string' || rawInitData.length === 0) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    const params = new URLSearchParams(rawInitData);

    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    const dataCheckString = [...params.entries()]
      .filter(([key]) => !EXCLUDED_FROM_CHECK_STRING.has(key))
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    const secret = createHmac('sha256', 'WebAppData').update(this.botToken).digest();
    const expected = createHmac('sha256', secret).update(dataCheckString).digest();

    let provided: Buffer;
    try {
      provided = Buffer.from(hash, 'hex');
    } catch {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    // timingSafeEqual throws on a length mismatch, so guard it first.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    // Only now, with the signature verified, is any of this data trustworthy.
    const authDate = this.parseAuthDate(params.get('auth_date'));
    const ageSeconds = (this.clock.now().getTime() - authDate.getTime()) / 1000;

    if (ageSeconds > this.maxAgeSeconds) {
      throw new AppError(ErrorCode.INIT_DATA_EXPIRED);
    }

    // A clock-skewed client could produce a slightly future auth_date; a wildly
    // future one means the value is not what it claims to be.
    if (ageSeconds < -this.maxAgeSeconds) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    const user = this.parseUser(params.get('user'));
    const startParam = params.get('start_param');

    return {
      user,
      authDate,
      hash: hash.toLowerCase(),
      ...(startParam ? { startParam } : {}),
    };
  }

  private parseAuthDate(raw: string | null): Date {
    if (!raw) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }
    return new Date(seconds * 1000);
  }

  private parseUser(raw: string | null): InitDataUser {
    if (!raw) {
      // Telegram omits `user` when the Mini App is opened from an inline context.
      // We cannot identify anyone in that case, so it is a rejection, not a guess.
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    if (typeof payload !== 'object' || payload === null) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    const record = payload as Record<string, unknown>;
    const id = record['id'];

    // Telegram sends the id as a JSON number. It is stored as BIGINT because ids
    // have outgrown 2^32 and will eventually strain Number.MAX_SAFE_INTEGER.
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }

    const optionalString = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };

    const firstName = optionalString('first_name');
    const lastName = optionalString('last_name');
    const username = optionalString('username');
    const languageCode = optionalString('language_code');

    return {
      telegramUserId: BigInt(id),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(username ? { username } : {}),
      ...(languageCode ? { languageCode } : {}),
    };
  }
}
