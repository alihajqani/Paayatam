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
  /**
   * True on the **first** refusal in this window, and on no later one.
   *
   * It exists so that crossing a limit can be *recorded* without the recording
   * becoming the amplification the limiter exists to prevent: a caller refused
   * three thousand times in an hour must produce one row, not three thousand.
   * `INCR` already returns the running count, so this is a comparison rather
   * than a second round trip — the counter passing `limit + 1` happens exactly
   * once per window by construction.
   */
  firstRefusal: boolean;
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
        firstRefusal: used === policy.limit + 1,
      };
    } catch {
      // See the note on the class: an unreachable or slow Redis allows the request.
      return { allowed: true, remaining: policy.limit, resetSeconds, firstRefusal: false };
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
        // A dry run never crosses anything, so it can never be the crossing.
        firstRefusal: false,
      };
    } catch {
      return { allowed: true, remaining: policy.limit, resetSeconds, firstRefusal: false };
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
  /**
   * Direct messages: 30 a minute.
   *
   * Was `CHAT_SEND`, the relay's bucket, and it is the same number for the same
   * reason: this is the one thing in the product that sends text to a stranger,
   * and unmetered it is a way to make somebody's Telegram unusable. The relay is
   * gone (v0.8.0); leaving its limit behind while the feature that replaced it
   * ran unmetered would have been a regression introduced by a removal.
   */
  DIRECT_MESSAGE_SEND: { limit: 30, windowSeconds: 60 },
  /** Reports: 10 a day. */
  REPORT_FILE: { limit: 10, windowSeconds: 86_400 },
  /**
   * Bug reports: 5 an hour (v0.6.5).
   *
   * Its own bucket rather than `REPORT_FILE`'s, because the two are different
   * acts with different abuse shapes. A moderation report is about a person and
   * ten a day is generous; a bug report is about the product, arrives in bursts
   * when something is genuinely broken — somebody finds three problems in one
   * session and should send three — and each one can carry ten images. Hourly
   * rather than daily for the same reason: the limit is there to bound a loop,
   * not to ration a bad afternoon.
   */
  BUG_REPORT_FILE: { limit: 5, windowSeconds: 3_600 },
  /**
   * Profile edits: 10 an hour.
   *
   * Was 20 in M22 phase 2 and tightened on the operator's instruction. Still
   * generous for a person — nobody edits their bio ten times in an afternoon —
   * and half the room a script had. The reason it is bounded at all is that the
   * two fields it writes, `display_name` and `bio`, are the product's only
   * free-text user-authored surface outside a chat, and an unbounded write to a
   * moderated field is a way to cycle content faster than review can read it.
   */
  PROFILE_UPDATE: { limit: 10, windowSeconds: 3_600 },
  /**
   * Paid invitations: 10 a day (M22 phase 11).
   *
   * The coin cost is the real control — each one is ten coins — and this is the
   * backstop against a scripted loop finding a way past it. Ten a day is more
   * events than the daily quota allows anybody to create, so it cannot bind on a
   * legitimate host.
   */
  EVENT_INVITE: { limit: 10, windowSeconds: 86_400 },
  /**
   * Re-checking channel membership: 10 a minute (M22 phase 6).
   *
   * The one endpoint in the product where a tap becomes a Telegram call
   * synchronously. Ten a minute is far more than a person pressing «بررسی دوباره»
   * after joining, and low enough that a loop cannot spend the bot's budget on
   * `getChatMember` calls that other users' messages need.
   */
  MEMBERSHIP_CHECK: { limit: 10, windowSeconds: 60 },
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
  /**
   * Gift code redemption: 10 an hour (M18).
   *
   * Tighter than anything else a signed-in user does, because this is the only
   * endpoint in the product where **guessing pays**. A campaign code is short
   * enough to be typed by a human, which makes it short enough to be enumerated
   * by a script — and unlike a referral code, hitting one credits coins rather
   * than recording a relationship. Ten an hour makes a sweep of even a small
   * keyspace take longer than a campaign lasts.
   */
  GIFT_CODE_REDEEM: { limit: 10, windowSeconds: 3_600 },
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
