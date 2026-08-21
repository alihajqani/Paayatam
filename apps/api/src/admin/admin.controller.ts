import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  ReferralAdminService,
  type AdminSession,
  type GiftCodeSummary,
  type ReferralReview,
} from '@payetam/domain';
import { PiiHasher } from '@payetam/platform';
import {
  adjustCoinsRequest,
  adjustTrustRequest,
  adminLoginRequest,
  analyticsWindowQuery,
  bulkCreateGiftCodesRequest,
  createGiftCodeRequest,
  decideCaseRequest,
  giftCodeListQuery,
  pageQuery,
  referralListQuery,
  reinstateReferralRequest,
  rejectReferralRequest,
  requestRoleChangeRequest,
  setGiftCodeActiveRequest,
  setUserStatusRequest,
  unsealChatRequest,
  updateGiftCodeRequest,
  type AdjustCoinsRequest,
  type AdjustTrustRequest,
  type AdminLoginRequest,
  type AdminLoginResponse,
  type AnalyticsWindowQuery,
  type AuditLogResponse,
  type BulkCreateGiftCodesRequest,
  type BulkCreateGiftCodesResponse,
  type CampaignListResponse,
  type CreateGiftCodeRequest,
  type CreateGiftCodeResponse,
  type DecideCaseRequest,
  type GiftCodeAnalyticsResponse,
  type GiftCodeListQuery,
  type GiftCodeListResponse,
  type GiftCodeRedemptionsResponse,
  type GiftCodeView,
  type ModerationCaseStatus,
  type ModerationQueueResponse,
  type PageQuery,
  type ReferralListQuery,
  type ReferralListResponse,
  type ReferralReviewView,
  type ReinstateReferralRequest,
  type RejectReferralRequest,
  type RequestRoleChangeRequest,
  type SetGiftCodeActiveRequest,
  type SetUserStatusRequest,
  type UnsealChatRequest,
  type UnsealGrantResponse,
  type UnsealedChatResponse,
  type UpdateGiftCodeRequest,
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
    private readonly referrals: ReferralAdminService,
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
   * Gift codes (M18, campaigns in M19): mint one, mint a thousand, retune,
   * disable, and watch a campaign being drained.
   *
   * Guarded by `giftcode.manage`, which only `SUPER_ADMIN` holds — minting coins
   * out of nothing is the same class of capability as `coin.adjust`, and
   * ADR-0010's reasoning about `SUPPORT` applies without change. As everywhere
   * else in this controller the check is not here: it is in the service, so it
   * holds for the seeds and scripts that never pass through a controller at all.
   *
   * **Every route below addresses a code by `publicId`.** ADR-0016 explains why
   * at length; the short version is that a code is a bearer secret, and
   * `POST /gift-codes/NOWRUZ1405/active` writes it into the access log.
   */
  @Post('gift-codes')
  async createGiftCode(
    @Body(new ZodValidationPipe(createGiftCodeRequest)) body: CreateGiftCodeRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<CreateGiftCodeResponse> {
    const created = await this.giftCodes.create(admin, {
      code: body.code,
      coins: body.coins,
      maxRedemptions: body.maxRedemptions ?? null,
      perUserLimit: body.perUserLimit,
      startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
      expiresAt: body.expiresAt != null ? new Date(body.expiresAt) : null,
      campaign: body.campaign ?? null,
      note: body.note ?? null,
    });
    // The plaintext, and it is safe here for one reason only: the operator typed
    // it, so they already have it. `createBatch` is the case that is different.
    return { code: created.code, giftCode: toGiftCodeView(created.summary) };
  }

  /**
   * Mint a campaign of single-use codes, and hand them over **once**.
   *
   * This response is the only time these strings exist outside the database, and
   * nothing in the product returns them again — which is what makes bulk minting
   * safe to expose at all: what the panel does not keep, a stolen session cannot
   * read. The warning travels in the response rather than living in the panel, so
   * no surface can show the list without the sentence that explains it.
   */
  @Post('gift-codes/batch')
  async createGiftCodeBatch(
    @Body(new ZodValidationPipe(bulkCreateGiftCodesRequest)) body: BulkCreateGiftCodesRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<BulkCreateGiftCodesResponse> {
    const batch = await this.giftCodes.createBatch(admin, {
      count: body.count,
      coins: body.coins,
      prefix: body.prefix ?? null,
      length: body.length,
      maxRedemptions: body.maxRedemptions ?? null,
      perUserLimit: body.perUserLimit,
      startsAt: body.startsAt != null ? new Date(body.startsAt) : null,
      expiresAt: body.expiresAt != null ? new Date(body.expiresAt) : null,
      isActive: body.isActive,
      campaign: body.campaign ?? null,
      note: body.note ?? null,
    });

    return {
      batchId: batch.batchId,
      campaign: batch.campaign,
      codes: batch.codes,
      giftCodes: batch.summaries.map(toGiftCodeView),
      warningFa: GIFT_CODE_BATCH_WARNING_FA,
    };
  }

  @Get('gift-codes')
  async listGiftCodes(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(giftCodeListQuery)) query: GiftCodeListQuery,
  ): Promise<GiftCodeListResponse> {
    const page = await this.giftCodes.list(admin, {
      ...(query.campaign !== undefined ? { campaign: query.campaign } : {}),
      ...(query.batchId !== undefined ? { batchId: query.batchId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive === 'true' } : {}),
      ...(query.code !== undefined ? { code: query.code } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { codes: page.codes.map(toGiftCodeView), total: page.total };
  }

  /**
   * Retune a campaign's **future**.
   *
   * Nothing here can reach a redemption or a ledger row: `gift_code_redemption`
   * snapshots what was granted, and `coin_ledger` is append-only under a trigger.
   * Raising `coins` from 50 to 80 therefore leaves every past redemption reading
   * 50, which is correct and is what the panel says out loud (ADR-0016).
   */
  @Patch('gift-codes/:publicId')
  async updateGiftCode(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(updateGiftCodeRequest)) body: UpdateGiftCodeRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<GiftCodeView> {
    return toGiftCodeView(
      await this.giftCodes.update(admin, publicId, {
        ...(body.coins !== undefined ? { coins: body.coins } : {}),
        ...(body.maxRedemptions !== undefined
          ? { maxRedemptions: body.maxRedemptions ?? null }
          : {}),
        ...(body.perUserLimit !== undefined ? { perUserLimit: body.perUserLimit } : {}),
        ...(body.startsAt !== undefined
          ? { startsAt: body.startsAt == null ? null : new Date(body.startsAt) }
          : {}),
        ...(body.expiresAt !== undefined
          ? { expiresAt: body.expiresAt == null ? null : new Date(body.expiresAt) }
          : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.campaign !== undefined ? { campaign: body.campaign ?? null } : {}),
        ...(body.note !== undefined ? { note: body.note ?? null } : {}),
      }),
    );
  }

  /**
   * Everything a person can ask about one campaign (M19).
   *
   * Declared **before** `:publicId` would be, or a literal path segment gets
   * swallowed as an id — the same ordering rule the Mini App's router follows for
   * `/events/new`. Nest matches in declaration order, so `campaigns` has to come
   * first.
   */
  @Get('gift-codes/campaigns')
  async giftCodeCampaigns(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(analyticsWindowQuery)) query: AnalyticsWindowQuery,
  ): Promise<CampaignListResponse> {
    const rows = await this.giftCodes.campaigns(admin, toWindow(query));
    return {
      campaigns: rows.map((row) => ({
        campaign: row.campaign,
        codes: row.codes,
        activeCodes: row.activeCodes,
        redemptions: row.redemptions,
        coinsGranted: row.coinsGranted,
        uniqueUsers: row.uniqueUsers,
        firstRedeemedAt: row.firstRedeemedAt?.toISOString() ?? null,
        lastRedeemedAt: row.lastRedeemedAt?.toISOString() ?? null,
      })),
    };
  }

  @Get('gift-codes/:publicId/analytics')
  async giftCodeAnalytics(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(analyticsWindowQuery)) query: AnalyticsWindowQuery,
  ): Promise<GiftCodeAnalyticsResponse> {
    const report = await this.giftCodes.analytics(admin, publicId, toWindow(query));
    return {
      giftCode: toGiftCodeView(report.summary),
      successfulRedemptions: report.successfulRedemptions,
      uniqueUsers: report.uniqueUsers,
      coinsGranted: report.coinsGranted,
      failedAttempts: report.failedAttempts,
      failuresByReason: report.failuresByReason,
      firstRedeemedAt: report.firstRedeemedAt?.toISOString() ?? null,
      lastRedeemedAt: report.lastRedeemedAt?.toISOString() ?? null,
      trend: report.trend,
    };
  }

  /**
   * Who redeemed a code, and what they were actually granted.
   *
   * `coins` comes from the redemption row rather than from the campaign, which is
   * what lets the panel show that retuning a code did not rewrite what an older
   * redemption paid (ADR-0016).
   */
  @Get('gift-codes/:publicId/redemptions')
  async giftCodeRedemptions(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(pageQuery)) query: PageQuery,
  ): Promise<GiftCodeRedemptionsResponse> {
    const page = await this.giftCodes.redemptions(admin, publicId, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return {
      redemptions: page.redemptions.map((row) => ({
        userPublicId: row.userPublicId,
        seq: row.seq,
        coins: row.coins,
        createdAt: row.createdAt.toISOString(),
      })),
      total: page.total,
    };
  }

  /**
   * The kill switch, separate from the expiry window.
   *
   * A campaign that has to stop *now* must not require back-dating a timestamp,
   * which is fiddly under pressure and leaves a lie in the record. Kept as its own
   * route beside `PATCH` for exactly that reason: under pressure, one button.
   */
  @Post('gift-codes/:publicId/active')
  async setGiftCodeActive(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(setGiftCodeActiveRequest)) body: SetGiftCodeActiveRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<GiftCodeView> {
    return toGiftCodeView(await this.giftCodes.setActive(admin, publicId, body.isActive));
  }

  // ── Referral review (M19, T6) ──────────────────────────────────────────────

  /**
   * The fraud queue T6 has been writing signals into since M9.
   *
   * `referral.manage`, held by `SUPER_ADMIN` and `MODERATOR`. Nothing behind it
   * can pay anybody — a rejection withholds a reward that has not been earned
   * and a reinstatement only restores the chance to earn it — which is why it is
   * not as narrow as `coin.adjust`.
   */
  @Get('referrals')
  async listReferrals(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(referralListQuery)) query: ReferralListQuery,
  ): Promise<ReferralListResponse> {
    const page = await this.referrals.list(admin, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.flagged !== undefined ? { flaggedOnly: query.flagged === 'true' } : {}),
      ...(query.referrerPublicId !== undefined ? { referrerPublicId: query.referrerPublicId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { referrals: page.referrals.map(toReferralReviewView), total: page.total };
  }

  @Get('referrals/:id')
  async getReferral(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ReferralReviewView> {
    return toReferralReviewView(await this.referrals.get(admin, id));
  }

  /**
   * Refuse a referral, in writing.
   *
   * A reason code **and** a note, both mandatory. §7 requires a signature and an
   * explanation on a terminal moderation decision, and this is the other terminal
   * decision in the product that withholds money.
   */
  @Post('referrals/:id/reject')
  async rejectReferral(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(rejectReferralRequest)) body: RejectReferralRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ReferralReviewView> {
    return toReferralReviewView(
      await this.referrals.reject(admin, id, { reason: body.reason, note: body.note }),
    );
  }

  /**
   * Put a rejected referral back into the ordinary path.
   *
   * **Pays nobody.** It restores `PENDING`; the referral then earns its reward
   * the ordinary way, with `ReferralService` checking the attendance itself. There
   * is deliberately no `REJECTED → QUALIFIED` edge — an admin may restore a
   * chance and may not grant a reward.
   */
  @Post('referrals/:id/reinstate')
  async reinstateReferral(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(reinstateReferralRequest)) body: ReinstateReferralRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ReferralReviewView> {
    return toReferralReviewView(await this.referrals.reinstate(admin, id, body.note));
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
 * A `gift_code` row carries the internal id, the staff account that minted it —
 * and **the code**, which from M19 is the field this mapper exists to keep off
 * the wire (ADR-0016). The domain summary has already dropped all three and
 * replaced the code with a mask; this only turns its `Date`s into ISO-8601 UTC,
 * which is what every other mapper in the product does (ADR-0008).
 */
function toGiftCodeView(summary: GiftCodeSummary): GiftCodeView {
  return {
    publicId: summary.publicId,
    codeMasked: summary.codeMasked,
    campaign: summary.campaign,
    batchId: summary.batchId,
    coins: summary.coins,
    maxRedemptions: summary.maxRedemptions,
    perUserLimit: summary.perUserLimit,
    redeemedCount: summary.redeemedCount,
    remainingRedemptions: summary.remainingRedemptions,
    startsAt: summary.startsAt?.toISOString() ?? null,
    expiresAt: summary.expiresAt?.toISOString() ?? null,
    isActive: summary.isActive,
    state: summary.state,
    note: summary.note,
    createdAt: summary.createdAt.toISOString(),
  };
}

/**
 * The sentence beside a freshly minted batch.
 *
 * In the response rather than in the panel, because the panel is not the only
 * thing that could ever call this, and a list of live codes shown without the
 * warning is precisely the failure being guarded against: an operator who assumes
 * they can come back for them later.
 */
const GIFT_CODE_BATCH_WARNING_FA =
  'این کدها فقط همین یک بار نمایش داده می‌شوند و پس از بستن این صفحه به‌هیچ‌وجه قابل بازیابی ' +
  'نیستند. همین حالا ذخیره‌شان کنید. اگر از دستشان دادید، این دسته را غیرفعال کنید و دستهٔ ' +
  'تازه‌ای بسازید.';

/**
 * An optional ISO window, as `Date`s, and never `{ from: undefined }`.
 *
 * `exactOptionalPropertyTypes` distinguishes absent from present-and-undefined,
 * and a bound the caller did not send has to be genuinely absent so the service
 * can tell "everything" from "everything after `Invalid Date`".
 */
function toWindow(query: AnalyticsWindowQuery): { from?: Date; to?: Date } {
  return {
    ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
    ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
  };
}

/**
 * Field by field, never a spread (§3.6 layer 2).
 *
 * `referral` carries two internal user ids and the ledger row that paid it. The
 * ids never leave the backend, and the ledger id belongs to the economy views
 * rather than to a fraud queue. `fraudSignals` and `reviewNote` are here because
 * this is the admin surface and they are what the review is *for* — neither
 * appears on anything a user can reach.
 */
function toReferralReviewView(review: ReferralReview): ReferralReviewView {
  return {
    id: review.id,
    referrerPublicId: review.referrerPublicId,
    referredPublicId: review.referredPublicId,
    status: review.status,
    flagged: review.flagged,
    fraudSignals: review.fraudSignals,
    qualifiedAt: review.qualifiedAt?.toISOString() ?? null,
    rejectedAt: review.rejectedAt?.toISOString() ?? null,
    rejectionReason: review.rejectionReason,
    reviewNote: review.reviewNote,
    createdAt: review.createdAt.toISOString(),
  };
}
