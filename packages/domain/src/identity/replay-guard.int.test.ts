import { afterAll, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import { RedisService } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { INIT_DATA_REPLAY_PREFIX, InitDataReplayGuard } from './replay-guard';

/**
 * One-time use of a verified `initData` hash, against a **real Redis**.
 *
 * The Launch Readiness Report carries this as a gap in §4, and states the reason it
 * matters: the guard *works* — the response-leak scan would fail without it, because
 * that scan has to sign fresh `initData` for every call — but "works, and the suite
 * would notice if it stopped" is weaker than an assertion, and this is *the* defence
 * against a captured blob being reused inside the freshness window.
 *
 * Real Redis rather than a fake map, for the same reason the rate limiter uses one:
 * the property under test is `SET NX`'s atomicity, and a fake would pass while
 * proving nothing about it. Criterion 13's "replayed ⇒ 401" is the half this closes.
 */

const env = {
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:56379',
} as unknown as Env;

const redis = new RedisService(env);
const guard = new InitDataReplayGuard(redis);

/** Distinct per test, so this suite cannot collide with itself or a parallel run. */
let counter = 0;
function hash(): string {
  counter += 1;
  return `test-hash-${String(process.pid)}-${String(counter)}`.padEnd(64, '0');
}

async function expectRefused(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    // Deliberately the same code as a bad signature: distinguishing "already used"
    // from "invalid" would tell an attacker their captured blob was genuine.
    expect((error as AppError).code).toBe(ErrorCode.INVALID_INIT_DATA);
    return;
  }
  throw new Error('expected the replay to be refused, but it was accepted');
}

afterAll(async () => {
  await redis.client.quit();
});

describe('InitDataReplayGuard', () => {
  it('accepts a hash the first time', async () => {
    await expect(guard.consume(hash())).resolves.toBeUndefined();
  });

  it('refuses the same hash the second time', async () => {
    const value = hash();
    await guard.consume(value);
    await expectRefused(guard.consume(value));
  });

  it('refuses every attempt after the first, not merely the second', async () => {
    const value = hash();
    await guard.consume(value);
    await expectRefused(guard.consume(value));
    await expectRefused(guard.consume(value));
  });

  it('lets exactly one of ten concurrent claims through', async () => {
    // The case the guard exists for and the one a sequential test cannot reach: a
    // captured blob replayed in parallel. `SET NX` is what makes this safe rather
    // than merely unlikely.
    const value = hash();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => guard.consume(value)),
    );

    const accepted = results.filter((result) => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(9);
  });

  it('keeps different hashes independent', async () => {
    const first = hash();
    await guard.consume(first);
    await expect(guard.consume(hash())).resolves.toBeUndefined();
  });

  it('sets a TTL, so a claim does not occupy Redis forever', async () => {
    const value = hash();
    await guard.consume(value);

    const ttl = await redis.client.ttl(`${INIT_DATA_REPLAY_PREFIX}${value}`);
    // The freshness window plus a margin: once a blob is too old to validate,
    // remembering it protects nothing and only costs memory.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(360);
  });
});
