import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import { FakeClock } from '../clock/clock';
import { RedisService } from '../redis/redis.service';
import { RATE_LIMITS, RateLimitService } from './rate-limit.service';

/**
 * The rate limiter (T12), against a **real Redis**.
 *
 * A stubbed Redis would test the stub. The properties that matter here are all
 * properties of the store: that `INCR` is atomic under concurrency, that the TTL is
 * actually set, and that a window rolls over when the clock crosses a boundary. A
 * fake map would pass all three while proving none of them.
 *
 * The clock is fake, though, and that is the point of injecting one — a fixed-window
 * limiter's whole behaviour is a function of `now`, and a test that had to wait
 * eighty-six thousand seconds for a daily window to roll would never be written.
 */

const env = {
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:56379',
} as unknown as Env;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const redis = new RedisService(env);
const limiter = new RateLimitService(redis, clock);

/**
 * A distinct subject per test, so this suite cannot collide with itself or with
 * anything else on the same Redis. Buckets expire on their own; nothing is torn
 * down.
 */
let counter = 0;
function subject(): string {
  counter += 1;
  return `test-subject-${String(process.pid)}-${String(counter)}`;
}

const POLICY = { limit: 3, windowSeconds: 60 };

beforeEach(() => {
  clock.set(NOW);
});

afterAll(async () => {
  await redis.onModuleDestroy();
});

describe('a bucket allows up to its limit and then refuses', () => {
  it('allows exactly `limit` requests', async () => {
    const who = subject();

    const verdicts = [];
    for (let i = 0; i < 5; i += 1) {
      verdicts.push(await limiter.consume('TEST', who, POLICY));
    }

    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false, false]);
  });

  it('counts down the remaining allowance and floors at zero', async () => {
    const who = subject();

    const remaining = [];
    for (let i = 0; i < 5; i += 1) {
      remaining.push((await limiter.consume('TEST', who, POLICY)).remaining);
    }

    expect(remaining).toEqual([2, 1, 0, 0, 0]);
  });

  /** A `Retry-After` a caller can act on, rather than "try again sometime". */
  it('reports seconds until the window rolls over', async () => {
    const verdict = await limiter.consume('TEST', subject(), POLICY);
    expect(verdict.resetSeconds).toBeGreaterThan(0);
    expect(verdict.resetSeconds).toBeLessThanOrEqual(POLICY.windowSeconds);
  });
});

describe('buckets are isolated', () => {
  /**
   * The failure this rules out is one allowance shared across the product: spending
   * a day's event quota must not stop somebody sending a chat message.
   */
  it('does not share an allowance between endpoint classes', async () => {
    const who = subject();

    for (let i = 0; i < 4; i += 1) await limiter.consume('EVENT_CREATE', who, POLICY);

    expect((await limiter.consume('DIRECT_MESSAGE_SEND', who, POLICY)).allowed).toBe(true);
  });

  it('does not share an allowance between subjects', async () => {
    const first = subject();
    const second = subject();

    for (let i = 0; i < 4; i += 1) await limiter.consume('TEST', first, POLICY);

    expect((await limiter.consume('TEST', second, POLICY)).allowed).toBe(true);
  });
});

describe('windows roll over', () => {
  it('restores the full allowance in the next window', async () => {
    const who = subject();
    for (let i = 0; i < 4; i += 1) await limiter.consume('TEST', who, POLICY);
    expect((await limiter.consume('TEST', who, POLICY)).allowed).toBe(false);

    clock.advance(POLICY.windowSeconds * 1000);

    expect(await limiter.consume('TEST', who, POLICY)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  /**
   * The documented inaccuracy of a fixed window, asserted rather than left as a
   * claim in a comment: a caller can spend a full allowance at the end of one window
   * and again at the start of the next. For "5 events a day" that burst is a
   * nuisance; the alternative is a sorted set per subject that grows with traffic,
   * precisely when the product is under the abuse this exists to stop.
   */
  it('permits twice the limit across a boundary, which is the accepted cost', async () => {
    const who = subject();
    // Land near the end of a window.
    clock.set(new Date(Math.floor(NOW.getTime() / 60_000) * 60_000 + 59_000));
    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.consume('TEST', who, POLICY)).allowed).toBe(true);
    }

    clock.advance(2_000);

    for (let i = 0; i < 3; i += 1) {
      expect((await limiter.consume('TEST', who, POLICY)).allowed).toBe(true);
    }
  });
});

