import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../clock/clock';
import { RedisService } from '../redis/redis.service';

/** One bucket's policy: how many, over how long. */
export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** How many remain in the current window. Zero once refused. */
  remaining: number;
  /** Seconds until the window rolls over, for a `Retry-After` header. */
  resetSeconds: number;
}

/**
 * Redis token buckets, per subject and endpoint class (T12).
 *
 * **Fixed windows, not a sliding log.** A sliding window is more accurate and
 * needs a sorted set per subject with a member per request; a fixed window is one
 * counter and one TTL. The inaccuracy is real and bounded: a caller can spend a
 * full allowance at the end of one window and again at the start of the next, so
 * the true worst case is twice the limit over a short span. For "5 events a day"
 * and "30 messages a minute" that is a burst nobody notices, and the memory
 * profile is a single small key rather than an unbounded set that grows with
 * traffic — which matters precisely when the product is under the abuse this
 * exists to stop.
 *
 * **`INCR` then `EXPIRE`, in one round trip.** The order matters: setting the TTL
 * only on the first increment means a crash between the two leaves a key with no
 * expiry, and a counter that never resets locks somebody out permanently. Setting
 * it every time is one extra command and cannot strand anybody.
 *
 * **Failing open is deliberate, and needs a deadline to actually work.** If Redis
 * is unreachable, requests are allowed: a rate limiter that takes the product down
 * when its own dependency blinks has converted an availability problem into an
 * outage, and the abuse it defends against is a nuisance by comparison.
 *
 * A `try`/`catch` alone does not deliver that. `RedisService` sets
 * `maxRetriesPerRequest: null` — correct for a queue, where waiting for a reconnect
 * beats losing a job — which means an unreachable Redis makes commands *queue
 * indefinitely* rather than reject. Nothing throws, so nothing is caught, and every
 * request hangs until its own timeout: the failure mode is worse than either
 * failing open or failing closed. The deadline below is what turns "fails open"
 * from a claim in a comment into a behaviour, and the test for it points a client
 * at a dead port rather than stubbing an error, because a stub would have agreed
 * with the comment.
 */
@Injectable()
export class RateLimitService {
  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Count one request against a bucket.
   *
   * The key is `(class, subject, window)`, so buckets for different endpoint
   * classes never share an allowance — spending a day's event quota must not stop
   * somebody sending a chat message.
   */
  async consume(
    endpointClass: string,
    subject: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitVerdict> {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const window = Math.floor(nowSeconds / policy.windowSeconds);
    const key = `ratelimit:${endpointClass}:${subject}:${String(window)}`;
    const resetSeconds = (window + 1) * policy.windowSeconds - nowSeconds;

    try {
      const replies = await withDeadline(
        this.redis.client.multi().incr(key).expire(key, policy.windowSeconds).exec(),
      );
      const used = Number(replies?.[0]?.[1] ?? 0);

      return {
        allowed: used <= policy.limit,
        remaining: Math.max(policy.limit - used, 0),
        resetSeconds,
      };
    } catch {
      // See the note on the class: an unreachable or slow Redis allows the request.
      return { allowed: true, remaining: policy.limit, resetSeconds };
    }
  }

  /** Read a bucket without spending from it, for a header or a dry run. */
  async peek(
    endpointClass: string,
    subject: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitVerdict> {
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    const window = Math.floor(nowSeconds / policy.windowSeconds);
    const resetSeconds = (window + 1) * policy.windowSeconds - nowSeconds;

    try {
      const raw = await withDeadline(
        this.redis.client.get(`ratelimit:${endpointClass}:${subject}:${String(window)}`),
      );
      const used = raw === null ? 0 : Number(raw);
      return {
        allowed: used < policy.limit,
        remaining: Math.max(policy.limit - used, 0),
        resetSeconds,
      };
    } catch {
      return { allowed: true, remaining: policy.limit, resetSeconds };
    }
  }
}

/**
 * How long a rate-limit check may take before the request is allowed anyway.
 *
 * Deliberately short. This runs before every guarded request, so it is latency
 * every user pays; a local Redis answers in well under a millisecond, and anything
 * approaching a quarter of a second means Redis is in trouble — at which point the
 * right answer is to stop asking rather than to make every caller wait.
 */
const DEADLINE_MS = 250;

/** Resolve or reject within `DEADLINE_MS`, whatever the underlying promise does. */
async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('rate limit check timed out'));
        }, DEADLINE_MS);
        // The process must still be able to exit while a check is outstanding.
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The policies from T12, by endpoint class.
 *
 * Constants rather than `app_setting`, and this is the one place in the product
 * that deliberately breaks §4.2's "every policy number lives in the database". A
 * rate limit read from Postgres on every request is a database round trip added to
 * the hot path *and* a limiter that stops working when the database is the thing
 * under strain — which is the moment it matters most. These change by deploy.
 */
export const RATE_LIMITS = {
  /** Creating events: 5 a day (T12, and §11's quota is enforced separately). */
  EVENT_CREATE: { limit: 5, windowSeconds: 86_400 },
  /** Asking to join: 20 a day. */
  PARTICIPATION_JOIN: { limit: 20, windowSeconds: 86_400 },
  /** Chat messages: 30 a minute — M8 deferred this here explicitly. */
  CHAT_SEND: { limit: 30, windowSeconds: 60 },
  /** Reports: 10 a day. */
  REPORT_FILE: { limit: 10, windowSeconds: 86_400 },
  /**
   * Authentication, by IP rather than by user — there is no user yet.
   *
   * Not in T12's list, and added because it is the one endpoint an attacker can
   * reach without an account: `POST /auth/telegram` validates an HMAC, and
   * unlimited attempts at it is a free oracle.
   */
  AUTH: { limit: 30, windowSeconds: 60 },
  /** Admin login, by IP. The lockout is per account; this is per source. */
  ADMIN_LOGIN: { limit: 10, windowSeconds: 300 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitClass = keyof typeof RATE_LIMITS;

/**
 * Global, because the consumer is an `APP_GUARD`.
 *
 * A guard registered through `APP_GUARD` is instantiated in the **root** module's
 * injector, so its dependencies have to be resolvable there — importing a non-global
 * module into `AppModule` would work, and forgetting to is a failure that only shows
 * up when the process tries to boot. Which is exactly what happened: the guard was
 * wired and the service was provided by nothing, the API refused to start, and the
 * report was `process.abort()` with a native stack trace because that is Nest's
 * default on an initialisation error.
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
