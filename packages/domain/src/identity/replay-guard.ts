import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { DEFAULT_MAX_AGE_SECONDS } from './init-data.validator';

export const INIT_DATA_REPLAY_PREFIX = 'initdata:seen:';

/**
 * One-time use of a verified `initData` hash.
 *
 * Signature verification and the freshness window (see InitDataValidator) together
 * still allow a captured blob to be replayed as often as you like inside that
 * window — which is exactly long enough to matter if it leaks through a log, a
 * proxy, or a screenshot. This closes that.
 *
 * `SET key NX EX ttl` is atomic in Redis, so two concurrent requests carrying the
 * same hash cannot both win.
 *
 * TTL is the freshness window plus a small margin: once the blob is too old to pass
 * validation, remembering it protects nothing and only costs memory.
 */
@Injectable()
export class InitDataReplayGuard {
  /**
   * A plain field, not a constructor parameter with a default: Nest ignores default
   * values and would try to inject the `Number` type, failing at startup with
   * "can't resolve dependencies ... argument Number at index [1]".
   */
  private readonly ttlSeconds = DEFAULT_MAX_AGE_SECONDS + 60;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * Claims a hash for one-time use.
   *
   * @throws AppError(INVALID_INIT_DATA) if it was already used.
   */
  async consume(hash: string): Promise<void> {
    const stored = await this.redis.client.set(
      `${INIT_DATA_REPLAY_PREFIX}${hash}`,
      '1',
      'EX',
      this.ttlSeconds,
      'NX',
    );

    if (stored === null) {
      // Deliberately the same error code as a bad signature. Distinguishing
      // "already used" from "invalid" would tell an attacker their captured blob
      // was genuine.
      throw new AppError(ErrorCode.INVALID_INIT_DATA);
    }
  }
}
