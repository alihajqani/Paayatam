import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AdminAccessService,
  AdminOperationsService,
  ChatUnsealService,
  GiftCodeAdminService,
  type AdminSession,
  type GiftCodeSummary,
} from '@payetam/domain';
import { PiiHasher } from '@payetam/platform';
import {
  adjustCoinsRequest,
  adjustTrustRequest,
  adminLoginRequest,
  createGiftCodeRequest,
  decideCaseRequest,
  requestRoleChangeRequest,
  setGiftCodeActiveRequest,
  setUserStatusRequest,
  unsealChatRequest,
  type AdjustCoinsRequest,
  type AdjustTrustRequest,
  type AdminLoginRequest,
  type AdminLoginResponse,
  type AuditLogResponse,
  type CreateGiftCodeRequest,
  type DecideCaseRequest,
  type GiftCodeListResponse,
  type GiftCodeView,
  type ModerationCaseStatus,
  type ModerationQueueResponse,
  type RequestRoleChangeRequest,
  type SetGiftCodeActiveRequest,
  type SetUserStatusRequest,
  type UnsealChatRequest,
  type UnsealGrantResponse,
  type UnsealedChatResponse,
} from '@payetam/shared';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  ADMIN_SESSION_COOKIE,
  AdminAuthGuard,
  CurrentAdmin,
  PublicAdminRoute,
} from './admin.guard';

/**
 * The admin API (plan §6, ADR-0010).
 *
 * Every handler below does the same three things: resolve the session (the
 * guard), hand it to a service, and let the **service** decide whether that
 * session may do the thing. There is no permission check in this file, and that is
 * the design — ADR-0010 rule 2 puts authorisation in the service layer because a
 * controller guard protects one route while a service check protects every caller,
 * including the jobs and scripts that do not exist yet.
 *
 * The consequence worth stating: reading this controller tells you *what* the
 * panel can ask for, not *who* may ask. The RBAC matrix test answers the second
 * question, against the services.
 */
