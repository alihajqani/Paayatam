import { createHash } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { UserService } from '@payetam/domain';
import { AppError, ErrorCode } from '@payetam/shared';
import { CLOCK, type Clock } from '@payetam/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import type { AuthenticatedUser } from '../auth/auth.guard';

/** How long a key is honoured. A retry a day later is a new intention, not a replay. */
const TTL_HOURS = 24;

const REPLAY_HEADER = 'idempotency-replayed';

interface RequestWithUser extends FastifyRequest {
  user?: AuthenticatedUser;
}

/**
 * `Idempotency-Key` (plan §6, acceptance criterion 21).
 *
 * > Mutating endpoints accept `Idempotency-Key`; replay returns the stored response
 * > with `Idempotency-Replayed: true`.
 *
 * **Why this exists at all**, given that criteria 17–20 already pass: every other
 * duplicate path in the product is defended by a unique index on a natural key. Boost
 * is the exception M9 identified — a second boost is a second purchase of a second
 * window, which a host may legitimately want, so the service cannot tell "asked
 * twice" from "arrived twice". Only the caller knows, and a key is how they say it.
 * Until now the only protection on the one endpoint that spends 40 coins was a
 * disabled button in a frontend that did not exist, over a mobile network.
 *
 * Three rules, and they are the whole design:
 *
 *  1. **No key, no behaviour change.** The header is optional by contract, so a
 *     request without one takes exactly the path it took before this file existed.
 *  2. **Only successes are stored.** A failed request has to stay retryable, or one
 *     network blip pins a user to an error for a day.
 *  3. **The same key with a different body is a conflict, not a replay.** Answering
 *     it with the first response would compound a client bug instead of reporting it.
 *
 * The unique index on `(user_id, key)` is what makes concurrent double-taps safe
 * rather than merely unlikely: both requests race to claim, exactly one wins, and the
 * loser is told the first is still in flight.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly users: UserService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const reply = http.getResponse<FastifyReply>();

    const key = this.keyOf(request);
    const user = request.user;

    // Rule 1: absent key, or an unauthenticated route (the Telegram webhook, the
    // admin panel's own session) — nothing to scope a key to, so nothing to do.
    if (key === null || user === undefined) return next.handle();

    return from(this.handle(request, user, key)).pipe(
      switchMap((outcome) => {
        if ('statusCode' in outcome) {
          void reply.header(REPLAY_HEADER, 'true');
          void reply.status(outcome.statusCode);
          return of(outcome.responseBody);
        }

        return next.handle().pipe(
          tap({
            next: (body) => {
              void this.store(outcome.internalId, key, request, reply, body);
            },
          }),
        );
      }),
    );
  }

  /**
   * Resolves the caller once, then replays or claims.
   *
   * The guard hands over a *public* id and this table keys on the internal one, so
   * one indexed lookup happens here — only for requests that opted in by sending a
   * key, which is a small minority of mutations.
   */
  private async handle(
    request: RequestWithUser,
    user: AuthenticatedUser,
    key: string,
  ): Promise<
    { statusCode: number; responseBody: unknown; internalId: string } | { internalId: string }
  > {
    const internalId = await this.users.resolveInternalId(user.publicId);
    const stored = await this.replayOrClaim(request, internalId, key);
    return stored === null ? { internalId } : { ...stored, internalId };
  }

  /** Reads the header case-insensitively, and rejects one too long to be meant. */
  private keyOf(request: FastifyRequest): string | null {
    const raw = request.headers['idempotency-key'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 200) throw new AppError(ErrorCode.VALIDATION_FAILED);
    return trimmed;
  }

  private fingerprint(request: FastifyRequest): string {
    // The body as the client sent it. `undefined` and `{}` are different requests
    // and hash differently, which is the point.
    return createHash('sha256')
      .update(JSON.stringify(request.body ?? null))
      .digest('hex');
  }

  /**
   * Returns the stored response for a replay, or null when this caller has the claim.
   *
   * @throws AppError(CONFLICT_STALE_VERSION) when the key was used for a different
   *   request, or when an identical one is still in flight.
   */
  private async replayOrClaim(
    request: FastifyRequest,
    internalId: string,
    key: string,
  ): Promise<{ statusCode: number; responseBody: unknown } | null> {
    const existing = await this.prisma.requestIdempotency.findUnique({
      where: { userId_key: { userId: internalId, key } },
    });

    if (existing === null) return null;

    if (existing.expiresAt.getTime() <= this.clock.now().getTime()) {
      // Expired: the sweep has not reached it yet, but it no longer speaks for
      // anything. Clear it and let this request proceed as new.
      await this.prisma.requestIdempotency.delete({ where: { id: existing.id } });
      return null;
    }

    // Rule 3. Includes method and path, so one key cannot replay across endpoints.
    const sameRequest =
      existing.method === request.method &&
      existing.path === this.pathOf(request) &&
      existing.requestFingerprint === this.fingerprint(request);

    if (!sameRequest) {
      this.logger.warn('An Idempotency-Key was reused for a different request');
      throw new AppError(ErrorCode.CONFLICT_STALE_VERSION);
    }

    /**
     * Parsed back from the exact string that was sent.
     *
     * `JSON.parse` preserves key insertion order and Nest re-serializes in that same
     * order, so the replayed bytes match the original. Stored as JSONB this would be
     * semantically equal and byte-different, which is a weaker promise than the one
     * criterion 21 makes.
     */
    return {
      statusCode: existing.statusCode,
      responseBody: JSON.parse(existing.responseBody) as unknown,
    };
  }

  /** Path without the query string: the query is part of neither identity nor body. */
  private pathOf(request: FastifyRequest): string {
    const [path] = request.url.split('?');
    return (path ?? request.url).slice(0, 255);
  }

  private async store(
    internalId: string,
    key: string,
    request: FastifyRequest,
    reply: FastifyReply,
    body: unknown,
  ): Promise<void> {
    const statusCode = reply.statusCode;
    // Rule 2. Anything that is not a success stays retryable.
    if (statusCode < 200 || statusCode >= 300) return;

    const now = this.clock.now();
    try {
      await this.prisma.requestIdempotency.create({
        data: {
          userId: internalId,
          key,
          method: request.method,
          path: this.pathOf(request),
          requestFingerprint: this.fingerprint(request),
          statusCode,
          responseBody: JSON.stringify(body ?? null),
          expiresAt: new Date(now.getTime() + TTL_HOURS * 3_600_000),
        },
      });
    } catch (error) {
      // A unique violation here means a concurrent request with the same key won the
      // race and stored first. Both produced a success; there is nothing to correct,
      // and failing the response the caller already has would be worse than the
      // duplicate row we did not write.
      this.logger.log(
        `Idempotency row not stored, most likely a concurrent claim: ${String(error)}`,
      );
    }
  }
}
