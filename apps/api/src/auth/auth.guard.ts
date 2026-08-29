import {
  createParamDecorator,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConsentService, SessionService, UserService } from '@payetam/domain';
import { AppError, ErrorCode } from '@payetam/shared';
import type { FastifyRequest } from 'fastify';

export const IS_PUBLIC = 'isPublic';
/** Opts an endpoint out of authentication. Everything else requires a session. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOW_PENDING_TERMS = 'allowPendingTerms';
/**
 * Allows an authenticated user who has not yet accepted the terms.
 * Only the policy and consent endpoints may use this — everything else is gated.
 */
export const AllowPendingTerms = () => SetMetadata(ALLOW_PENDING_TERMS, true);

export const REQUIRES_CURRENT_POLICIES = 'requiresCurrentPolicies';
/**
 * Refuses a user who has not accepted the **current** versions (M22 phase 8).
 *
 * ── Why this is opt-in, where the terms gate is deny-by-default ──────────────
 *
 * The first-acceptance gate reads `onboardingState`, which the guard already has
 * from the user row it re-reads on every request — it costs nothing. Re-acceptance
 * cannot be answered from that column: a user who accepted v2 and is being asked
 * for v3 is still `PROFILE_COMPLETE`. Answering it needs a count over `consent`,
 * and putting that on **every** request would be a query per read for a condition
 * that is false for almost everybody almost always.
 *
 * So it is declared per route, on the writes that matter — creating an event,
 * joining one, sending a message, spending coins. Reads stay open on purpose: a
 * user who has not yet accepted new terms should still be able to *read* them,
 * see their own profile and find the screen that asks. Locking the whole product
 * would mean the user could not reach the thing they are being asked to do.
 *
 * `ConsentService` caches "which versions are current" for thirty seconds, so the
 * cost of a decorated route is one indexed `COUNT` on `consent`.
 */
export const RequiresCurrentPolicies = () => SetMetadata(REQUIRES_CURRENT_POLICIES, true);

export interface AuthenticatedUser {
  publicId: string;
  onboardingState: 'NEW' | 'TERMS_ACCEPTED' | 'PROFILE_COMPLETE';
}

interface RequestWithUser extends FastifyRequest {
  user?: AuthenticatedUser;
}

/**
 * Authentication, plus the terms gate.
 *
 * Deny by default: an endpoint is protected unless it is explicitly `@Public()`.
 * The terms gate is enforced here rather than per-controller so that adding a new
 * endpoint cannot accidentally expose the product to someone who never accepted
 * the rules.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly users: UserService,
    private readonly consent: ConsentService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();

    /**
     * The admin API is a **different identity system** and this guard knows
     * nothing about it (ADR-0010).
     *
     * `/admin/v1` authenticates with a Redis-backed cookie and a CSRF token, not
     * with a Mini App bearer token, so applying this guard there would refuse
     * every staff request with an error about a header the panel never sends.
     * `AdminAuthGuard` is what protects those routes, and it is deny-by-default in
     * exactly the same way — an admin route with no session is refused, and one
     * with no *permission* is refused by the service beneath it.
     */
    if (request.url.startsWith('/admin/')) return true;

    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }

    const claims = await this.sessions.verifyAccessToken(header.slice('Bearer '.length));

    // Re-read the user on every request: a ban must take effect immediately, not
    // when the 15-minute access token happens to expire.
    const user = await this.users.findByPublicId(claims.sub);

    request.user = { publicId: user.publicId, onboardingState: user.onboardingState };

    const allowPendingTerms = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_TERMS, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!allowPendingTerms && user.onboardingState === 'NEW') {
      throw new AppError(ErrorCode.TERMS_NOT_ACCEPTED);
    }

    /**
     * Re-acceptance, on the routes that declare they need it (M22 phase 8).
     *
     * `POLICY_VERSION_STALE` rather than `TERMS_NOT_ACCEPTED`, and the difference
     * is what the client does about it: the first means "read the new version",
     * the second means "you have never accepted anything". Two situations, two
     * screens, two messages.
     */
    const requiresCurrent = this.reflector.getAllAndOverride<boolean>(REQUIRES_CURRENT_POLICIES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiresCurrent === true) {
      const internalId = await this.users.resolveInternalId(user.publicId);
      if (!(await this.consent.hasAcceptedCurrentPolicies(internalId))) {
        throw new AppError(ErrorCode.POLICY_VERSION_STALE);
      }
    }

    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      // Only reachable if a handler is used without the guard, which is a wiring bug.
      throw new AppError(ErrorCode.UNAUTHENTICATED);
    }
    return request.user;
  },
);
