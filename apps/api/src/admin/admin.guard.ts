import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AdminAccessService, type AdminSession } from '@payetam/domain';
import { AppError, ErrorCode } from '@payetam/shared';

/** The cookie the panel carries, and the header it echoes. */
export const ADMIN_SESSION_COOKIE = 'payetam_admin_session';
export const CSRF_HEADER = 'x-csrf-token';

const PUBLIC_ADMIN_ROUTE = 'admin:public';

/** Login itself cannot require a session. Nothing else may use this. */
export const PublicAdminRoute = (): MethodDecorator => SetMetadata(PUBLIC_ADMIN_ROUTE, true);

/**
 * The resolved staff session, for a controller that needs it.
 *
 * A controller reads it and passes it to a service; the *service* is what decides
 * whether the session may do the thing (ADR-0010, rule 2). This decorator carries
 * the identity, never the authorisation.
 */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AdminSession => {
    const request = context.switchToHttp().getRequest<{ adminSession?: AdminSession }>();
    if (!request.adminSession) throw new AppError(ErrorCode.UNAUTHENTICATED);
    return request.adminSession;
  },
);

/**
 * Authentication for `/admin/v1` (ADR-0010).
 *
 * Three differences from the Mini App's guard, all deliberate:
 *
 * **Cookies, not bearer tokens.** The panel is a normal browser application, so it
 * has normal browser threats and gets the normal browser defences: `HttpOnly` so
 * script cannot read the session, `Secure` so it never crosses plaintext,
 * `SameSite=Lax` so it does not ride a cross-site navigation. The Mini App uses
 * bearer tokens because Telegram's WebView cookie behaviour is unreliable
 * (ADR-0004) — different environment, different answer.
 *
 * **A CSRF token on every mutation.** `SameSite=Lax` still permits top-level GET
 * navigations, so a cookie alone is not sufficient for state-changing requests.
 * The token is a second value the panel holds in memory and echoes in a header,
 * which a cross-site form post cannot read or set.
 *
 * **The session is re-read from Redis on every request** rather than verified from a
 * signature, so revoking one takes effect immediately.
 *
 * This guard authenticates and stops there. **Authorisation is the service's job**
 * — a guard that also checked permissions would protect these routes and nothing
 * else, and the bot and the jobs reach the same services.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly access: AdminAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ADMIN_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<
      FastifyRequest & {
        cookies?: Record<string, string | undefined>;
        adminSession?: AdminSession;
      }
    >();

    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (token === undefined || token === '') throw new AppError(ErrorCode.UNAUTHENTICATED);

    const session = await this.access.resolveSession(token);
    if (!session) throw new AppError(ErrorCode.UNAUTHENTICATED);

    // Anything that is not a read has to prove it came from the panel and not
    // from somebody else's page. Compared as strings rather than in constant
    // time: the token is high-entropy and single-use per session, and a timing
    // oracle on it buys nothing an attacker who can already read it does not have.
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const submitted = request.headers[CSRF_HEADER];
      if (typeof submitted !== 'string' || submitted !== session.csrfToken) {
        throw new AppError(ErrorCode.FORBIDDEN, { reason: 'csrf' });
      }
    }

    request.adminSession = session;
    return true;
  }
}
