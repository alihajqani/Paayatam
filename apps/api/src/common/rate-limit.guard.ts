import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  type CustomDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { RATE_LIMITS, RateLimitService, type RateLimitClass } from '@payetam/platform';
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
      // `RATE_LIMITED` carries a 429 and a Persian message from the catalogue. The
      // details say when to come back, which is the only actionable thing a
      // refused caller can be told.
      throw new AppError(ErrorCode.RATE_LIMITED, { retryAfterSeconds: verdict.resetSeconds });
    }

    return true;
  }
}