describe('the key does not outlive its window', () => {
  /**
   * `EXPIRE` runs on **every** increment, not only the first. Setting it once means
   * a crash between the `INCR` and the `EXPIRE` leaves a counter with no TTL — and a
   * counter that never resets locks somebody out permanently. This asserts the TTL
   * is present after several increments, which is what that choice buys.
   */
  it('sets a TTL on every increment', async () => {
    const who = subject();
    for (let i = 0; i < 3; i += 1) await limiter.consume('TEST', who, POLICY);

    const window = Math.floor(NOW.getTime() / 1000 / POLICY.windowSeconds);
    const ttl = await redis.client.ttl(`ratelimit:TEST:${who}:${String(window)}`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(POLICY.windowSeconds);
  });
});

describe('concurrency', () => {
  /**
   * Twenty simultaneous requests against a limit of three must allow exactly three.
   * This is the property a naive `GET`-then-`SET` limiter gets wrong, and it is
   * wrong in the direction that matters: under a burst — the only time a rate
   * limiter does anything — it lets everything through.
   */
  it('allows exactly the limit when requests arrive together', async () => {
    const who = subject();

    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('TEST', who, POLICY)),
    );

    expect(verdicts.filter((v) => v.allowed)).toHaveLength(POLICY.limit);
  });
});

describe('peeking', () => {
  it('reads a bucket without spending from it', async () => {
    const who = subject();
    await limiter.consume('TEST', who, POLICY);

    expect((await limiter.peek('TEST', who, POLICY)).remaining).toBe(2);
    expect((await limiter.peek('TEST', who, POLICY)).remaining).toBe(2);
  });

  it('reports a full allowance for a subject that has spent nothing', async () => {
    expect(await limiter.peek('TEST', subject(), POLICY)).toMatchObject({
      allowed: true,
      remaining: POLICY.limit,
    });
  });
});

describe('failing open', () => {
  /**
   * If Redis is unreachable the request is **allowed**. A limiter that takes the
   * product down when its own dependency blinks has converted an availability
   * problem into an outage; the abuse it defends against is a nuisance by
   * comparison.
   *
   * Tested against a client pointed at a closed port rather than by stubbing, so
   * this exercises the real failure — a connection that never establishes.
   */
  it('allows the request when Redis cannot be reached', async () => {
    const broken = new RedisService({
      REDIS_URL: 'redis://127.0.0.1:1',
    } as unknown as Env);
    const degraded = new RateLimitService(broken, clock);

    try {
      const verdict = await degraded.consume('TEST', subject(), POLICY);
      expect(verdict).toMatchObject({ allowed: true, remaining: POLICY.limit });
    } finally {
      broken.client.disconnect();
    }
  });
});

describe('the configured policies', () => {
  /**
   * T12's numbers, asserted by name. They are constants rather than `app_setting`
   * rows — the one place the product deliberately breaks §4.2's "every policy number
   * lives in the database", because a limit read from Postgres per request is a
   * round trip on the hot path *and* a limiter that stops working when the database
   * is the thing under strain.
   */
  it('matches T12', () => {
    expect(RATE_LIMITS.EVENT_CREATE).toEqual({ limit: 5, windowSeconds: 86_400 });
    expect(RATE_LIMITS.PARTICIPATION_JOIN).toEqual({ limit: 20, windowSeconds: 86_400 });
    expect(RATE_LIMITS.DIRECT_MESSAGE_SEND).toEqual({ limit: 30, windowSeconds: 60 });
    expect(RATE_LIMITS.REPORT_FILE).toEqual({ limit: 10, windowSeconds: 86_400 });
  });

  it('gives every policy a positive limit and window', () => {
    for (const [name, policy] of Object.entries(RATE_LIMITS)) {
      expect(policy.limit, name).toBeGreaterThan(0);
      expect(policy.windowSeconds, name).toBeGreaterThan(0);
    }
  });
});
