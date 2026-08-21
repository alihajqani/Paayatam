import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuditService } from '@payetam/domain';
import {
  METRICS,
  MetricsRegistry,
  PiiHasher,
  RATE_LIMITS,
  RateLimitService,
  type RateLimitClass,
} from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import type { AuthenticatedUser } from '../auth/auth.guard';

const RATE_LIMIT_CLASS = 'rateLimit:class';

/**
 * Declares which bucket an endpoint spends from (T12).
 *
 * An endpoint with no decorator is **not** limited, which is the opposite of the
 * deny-by-default this codebase uses for authorisation — and deliberately. An
 * unlimited read is a performance question; an unlimited *write* is the abuse
 * vector, and the writes are enumerable. Applying a default limit to every GET
 * would mostly produce 429s on pagination.
 */
export const RateLimit = (limitClass: RateLimitClass): CustomDecorator =>
  SetMetadata(RATE_LIMIT_CLASS, limitClass);

/**
 * Spends from the caller's bucket before the handler runs.
 *
 * **Subject is the user when there is one, and the IP when there is not.** Keying
 * on the user is what makes the limit mean "per person" rather than "per network"
 * — a café, a university or a mobile carrier's NAT would otherwise share one
 * allowance between thousands of people. The IP fallback exists only for the
 * endpoints that have no user yet, which is where an attacker operates.
 *
 * Ordered **after** authentication in the guard chain, so `request.user` is
 * populated by the time the subject is chosen. Registered globally rather than per
 * controller so that adding an endpoint cannot accidentally skip it — the
 * decorator opts in, but the machinery is always present.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimitService,
    /**
     * Counted always, recorded once (M19).
     *
     * A refused request is the only externally visible sign of a sweep, and the
     * two consumers of that fact want different things: an alert wants a rate,
     * and an incident review six weeks later wants a row with a timestamp on it.
     * The counter serves the first and cannot serve the second — it resets on
     * deploy and is per-replica.
     */
    private readonly metrics: MetricsRegistry,
    private readonly audit: AuditService,
    private readonly pii: PiiHasher,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limitClass = this.reflector.getAllAndOverride<RateLimitClass>(RATE_LIMIT_CLASS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (limitClass === undefined) return true;

    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const subject = request.user?.publicId ?? `ip:${request.ip}`;

    const verdict = await this.limiter.consume(limitClass, subject, RATE_LIMITS[limitClass]);
    if (!verdict.allowed) {
      this.metrics.counter(METRICS.RATE_LIMITED, 'Requests refused by a rate limit bucket', {
        class: limitClass,
      });

      /**
       * **The first refusal in a window, and only the first.**
       *
       * Writing a row per refused request would make the audit trail the
       * amplification the limiter exists to prevent: a caller refused three
       * thousand times in an hour would produce three thousand inserts, on the
       * path that is already under load. `firstRefusal` is true exactly once per
       * `(class, subject, window)` — it is the `INCR` reply passing `limit + 1`,
       * not a second round trip — so this is at most one row per bucket per
       * window, which for `GIFT_CODE_REDEEM` is one an hour per account.
       *
       * A caller with an account is recorded by `public_id`; a caller without
       * one is recorded by a **peppered HMAC of their address** and never by the
       * address. ADR-0009 is unconditional about that, and the IP fallback exists
       * precisely for the traffic that has no account — which is the traffic a
       * crossing is most worth recording for.
       */
      if (verdict.firstRefusal) {
        await this.recordCrossing(limitClass, request);
      }

      // `RATE_LIMITED` carries a 429 and a Persian message from the catalogue. The
      // details say when to come back, which is the only actionable thing a
      // refused caller can be told.
      throw new AppError(ErrorCode.RATE_LIMITED, { retryAfterSeconds: verdict.resetSeconds });
    }

    return true;
  }

  /**
   * One `audit_log` row for a bucket somebody just ran out of.
   *
   * Never fatal. The caller is being told «تعداد درخواست‌های شما زیاد است» either
   * way, and turning a 429 into a 500 because a record could not be written is a
   * worse outcome than a gap in the trail — which the counter covers anyway.
   */
  private async recordCrossing(
    limitClass: RateLimitClass,
    request: FastifyRequest & { user?: AuthenticatedUser },
  ): Promise<void> {
    const ipHash = this.pii.hash(request.ip);
    try {
      await this.audit.record({
        actorType: request.user === undefined ? 'SYSTEM' : 'USER',
        ...(request.user !== undefined ? { actorId: request.user.publicId } : {}),
        action: 'ratelimit.exceeded',
        targetType: 'rate_limit',
        // The bucket, not the caller: `(class, window)` is what an operator
        // groups by, and the caller is already `actor_id` or `ip_hash`.
        targetId: limitClass,
        after: {
          class: limitClass,
          limit: RATE_LIMITS[limitClass].limit,
          windowSeconds: RATE_LIMITS[limitClass].windowSeconds,
          // Whether this was an account or an address, without saying which
          // address — the column below carries the peppered hash for that.
          keyedOn: request.user === undefined ? 'ip' : 'user',
        },
        ...(ipHash !== null ? { ipHash } : {}),
      });
    } catch {
      // See above.
    }
  }
}
