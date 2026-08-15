import {
  createParamDecorator,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionService, UserService } from '@payetam/domain';
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
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