@Controller('admin/v1')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    private readonly access: AdminAccessService,
    private readonly operations: AdminOperationsService,
    private readonly unseal: ChatUnsealService,
    private readonly giftCodes: GiftCodeAdminService,
    private readonly pii: PiiHasher,
  ) {}

  /**
   * Email, password and TOTP — all three, always (D11).
   *
   * The session lands in an `HttpOnly` cookie the browser cannot read, and the
   * CSRF token comes back in the body for the panel to hold in memory and echo on
   * every mutation. Splitting them is the point: an attacker who can read one
   * cannot use it without the other.
   */
  @Post('auth/login')
  @RateLimit('ADMIN_LOGIN')
  @PublicAdminRoute()
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodValidationPipe(adminLoginRequest)) body: AdminLoginRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminLoginResponse> {
    const result = await this.access.login({
      email: body.email,
      password: body.password,
      totpCode: body.totpCode,
      ...(hashed(this.pii.hash(request.ip)) ?? {}),
    });

    reply.setCookie(ADMIN_SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/admin',
      maxAge: 60 * 60 * 12,
    });

    return {
      csrfToken: result.csrfToken,
      session: {
        email: result.session.email,
        displayName: result.session.displayName,
        roles: result.session.roles,
        permissions: result.session.permissions,
      },
    };
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: FastifyRequest & { cookies?: Record<string, string | undefined> },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const token = request.cookies?.[ADMIN_SESSION_COOKIE];
    if (token !== undefined) await this.access.logout(token);
    reply.clearCookie(ADMIN_SESSION_COOKIE, { path: '/admin' });
  }

  /** Who am I and what may I do. The panel hides buttons with this; nothing more. */
  @Get('me')
  me(@CurrentAdmin() admin: AdminSession): AdminLoginResponse['session'] {
    return {
      email: admin.email,
      displayName: admin.displayName,
      roles: admin.roles,
      permissions: admin.permissions,
    };
  }

  // ── Moderation queue ───────────────────────────────────────────────────────

  @Get('moderation/cases')
  async cases(
    @CurrentAdmin() admin: AdminSession,
    @Query('status') status?: string,
  ): Promise<ModerationQueueResponse> {
    const rows = await this.operations.listCases(admin, status as ModerationCaseStatus | undefined);
    return {
      cases: rows.map((row) => ({
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        status: row.status,
        trigger: row.trigger,
        reportCount: row.reportCount,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  @Post('moderation/cases/:id/decide')
  @HttpCode(HttpStatus.NO_CONTENT)
  async decide(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(decideCaseRequest)) body: DecideCaseRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<void> {
    await this.operations.decideCase(admin, id, {
      decision: body.decision,
      note: body.note,
      ...(body.falsePositive !== undefined ? { falsePositive: body.falsePositive } : {}),
    });
  }

  // ── Economy ────────────────────────────────────────────────────────────────

  /**
   * `POST /admin/v1/coins/adjust` (§6).
   *
   * Guarded by `coin.adjust`, which `SUPPORT` does not hold — ADR-0010 is explicit
   * about it and the plan tests it by name. Support is the role most exposed to
   * "please just put the coins back", which is why it is the role that cannot.
   */
  @Post('coins/adjust')
  async adjustCoins(
    @Body(new ZodValidationPipe(adjustCoinsRequest)) body: AdjustCoinsRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<{ balance: number }> {
    return this.operations.adjustCoins(admin, body);
  }

  @Post('trust/adjust')
  async adjustTrust(
    @Body(new ZodValidationPipe(adjustTrustRequest)) body: AdjustTrustRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<{ score: number }> {
    return this.operations.adjustTrust(admin, body);
  }

  /**
   * Gift codes (M18): mint, disable, and watch being drained.
   *
   * Guarded by `giftcode.manage`, which only `SUPER_ADMIN` holds — minting coins
   * out of nothing is the same class of capability as `coin.adjust`, and ADR-0010's
   * reasoning about `SUPPORT` applies without change. As everywhere else in this
   * controller the check is not here: it is in the service, so it holds for the
   * seeds and scripts that never pass through a controller at all.
   */
  @Post('gift-codes')
  async createGiftCode(
    @Body(new ZodValidationPipe(createGiftCodeRequest)) body: CreateGiftCodeRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<GiftCodeView> {
    const created = await this.giftCodes.create(admin, {
      code: body.code,
      coins: body.coins,
      maxRedemptions: body.maxRedemptions ?? null,
      perUserLimit: body.perUserLimit,
      startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
      expiresAt: body.expiresAt != null ? new Date(body.expiresAt) : null,
      note: body.note ?? null,
    });
    return toGiftCodeView(created);
  }

  @Get('gift-codes')
  async listGiftCodes(@CurrentAdmin() admin: AdminSession): Promise<GiftCodeListResponse> {
    const codes = await this.giftCodes.list(admin);
    return { codes: codes.map(toGiftCodeView) };
  }

  /**
   * The kill switch, separate from the expiry window.
   *
   * A campaign that has to stop *now* must not require back-dating a timestamp,
   * which is fiddly under pressure and leaves a lie in the record.
   */
  @Post('gift-codes/:code/active')
  async setGiftCodeActive(
    @Param('code') code: string,
    @Body(new ZodValidationPipe(setGiftCodeActiveRequest)) body: SetGiftCodeActiveRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<GiftCodeView> {
    return toGiftCodeView(await this.giftCodes.setActive(admin, code, body.isActive));
  }

  @Post('users/:publicId/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setUserStatus(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(setUserStatusRequest)) body: SetUserStatusRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<void> {
    await this.operations.setUserStatus(admin, { userPublicId: publicId, ...body });
  }

  // ── Break-glass (T14) ──────────────────────────────────────────────────────

  /**
   * `POST /admin/v1/chats/:id/unseal` (§6, §8).
   *
   * Refuses without `chat.read`, without an open case naming the chat, or without
   * a written reason — and grants fifteen minutes when all three hold. Reading is
   * a second call, so the grant and the reading are separate audited acts.
   */
  @Post('chats/:publicId/unseal')
  async unsealChat(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(unsealChatRequest)) body: UnsealChatRequest,
    @CurrentAdmin() admin: AdminSession,
    @Req() request: FastifyRequest,
  ): Promise<UnsealGrantResponse> {
    const grant = await this.unseal.grant(
      admin,
      publicId,
      body.reason,
      this.pii.hash(request.ip) ?? undefined,
    );
    return {
      grantId: grant.grantId,
      chatPublicId: grant.chatPublicId,
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  @Get('chats/unseal/:grantId')
  async readUnsealed(
    @Param('grantId') grantId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<UnsealedChatResponse> {
    const messages = await this.unseal.read(admin, grantId);
    return {
      messages: messages.map((message) => ({
        seq: message.seq,
        senderAlias: message.senderAlias,
        kind: message.kind,
        body: message.body,
        sentAt: message.sentAt.toISOString(),
        editedAt: message.editedAt?.toISOString() ?? null,
        deletedAt: message.deletedAt?.toISOString() ?? null,
      })),
    };
  }

  // ── Roles and audit ────────────────────────────────────────────────────────

  @Post('roles/requests')
  async requestRoleChange(
    @Body(new ZodValidationPipe(requestRoleChangeRequest)) body: RequestRoleChangeRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<{ requestId: string }> {
    return this.operations.requestRoleChange(admin, body);
  }

  @Post('roles/requests/:id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approveRoleChange(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<void> {
    await this.operations.approveRoleChange(admin, id);
  }

  @Get('audit')
  async audit(
    @CurrentAdmin() admin: AdminSession,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ): Promise<AuditLogResponse> {
    const entries = await this.operations.listAuditLog(admin, {
      ...(targetType !== undefined ? { targetType } : {}),
      ...(targetId !== undefined ? { targetId } : {}),
    });

    return {
      entries: entries.map((entry) => ({
        action: entry.action,
        actorType: entry.actorType,
        targetType: entry.targetType,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * `{ ipHash }` or nothing, never `{ ipHash: undefined }`.
 *
 * `exactOptionalPropertyTypes` distinguishes absent from present-and-undefined, and
 * `PiiHasher` returns null for both "no address" and "no pepper configured" — the
 * two cases the login path treats identically.
 */
function hashed(value: string | null): { ipHash: string } | undefined {
  return value === null ? undefined : { ipHash: value };
}

/**
 * Field by field, never a spread (§3.6 layer 2).
 *
 * A `gift_code` row carries the internal id and the staff account that minted it;
 * neither belongs on the wire. The domain summary has already dropped both — this
 * only turns its `Date`s into ISO-8601 UTC, which is what every other mapper in
 * the product does (ADR-0008).
 */
function toGiftCodeView(summary: GiftCodeSummary): GiftCodeView {
  return {
    code: summary.code,
    coins: summary.coins,
    maxRedemptions: summary.maxRedemptions,
    perUserLimit: summary.perUserLimit,
    redeemedCount: summary.redeemedCount,
    startsAt: summary.startsAt?.toISOString() ?? null,
    expiresAt: summary.expiresAt?.toISOString() ?? null,
    isActive: summary.isActive,
    note: summary.note,
    createdAt: summary.createdAt.toISOString(),
  };
}
