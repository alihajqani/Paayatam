import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AdminAccessService,
  AdminInsightService,
  BugReportService,
  type BugReportSummary,
  CatalogAdminService,
  ChannelAdminService,
  AdminOperationsService,
  ChatUnsealService,
  GeographyAdminService,
  GiftCodeAdminService,
  MessagingAdminService,
  PolicyAdminService,
  ReferralAdminService,
  type AdminSession,
  type ChannelConfigStatus,
  type RequiredChannelRecord,
  type CitySummary,
  type ConsentRecord,
  type MessageCampaignSummary,
  type EventSummary,
  type GiftCodeSummary,
  type PolicySummary,
  type ProvinceSummary,
  type TelegramIdentity,
  type ReferralReview,
  type UserSummary,
} from '@payetam/domain';
import type { Env } from '@payetam/config';
import { ENV, JOBS, PiiHasher, QUEUES, QueueService, jobId } from '@payetam/platform';
import { AppError, ErrorCode, PERMISSIONS, resolveVersion } from '@payetam/shared';
import {
  bugReportListQuery,
  updateBugReportRequest,
  type BugReportListQuery,
  type BugReportListResponse,
  type BugReportView,
  type UpdateBugReportRequest,
  adjustCoinsRequest,
  adjustTrustRequest,
  adminCityListQuery,
  adminPolicyListQuery,
  adminUpdateProfileRequest,
  adminAuditQuery,
  adminEventListQuery,
  adminLedgerQuery,
  adminLoginRequest,
  adminReportListQuery,
  adminUserListQuery,
  analyticsWindowQuery,
  bulkCreateGiftCodesRequest,
  createGiftCodeRequest,
  decideCaseRequest,
  decideReportRequest,
  giftCodeListQuery,
  moderateEventRequest,
  pageQuery,
  referralListQuery,
  reinstateReferralRequest,
  rejectReferralRequest,
  requestRoleChangeRequest,
  setGiftCodeActiveRequest,
  setUserStatusRequest,
  unsealChatRequest,
  updateGiftCodeRequest,
  createCityRequest,
  createMessageRequest,
  createPolicyDraftRequest,
  createProvinceRequest,
  policyConsentQuery,
  updateChannelConfigRequest,
  createRequiredChannelRequest,
  updateRequiredChannelRequest,
  reorderRequiredChannelsRequest,
  previewMessageRequest,
  reorderCitiesRequest,
  updateCityRequest,
  updateProvinceRequest,
  publishPolicyRequest,
  updatePolicyDraftRequest,
  updateSettingRequest,
  type AdjustCoinsRequest,
  type AdjustTrustRequest,
  type AdminCityListQuery,
  type ChannelConfigView,
  type RequiredChannelView,
  type CreateRequiredChannelRequest,
  type UpdateRequiredChannelRequest,
  type ReorderRequiredChannelsRequest,
  type UpdateChannelConfigRequest,
  type AdminCityListResponse,
  type AdminCityView,
  type AdminPolicyListQuery,
  type AdminProvinceListResponse,
  type AdminProvinceView,
  type AdminPolicyListResponse,
  type AdminPolicyView,
  type AdminUpdateProfileRequest,
  type CreateCityRequest,
  type CreateMessageRequest,
  type CreatePolicyDraftRequest,
  type CreateProvinceRequest,
  type ReorderCitiesRequest,
  type UpdateCityRequest,
  type UpdateProvinceRequest,
  type MessageCampaignListResponse,
  type MessageCampaignView,
  type MessagePreviewResponse,
  type PolicyConsentQuery,
  type PolicyConsentResponse,
  type PreviewMessageRequest,
  type TelegramIdentityView,
  type ProfileView,
  type PublishPolicyRequest,
  type UpdatePolicyDraftRequest,
  type AdminLoginRequest,
  type AdminAuditQuery,
  type AdminAuditResponse,
  type AdminDashboardResponse,
  type AdminEventListQuery,
  type AdminEventListResponse,
  type AdminEventView,
  type AdminLedgerQuery,
  type AdminLedgerResponse,
  type AdminLoginResponse,
  type AdminReportListQuery,
  type AdminReportListResponse,
  type AdminReportView,
  type AdminUserDetailView,
  type AdminUserListQuery,
  type AdminUserListResponse,
  type AdminUserView,
  type AnalyticsWindowQuery,
  type AppSettingView,
  type AppSettingsResponse,
  activityTagsResponse,
  createActivityTagRequest,
  updateActivityTagRequest,
  reorderActivityTagsRequest,
  type ActivityTagView,
  type ActivityTagsResponse,
  type CreateActivityTagRequest,
  type UpdateActivityTagRequest,
  type ReorderActivityTagsRequest,
  type AdminPlacesResponse,
  type AuditLogResponse,
  type BulkCreateGiftCodesRequest,
  type BulkCreateGiftCodesResponse,
  type CampaignListResponse,
  type CreateGiftCodeRequest,
  type CreateGiftCodeResponse,
  type DecideCaseRequest,
  type DecideReportRequest,
  type GiftCodeAnalyticsResponse,
  type GiftCodeListQuery,
  type GiftCodeListResponse,
  type GiftCodeRedemptionsResponse,
  type GiftCodeView,
  type ModerationCaseStatus,
  type ModerateEventRequest,
  type ModerationQueueResponse,
  type PageQuery,
  type ReconciliationResponse,
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
  type UpdateSettingRequest,
} from '@payetam/shared';
import { HealthService } from '../health/health.service';
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
  /** The release string, resolved once at construction. See `version()` below. */
  private readonly release: string;

  constructor(
    private readonly access: AdminAccessService,
    private readonly operations: AdminOperationsService,
    private readonly unseal: ChatUnsealService,
    private readonly giftCodes: GiftCodeAdminService,
    private readonly referrals: ReferralAdminService,
    private readonly catalog: CatalogAdminService,
    private readonly geography: GeographyAdminService,
    private readonly channel: ChannelAdminService,
    private readonly messaging: MessagingAdminService,
    private readonly policies: PolicyAdminService,
    private readonly insight: AdminInsightService,
    /** «مشکلی پیدا کردم» (v0.6.5) — the product's own queue, not moderation's. */
    private readonly bugReports: BugReportService,
    /**
     * The same readiness check `/ready` uses, folded into the dashboard.
     *
     * A panel that showed every number and could not say whether Redis was up
     * would be a panel somebody has to leave to answer the first question they
     * ask in an incident.
     */
    private readonly health: HealthService,
    private readonly pii: PiiHasher,
    /**
     * Only ever to *enqueue*. The API never processes a job (ADR-0005), and the
     * one thing it produces here is the nudge that starts a confirmed campaign
     * without waiting for the next scheduled pass.
     */
    private readonly queues: QueueService,
    /** Only for the release string; nothing else in this controller reads it. */
    @Inject(ENV) env: Env,
  ) {
    // Resolved once: it cannot change while the process lives, and the shape rule
    // is `resolveVersion()`'s, so the panel and the Mini App are told the same
    // thing about the same deployment.
    this.release = resolveVersion(env.PAYETAM_VERSION);
  }

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

  /**
   * Who am I, what may I do, and the token to echo (ADR-0010).
   *
   * The permissions are what the panel hides buttons with, and nothing more —
   * every one of them is checked again in the service layer.
   *
   * **The CSRF token comes back here as well as from login**, and that is what
   * makes the panel survive a reload. The token is deliberately not persisted by
   * the client: putting it in `localStorage` would hand the second half of the
   * pair to anything that can run on the origin, which is the whole reason it is
   * split from the cookie. So a reloaded tab has the cookie and no token, and
   * would be able to read everything and mutate nothing.
   *
   * Returning it on an authenticated same-origin `GET` is the ordinary
   * synchroniser-token delivery, and it is safe for the reason the pattern works
   * at all: a cross-site page can *cause* this request with the cookie attached
   * and can never **read** the response. Nothing here is reachable by JSONP,
   * `<script src>` or a form post, and the API sets no CORS headers.
   */
  @Get('me')
  me(@CurrentAdmin() admin: AdminSession & { csrfToken?: string }): AdminLoginResponse {
    return {
      // Present because `AdminAuthGuard` resolves the whole stored session,
      // which carries it beside the identity.
      csrfToken: admin.csrfToken ?? '',
      session: {
        email: admin.email,
        displayName: admin.displayName,
        roles: admin.roles,
        permissions: admin.permissions,
      },
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

  /**
   * Correct somebody else's profile (M22 phase 2).
   *
   * Behind `user.profile.edit`, asserted in the service — not here. This
   * controller has no permission check in it, and that is ADR-0010 rule 2 rather
   * than an omission: the same service is reached by jobs and scripts that do not
   * pass through a controller at all.
   *
   * `PATCH`, so an absent field is left alone and a panel that renders four inputs
   * cannot clear the fifth it never showed. The `reason` is required by the
   * schema — an unexplained edit to another person's record is not reviewable six
   * weeks later, which is the only time anybody will need it to be.
   */
  @Patch('users/:publicId/profile')
  @HttpCode(HttpStatus.OK)
  async updateUserProfile(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(adminUpdateProfileRequest)) body: AdminUpdateProfileRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<{ profile: ProfileView }> {
    const profile = await this.operations.updateUserProfile(admin, publicId, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.gender !== undefined ? { gender: body.gender } : {}),
      ...(body.birthYear !== undefined ? { birthYear: body.birthYear } : {}),
      ...(body.cityId !== undefined ? { cityId: body.cityId } : {}),
      ...(body.districtId !== undefined ? { districtId: body.districtId } : {}),
      ...(body.bio !== undefined ? { bio: body.bio } : {}),
      reason: body.reason,
    });

    return {
      profile: {
        displayName: profile.displayName,
        gender: profile.gender,
        birthYear: profile.birthYear,
        city: profile.city,
        district: profile.district,
        bio: profile.bio,
        interests: profile.interests,
        inviteOptOut: profile.inviteOptOut,
        completedAt: profile.completedAt?.toISOString() ?? null,
      },
    };
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

  // ── The panel's read surface (M19) ─────────────────────────────────────────

  /**
   * The dashboard.
   *
   * `dashboard.read` is the least a staff account can hold, which makes this the
   * one read in the panel that `ANALYST` can reach — ADR-0010's "read-only
   * aggregates means aggregates, not a licence to read every user record",
   * enforced by the service rather than described here.
   *
   * The health block is folded in rather than left to `/ready`, because the
   * screen somebody opens at the start of a shift should answer "is anything
   * wrong?" including "is anything down?", and a second fetch to a public
   * endpoint would be a second thing to remember.
   */
  @Get('dashboard')
  async dashboard(@CurrentAdmin() admin: AdminSession): Promise<AdminDashboardResponse> {
    const [summary, health] = await Promise.all([
      this.insight.dashboard(admin),
      this.health.checkDependencies(),
    ]);

    return {
      users: summary.users,
      events: summary.events,
      participations: summary.participations,
      chats: summary.chats,
      reports: summary.reports,
      cases: summary.cases,
      economy: summary.economy,
      referrals: summary.referrals,
      giftCodes: summary.giftCodes,
      moderationBacklog: {
        openCases: summary.moderationBacklog.openCases,
        openReports: summary.moderationBacklog.openReports,
        oldestOpenCaseAt: summary.moderationBacklog.oldestOpenCaseAt?.toISOString() ?? null,
      },
      health: health.checks,
    };
  }

  /**
   * Which release the API is running (M22 phase 10, plan §4).
   *
   * The same string `/api/v1/version` returns, behind the admin session rather
   * than public — not because the value is sensitive on this side and not on the
   * other, but because there is no reason for the panel to talk to an endpoint
   * outside its own prefix: `/admin/v1` is what nginx proxies for this bundle and
   * what the session cookie is scoped to.
   *
   * No permission check, and that is on purpose. Every other handler in this file
   * hands a session to a service that decides; this one has nothing to decide —
   * an `ANALYST` who can see the dashboard can see which release produced it, and
   * a release tag is not a fact any role is kept from.
   */
  @Get('version')
  version(): { version: string } {
    return { version: this.release };
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  @Get('users')
  async listUsers(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminUserListQuery)) query: AdminUserListQuery,
  ): Promise<AdminUserListResponse> {
    const page = await this.insight.listUsers(admin, {
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { users: page.rows.map(toAdminUserView), total: page.total };
  }

  @Get('users/:publicId')
  async getUser(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminUserDetailView> {
    const detail = await this.insight.getUser(admin, publicId);
    return {
      ...toAdminUserView(detail),
      cityNameFa: detail.cityNameFa,
      districtNameFa: detail.districtNameFa,
      birthYear: detail.birthYear,
      bio: detail.bio,
      bioRedactions: detail.bioRedactions,
      coins: detail.coins,
      referrals: detail.referrals,
      events: detail.events,
      participations: detail.participations,
      reportsAgainst: detail.reportsAgainst,
      reportsFiled: detail.reportsFiled,
      giftCodeRedemptions: detail.giftCodeRedemptions,
    };
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  @Get('events')
  async listEvents(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminEventListQuery)) query: AdminEventListQuery,
  ): Promise<AdminEventListResponse> {
    const page = await this.insight.listEvents(admin, {
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.hostPublicId !== undefined ? { hostPublicId: query.hostPublicId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { events: page.rows.map(toAdminEventView), total: page.total };
  }

  @Get('events/:publicId')
  async getEvent(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminEventView> {
    return toAdminEventView(await this.insight.getEvent(admin, publicId));
  }

  /**
   * Hide or restore an event without first inventing a case to decide.
   *
   * `decideCase` is the report-driven path and remains the ordinary one. This is
   * the other half a panel needs — a moderator looking at the *event* — and it
   * goes through `assertEventTransition` in the service, so it is not a back door
   * around the lifecycle.
   */
  @Post('events/:publicId/moderate')
  async moderateEvent(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(moderateEventRequest)) body: ModerateEventRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<{ status: string }> {
    return this.operations.moderateEvent(admin, publicId, {
      action: body.action,
      reason: body.reason,
    });
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  @Get('reports')
  async listReports(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminReportListQuery)) query: AdminReportListQuery,
  ): Promise<AdminReportListResponse> {
    const page = await this.insight.listReports(admin, {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.targetType !== undefined ? { targetType: query.targetType } : {}),
      ...(query.targetId !== undefined ? { targetId: query.targetId } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      reports: page.rows.map((row) => ({
        publicId: row.publicId,
        targetType: row.targetType as AdminReportView['targetType'],
        targetId: row.targetId,
        reason: row.reason as AdminReportView['reason'],
        description: row.description,
        status: row.status,
        moderationCaseId: row.moderationCaseId,
        reporterPublicId: row.reporterPublicId,
        createdAt: row.createdAt.toISOString(),
      })),
      total: page.total,
    };
  }

  /**
   * Close one report.
   *
   * Most reports are closed by `decideCase` when the case they are attached to is
   * decided. This is the rest: the single report that never crossed the threshold
   * and the one a moderator reads and answers on its own.
   */
  @Post('reports/:publicId/decide')
  @HttpCode(HttpStatus.NO_CONTENT)
  async decideReport(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(decideReportRequest)) body: DecideReportRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<void> {
    await this.operations.decideReport(admin, publicId, {
      status: body.status,
      note: body.note,
    });
  }

  // ── Economy ────────────────────────────────────────────────────────────────

  /**
   * The coin ledger, searchable (ADR-0007).
   *
   * `ledger.read`, held by `SUPPORT` — which deliberately does **not** hold
   * `coin.adjust`. Reading the ledger is how a support conversation is resolved;
   * moving a balance is not a support action.
   */
  @Get('ledger')
  async ledger(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminLedgerQuery)) query: AdminLedgerQuery,
  ): Promise<AdminLedgerResponse> {
    const page = await this.insight.searchLedger(admin, {
      ...(query.userPublicId !== undefined ? { userPublicId: query.userPublicId } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.reasonCode !== undefined ? { reasonCode: query.reasonCode } : {}),
      ...(query.refType !== undefined ? { refType: query.refType } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      entries: page.rows.map((row) => ({
        userPublicId: row.userPublicId,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        type: row.type,
        reasonCode: row.reasonCode,
        actorType: row.actorType,
        refType: row.refType,
        createdAt: row.createdAt.toISOString(),
      })),
      total: page.total,
      net: page.net,
    };
  }

  /**
   * ADR-0007's invariant, asked of the live database rather than of a fixture.
   *
   * `reconciliation.int.test.ts` asserts `balance = SUM(coin_ledger.amount)` on
   * every commit against a database a test built. This asks it of production,
   * which is the version that matters at three in the morning, and returns the
   * accounts that disagree rather than a boolean nobody can act on.
   */
  @Get('ledger/reconcile')
  async reconcile(@CurrentAdmin() admin: AdminSession): Promise<ReconciliationResponse> {
    return this.insight.reconcile(admin);
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  /**
   * The audit viewer.
   *
   * `GET /admin/v1/audit` is kept exactly as M12 shipped it — four fields, no
   * paging — because the RBAC matrix and the leak scan both address it and
   * changing a tested contract for no reason is how a regression gets in. This is
   * the panel's viewer beside it: the same rows and the same permission, with the
   * filters and the payloads somebody reading an incident actually needs.
   */
  @Get('audit/search')
  async searchAudit(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminAuditQuery)) query: AdminAuditQuery,
  ): Promise<AdminAuditResponse> {
    const page = await this.insight.listAudit(admin, {
      ...(query.actorId !== undefined ? { actorId: query.actorId } : {}),
      ...(query.actorType !== undefined ? { actorType: query.actorType } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.targetType !== undefined ? { targetType: query.targetType } : {}),
      ...(query.targetId !== undefined ? { targetId: query.targetId } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });

    return {
      entries: page.rows.map((row) => ({
        id: row.id,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        before: row.before,
        after: row.after,
        createdAt: row.createdAt.toISOString(),
      })),
      total: page.total,
    };
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  /**
   * Every tunable number, with the default behind it (§11).
   *
   * The list comes from the **code** catalogue rather than from the table. A key
   * in the database and not in `SETTING_DEFAULTS` is a leftover nothing reads,
   * and putting it on a screen would invite somebody to tune it.
   */
  @Get('settings')
  async listSettings(@CurrentAdmin() admin: AdminSession): Promise<AppSettingsResponse> {
    return { settings: await this.operations.listSettings(admin) };
  }

  /**
   * Change one, with a reason.
   *
   * The key is validated against the code catalogue in the service, so there is
   * no arbitrary-key write and no path to editing an environment variable. Some
   * of these take effect on the next read and some are cached for the process's
   * lifetime; `docs/admin-panel.md` says which.
   */
  @Post('settings/:key')
  async updateSetting(
    @Param('key') key: string,
    @Body(new ZodValidationPipe(updateSettingRequest)) body: UpdateSettingRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AppSettingView> {
    const updated = await this.operations.updateSetting(admin, key, body.value, body.reason);
    const settings = await this.operations.listSettings(admin);
    const row = settings.find((setting) => setting.key === updated.key);
    if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return row;
  }

  // ── Bug reports (v0.6.5) ───────────────────────────────────────────────────

  /**
   * What users say is broken, oldest open first.
   *
   * Behind `report.review` rather than a new permission, and that is not
   * laziness: the string means *"work the report queue"*, and this is a report
   * queue. Both MODERATOR and SUPPORT hold it, which is the right pair — support
   * is who somebody writing «دکمه کار نمی‌کند» is really addressing.
   */
  @Get('bug-reports')
  async listBugReports(
    @Query(new ZodValidationPipe(bugReportListQuery)) query: BugReportListQuery,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<BugReportListResponse> {
    this.access.assertPermission(admin, PERMISSIONS.REPORT_REVIEW);

    const result = await this.bugReports.list({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });

    return {
      reports: result.reports.map(toBugReportView),
      total: result.total,
    };
  }

  /**
   * Acknowledge, resolve or dismiss one, with a staff note.
   *
   * The note is **never shown to the reporter**. A queue annotation and a reply
   * are different things: a reply would need a channel back, a tone, and a
   * decision about who is answerable for it, and none of that is what a triage
   * note is for. Somebody who needs to be written to is written to through the
   * messaging screen, by a person.
   */
  @Post('bug-reports/:publicId')
  async updateBugReport(
    @Param('publicId') publicId: string,
    @Body(new ZodValidationPipe(updateBugReportRequest)) body: UpdateBugReportRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<BugReportView> {
    this.access.assertPermission(admin, PERMISSIONS.REPORT_REVIEW);

    const updated = await this.bugReports.setStatus(
      publicId,
      admin.adminUserId,
      body.status,
      body.note,
    );
    return toBugReportView(updated);
  }

  // ── Activity tags — «تفریحات» (M21) ────────────────────────────────────────

  /**
   * Every activity tag, active or not.
   *
   * Inactive rows included deliberately: this is the screen somebody turns one
   * back on from, and hiding them would make that impossible from the panel that
   * owns the list.
   */
  // ── Legal documents (M22 phase 8) ──────────────────────────────────────────

  /**
   * Every version of every document, drafts included.
   *
   * Behind `policy.read`, which `SUPPORT` and `MODERATOR` hold: answering "what
   * do the current terms say?" is half of what support does, and it is not the
   * same capability as writing new ones.
   */
  @Get('policies')
  async listPolicies(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminPolicyListQuery)) query: AdminPolicyListQuery,
  ): Promise<AdminPolicyListResponse> {
    const rows = await this.policies.list(admin, {
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    });
    return { policies: rows.map(toAdminPolicyView) };
  }

  @Get('policies/:id')
  async getPolicy(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminPolicyView> {
    return toAdminPolicyView(await this.policies.get(admin, id));
  }

  /** Start the next version of a document. The number is the server's to allocate. */
  @Post('policies')
  @HttpCode(HttpStatus.CREATED)
  async createPolicyDraft(
    @Body(new ZodValidationPipe(createPolicyDraftRequest)) body: CreatePolicyDraftRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminPolicyView> {
    return toAdminPolicyView(
      await this.policies.createDraft(admin, {
        type: body.type,
        titleFa: body.titleFa,
        contentMd: body.contentMd,
        ...(body.summaryFa !== undefined ? { summaryFa: body.summaryFa } : {}),
        ...(body.changeSummaryFa !== undefined ? { changeSummaryFa: body.changeSummaryFa } : {}),
      }),
    );
  }

  /**
   * Edit a draft.
   *
   * `expectedRevision` is required by the schema, not optional. Two people editing
   * one legal document is the ordinary case, and last-write-wins silently discards
   * whichever of them saved first.
   */
  @Patch('policies/:id')
  async updatePolicyDraft(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updatePolicyDraftRequest)) body: UpdatePolicyDraftRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminPolicyView> {
    return toAdminPolicyView(
      await this.policies.updateDraft(admin, id, {
        expectedRevision: body.expectedRevision,
        ...(body.titleFa !== undefined ? { titleFa: body.titleFa } : {}),
        ...(body.contentMd !== undefined ? { contentMd: body.contentMd } : {}),
        ...(body.summaryFa !== undefined ? { summaryFa: body.summaryFa } : {}),
        ...(body.changeSummaryFa !== undefined ? { changeSummaryFa: body.changeSummaryFa } : {}),
      }),
    );
  }

  /**
   * Publish, behind `policy.publish` and behind a typed-back version number.
   *
   * The confirmation is a number rather than a boolean because a boolean is a
   * checkbox and a checkbox is a reflex. Reading the version off the screen and
   * repeating it is the cheapest defence available against publishing the wrong
   * draft on a page showing three.
   */
  @Post('policies/:id/publish')
  @HttpCode(HttpStatus.OK)
  async publishPolicy(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(publishPolicyRequest)) body: PublishPolicyRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminPolicyView> {
    return toAdminPolicyView(await this.policies.publish(admin, id, body));
  }

  @Post('policies/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archivePolicy(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(publishPolicyRequest.pick({ reason: true })))
    body: { reason: string },
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminPolicyView> {
    return toAdminPolicyView(await this.policies.archive(admin, id, body.reason));
  }

  /**
   * Who accepted what, and when.
   *
   * Behind `policy.consent.read` — per-user evidence is a different capability
   * from reading the document. The projection carries a public id and never an
   * `ip_hash`: the hash exists for abuse investigation, and a screen is not that.
   */
  @Get('policy-consents')
  async listPolicyConsents(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(policyConsentQuery)) query: PolicyConsentQuery,
  ): Promise<PolicyConsentResponse> {
    const page = await this.policies.listConsents(admin, {
      ...(query.policyVersionId !== undefined ? { policyVersionId: query.policyVersionId } : {}),
      ...(query.userPublicId !== undefined ? { userPublicId: query.userPublicId } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { consents: page.rows.map(toPolicyConsentView), total: page.total };
  }

  // ── Outbound messaging (M22 phase 4) ───────────────────────────────────────

  /**
   * How many people an audience reaches. **Nothing is written and nothing is sent.**
   *
   * A `POST` because the audience is a structured body rather than a query string,
   * not because it changes anything — and the service refuses to return a list, so
   * this cannot become a way to enumerate users by city or activity.
   */
  @Post('messages/preview')
  @HttpCode(HttpStatus.OK)
  async previewMessage(
    @Body(new ZodValidationPipe(previewMessageRequest)) body: PreviewMessageRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<MessagePreviewResponse> {
    const preview = await this.messaging.preview(admin, {
      audience: body.audience,
      bodyText: body.bodyText,
      ...(body.parseMode !== undefined ? { parseMode: body.parseMode } : {}),
    });
    return {
      recipients: preview.recipients,
      appliedFilters: preview.appliedFilters,
      bodyText: preview.bodyText,
      parseMode: preview.parseMode,
    };
  }

  /**
   * Compose a campaign. It lands as `DRAFT` and **this call sends nothing.**
   *
   * A dry run finishes here at `COMPLETED` with its recipients counted and no job
   * ever enqueued; migration 0021's CHECK is what makes it impossible to promote
   * one afterwards.
   */
  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async createMessage(
    @Body(new ZodValidationPipe(createMessageRequest)) body: CreateMessageRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<MessageCampaignView> {
    const campaign = await this.messaging.create(admin, {
      // One recipient is a direct message; anything else is a broadcast, and the
      // service demands the wider permission for it.
      kind:
        body.audience.userPublicIds?.length === 1 && Object.keys(body.audience).length === 1
          ? 'DIRECT'
          : 'BROADCAST',
      bodyText: body.bodyText,
      ...(body.parseMode !== undefined ? { parseMode: body.parseMode } : {}),
      audience: body.audience,
      ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      idempotencyKey: body.idempotencyKey,
    });
    return toMessageCampaignView(campaign);
  }

  @Get('messages')
  async listMessages(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(pageQuery)) query: PageQuery,
  ): Promise<MessageCampaignListResponse> {
    const page = await this.messaging.list(admin, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { campaigns: page.rows.map(toMessageCampaignView), total: page.total };
  }

  @Get('messages/:publicId')
  async getMessage(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<MessageCampaignView> {
    return toMessageCampaignView(await this.messaging.get(admin, publicId));
  }

  /**
   * The second button, and the only edge into delivery.
   *
   * Nudges the dispatch queue as soon as the transition commits, so a confirmed
   * campaign starts in seconds rather than waiting out the minute-by-minute
   * schedule. The API enqueues and never processes (ADR-0005) — the nudge is a
   * `queue.add`, and the schedule is still the guarantee.
   */
  @Post('messages/:publicId/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmMessage(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<MessageCampaignView> {
    const campaign = await this.messaging.confirm(admin, publicId);
    await this.queues.enqueue(
      QUEUES.SCHEDULED,
      JOBS.CAMPAIGN_DISPATCH,
      jobId('campaign-dispatch', campaign.publicId.replaceAll('-', '')),
      {},
    );
    return toMessageCampaignView(campaign);
  }

  /**
   * Stop a campaign.
   *
   * Every recipient still pending becomes `SKIPPED`, which is what makes this mean
   * something: the dispatcher selects on `PENDING`, and a send job already sitting
   * in Redis finds its recipient resolved and returns without sending. Anything
   * already delivered stays delivered — nothing can recall a Telegram message.
   */
  @Post('messages/:publicId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelMessage(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<MessageCampaignView> {
    return toMessageCampaignView(await this.messaging.cancel(admin, publicId));
  }

  /** Resume one the circuit breaker paused, once Telegram has calmed down. */
  @Post('messages/:publicId/resume')
  @HttpCode(HttpStatus.OK)
  async resumeMessage(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<MessageCampaignView> {
    const campaign = await this.messaging.resume(admin, publicId);
    await this.queues.enqueue(
      QUEUES.SCHEDULED,
      JOBS.CAMPAIGN_DISPATCH,
      jobId('campaign-dispatch', campaign.publicId.replaceAll('-', ''), 'resume'),
      {},
    );
    return toMessageCampaignView(campaign);
  }

  /**
   * A user's Telegram id and username (M22 phase 12).
   *
   * The one documented exception to ADR-0009's rule that only the identity module
   * reads `telegram_account`. Behind `user.telegram.read`, which `SUPER_ADMIN`
   * alone holds, and **every call writes an audit row** — a permission says who may
   * look, and only the row says who did.
   */
  @Get('users/:publicId/telegram')
  async userTelegramIdentity(
    @Param('publicId') publicId: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<TelegramIdentityView> {
    return toTelegramIdentityView(await this.messaging.telegramIdentity(admin, publicId));
  }

  // ── The event channel (M22 phase 6) ────────────────────────────────────────

  /**
   * The channel's public face, the requirement, and whether it is safe to switch on.
   *
   * `warnings` is the point of the status shape: turning the requirement on with a
   * channel the bot cannot see locks out every user at once, so the reasons not to
   * are returned *with* the configuration rather than discovered afterwards.
   *
   * No token appears here. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_ID` stay in
   * the environment; a posting destination editable from a web session is one an
   * attacker with a session can redirect.
   */
  @Get('channel-config')
  async channelConfig(@CurrentAdmin() admin: AdminSession): Promise<ChannelConfigView> {
    return toChannelConfigView(await this.channel.get(admin));
  }

  /**
   * Change it, behind `channel.manage`.
   *
   * The invite link is validated and **rebuilt** server-side — `https://t.me/…`
   * only, no query, no fragment — because this value becomes an `href` in a button
   * every user sees, and an unvalidated one is a phishing link the product would be
   * hosting.
   */
  @Put('channel-config')
  async updateChannelConfig(
    @Body(new ZodValidationPipe(updateChannelConfigRequest)) body: UpdateChannelConfigRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ChannelConfigView> {
    return toChannelConfigView(
      await this.channel.update(admin, {
        ...(body.membershipRequired !== undefined
          ? { membershipRequired: body.membershipRequired }
          : {}),
        ...(body.requiredActions !== undefined ? { requiredActions: body.requiredActions } : {}),
        ...(body.verifyViaTelegram !== undefined
          ? { verifyViaTelegram: body.verifyViaTelegram }
          : {}),
      }),
    );
  }

  /**
   * Add a channel to the list users are required to join (v0.3.1).
   *
   * The invite link is validated and **rebuilt** server-side — `https://t.me/…`
   * only, no query, no fragment — because this value becomes an `href` in a button
   * every user sees, and an unvalidated one is a phishing link the product would be
   * hosting.
   *
   * The whole configuration comes back rather than just the new row: adding a
   * channel changes `warnings`, `hasJoinLink` and `canVerify`, and a panel that had
   * to re-fetch to learn that would render a stale warning block in between.
   */
  @Post('channel-config/channels')
  @HttpCode(HttpStatus.CREATED)
  async createRequiredChannel(
    @Body(new ZodValidationPipe(createRequiredChannelRequest)) body: CreateRequiredChannelRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ChannelConfigView> {
    await this.channel.createChannel(admin, {
      title: body.title,
      ...(body.chatIdentifier !== undefined ? { chatIdentifier: body.chatIdentifier } : {}),
      ...(body.publicUsername !== undefined ? { publicUsername: body.publicUsername } : {}),
      ...(body.inviteUrl !== undefined ? { inviteUrl: body.inviteUrl } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    });
    return toChannelConfigView(await this.channel.get(admin));
  }

  /** Edit one. An absent key leaves the field alone; an explicit null clears it. */
  @Patch('channel-config/channels/:id')
  async updateRequiredChannel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRequiredChannelRequest)) body: UpdateRequiredChannelRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ChannelConfigView> {
    await this.channel.updateChannel(admin, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.chatIdentifier !== undefined ? { chatIdentifier: body.chatIdentifier } : {}),
      ...(body.publicUsername !== undefined ? { publicUsername: body.publicUsername } : {}),
      ...(body.inviteUrl !== undefined ? { inviteUrl: body.inviteUrl } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    });
    return toChannelConfigView(await this.channel.get(admin));
  }

  /**
   * Remove one.
   *
   * Refused when it is the last active channel and the requirement is on: that
   * combination is a gate with nothing behind it, which tells users to join
   * something and shows them no button. Switching the requirement off first is one
   * click away and is the operator saying what they mean.
   */
  @Delete('channel-config/channels/:id')
  async deleteRequiredChannel(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ChannelConfigView> {
    await this.channel.deleteChannel(admin, id);
    return toChannelConfigView(await this.channel.get(admin));
  }

  /** The order of joining and of display, which the requirement states matters. */
  @Put('channel-config/channels/order')
  async reorderRequiredChannels(
    @Body(new ZodValidationPipe(reorderRequiredChannelsRequest))
    body: ReorderRequiredChannelsRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ChannelConfigView> {
    await this.channel.reorderChannels(admin, body.ids);
    return toChannelConfigView(await this.channel.get(admin));
  }

  // ── Geography (M22 phase 9) ────────────────────────────────────────────────

  /**
   * The 31 provinces, with how many cities each holds and how many are served.
   *
   * `GET /places` already returns provinces and cities for the activity-tag
   * picker and stays exactly as it was. This is a different read: it carries the
   * counts an operator needs to *manage* the list rather than pick from it, and
   * widening `/places` would have made the picker pay for them.
   */
  @Get('provinces')
  async listProvinces(@CurrentAdmin() admin: AdminSession): Promise<AdminProvinceListResponse> {
    const rows = await this.geography.listProvinces(admin);
    return { provinces: rows.map(toAdminProvinceView) };
  }

  @Post('provinces')
  @HttpCode(HttpStatus.CREATED)
  async createProvince(
    @Body(new ZodValidationPipe(createProvinceRequest)) body: CreateProvinceRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminProvinceView> {
    return toAdminProvinceView(
      await this.geography.createProvince(admin, {
        slug: body.slug,
        nameFa: body.nameFa,
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      }),
    );
  }

  @Patch('provinces/:id')
  async updateProvince(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProvinceRequest)) body: UpdateProvinceRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminProvinceView> {
    return toAdminProvinceView(
      await this.geography.updateProvince(admin, id, {
        ...(body.nameFa !== undefined ? { nameFa: body.nameFa } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      }),
    );
  }

  /**
   * A page of cities, searched and filtered on the server.
   *
   * Paged rather than returned whole, unlike every other catalog read in this
   * controller: there are 1,252 of them, they carry reference counts, and the
   * inactive ones are included — which is data no client should hold in memory.
   */
  @Get('cities')
  async listCities(
    @CurrentAdmin() admin: AdminSession,
    @Query(new ZodValidationPipe(adminCityListQuery)) query: AdminCityListQuery,
  ): Promise<AdminCityListResponse> {
    const page = await this.geography.listCities(admin, {
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(query.provinceId !== undefined ? { provinceId: query.provinceId } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { cities: page.rows.map(toAdminCityView), total: page.total };
  }

  @Post('cities')
  @HttpCode(HttpStatus.CREATED)
  async createCity(
    @Body(new ZodValidationPipe(createCityRequest)) body: CreateCityRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminCityView> {
    return toAdminCityView(
      await this.geography.createCity(admin, {
        slug: body.slug,
        nameFa: body.nameFa,
        ...(body.provinceId !== undefined ? { provinceId: body.provinceId } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      }),
    );
  }

  /**
   * Rename, re-file, reorder, activate or deactivate one city.
   *
   * There is no `DELETE`, and the omission is the design: `is_active` exists so a
   * retired city keeps the profiles and events pointing at it intact (migration
   * 0003), and the foreign keys are `RESTRICT`. Deactivating one that anything
   * references answers `CITY_HAS_REFERENCES` with the counts until the same
   * request carries `confirmReferences`.
   */
  @Patch('cities/:id')
  async updateCity(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateCityRequest)) body: UpdateCityRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<AdminCityView> {
    return toAdminCityView(
      await this.geography.updateCity(admin, id, {
        ...(body.nameFa !== undefined ? { nameFa: body.nameFa } : {}),
        ...(body.provinceId !== undefined ? { provinceId: body.provinceId } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
        ...(body.confirmReferences !== undefined
          ? { confirmReferences: body.confirmReferences }
          : {}),
      }),
    );
  }

  @Post('cities/reorder')
  @HttpCode(HttpStatus.NO_CONTENT)
  async reorderCities(
    @Body(new ZodValidationPipe(reorderCitiesRequest)) body: ReorderCitiesRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<void> {
    await this.geography.reorderCities(admin, body.order);
  }

  @Get('activity-tags')
  async listActivityTags(@CurrentAdmin() admin: AdminSession): Promise<ActivityTagsResponse> {
    return { tags: await this.catalog.listTags(admin) };
  }

  /** Provinces and cities, for the "offered in which cities" picker. */
  @Get('places')
  async listPlaces(@CurrentAdmin() admin: AdminSession): Promise<AdminPlacesResponse> {
    return this.catalog.listPlaces(admin);
  }

  @Post('activity-tags')
  async createActivityTag(
    @Body(new ZodValidationPipe(createActivityTagRequest)) body: CreateActivityTagRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ActivityTagView> {
    return this.catalog.createTag(admin, body);
  }

  /**
   * `PATCH`, not `POST`: an omitted field means "leave it", which is what makes
   * a single toggle a single field on the wire and stops two operators editing
   * different columns from overwriting each other.
   *
   * There is no slug field. See `CatalogAdminService` — an endpoint that can be
   * *asked* to rename an identifier is one somebody eventually wires an input to.
   */
  @Patch('activity-tags/:id')
  async updateActivityTag(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateActivityTagRequest)) body: UpdateActivityTagRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ActivityTagView> {
    return this.catalog.updateTag(admin, id, body);
  }

  /**
   * Refused with a count when events already reference the tag — the panel
   * offers deactivation instead, which is what `is_active` is for.
   */
  @Delete('activity-tags/:id')
  async deleteActivityTag(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<{ deleted: true }> {
    await this.catalog.deleteTag(admin, id);
    return { deleted: true };
  }

  /** The whole ordering in one transaction, so a drag cannot half-apply. */
  @Post('activity-tags/reorder')
  async reorderActivityTags(
    @Body(new ZodValidationPipe(reorderActivityTagsRequest)) body: ReorderActivityTagsRequest,
    @CurrentAdmin() admin: AdminSession,
  ): Promise<ActivityTagsResponse> {
    return activityTagsResponse.parse({ tags: await this.catalog.reorderTags(admin, body.order) });
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

/** Field by field, never a spread (§3.6 layer 2). No path reaches an identity. */
function toAdminUserView(user: UserSummary): AdminUserView {
  return {
    publicId: user.publicId,
    displayName: user.displayName,
    status: user.status,
    onboardingState: user.onboardingState,
    // Null, never zero (ADR-0014): an account that has never been judged has no
    // row, and 0 is the worst possible reputation shown to somebody who has done
    // nothing at all.
    trustScore: user.trustScore,
    coinBalance: user.coinBalance,
    createdAt: user.createdAt.toISOString(),
  };
}

function toAdminEventView(event: EventSummary): AdminEventView {
  return {
    publicId: event.publicId,
    title: event.title,
    status: event.status,
    moderationStatus: event.moderationStatus,
    hostPublicId: event.hostPublicId,
    hostDisplayName: event.hostDisplayName,
    cityNameFa: event.cityNameFa,
    startsAt: event.startsAt.toISOString(),
    capacity: event.capacity,
    acceptedCount: event.acceptedCount,
    requestCount: event.requestCount,
    reportCount: event.reportCount,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * One legal version, field by field (M22 phase 8).
 *
 * `contentMd` is projected in full and deliberately: a legal document is short,
 * and the screen that lists versions is the screen somebody compares two of them
 * on. A second fetch per row would make "what changed?" a chore.
 */
function toAdminPolicyView(policy: PolicySummary): AdminPolicyView {
  return {
    id: policy.id,
    type: policy.type,
    version: policy.version,
    status: policy.status,
    titleFa: policy.titleFa,
    contentMd: policy.contentMd,
    summaryFa: policy.summaryFa,
    changeSummaryFa: policy.changeSummaryFa,
    isCurrent: policy.isCurrent,
    revision: policy.revision,
    createdByAdminId: policy.createdByAdminId,
    publishedByAdminId: policy.publishedByAdminId,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    publishedAt: policy.publishedAt?.toISOString() ?? null,
    archivedAt: policy.archivedAt?.toISOString() ?? null,
    acceptanceCount: policy.acceptanceCount,
  };
}

/**
 * One acceptance.
 *
 * `ip_hash` and `user_agent_hash` exist on the row and are **not** here. They are
 * an HMAC kept for abuse investigation; putting them on a screen would turn them
 * into a value somebody could correlate across users, which is the one thing
 * hashing them was supposed to prevent (ADR-0009).
 */
function toPolicyConsentView(record: ConsentRecord): PolicyConsentResponse['consents'][number] {
  return {
    userPublicId: record.userPublicId,
    policyVersionId: record.policyVersionId,
    label: record.label,
    context: record.context,
    acceptedAt: record.acceptedAt.toISOString(),
    appVersion: record.appVersion,
    requestId: record.requestId,
  };
}

/** Field by field, never a spread (§3.6 layer 2). */
function toAdminProvinceView(province: ProvinceSummary): AdminProvinceView {
  return {
    id: province.id,
    slug: province.slug,
    nameFa: province.nameFa,
    isActive: province.isActive,
    sortOrder: province.sortOrder,
    cityCount: province.cityCount,
    activeCityCount: province.activeCityCount,
  };
}

/**
 * One city, with the counts that decide whether deactivating it is safe.
 *
 * The counts are aggregates, never rows: "234 profiles" says enough to make the
 * decision and names nobody.
 */
function toAdminCityView(city: CitySummary): AdminCityView {
  return {
    id: city.id,
    slug: city.slug,
    nameFa: city.nameFa,
    isActive: city.isActive,
    sortOrder: city.sortOrder,
    provinceId: city.provinceId,
    provinceNameFa: city.provinceNameFa,
    districtCount: city.districtCount,
    profileCount: city.profileCount,
    eventCount: city.eventCount,
  };
}

/**
 * One campaign, field by field (§3.6 layer 2).
 *
 * `appliedFilters` rather than the audience itself: the panel needs to say which
 * filters were used, and a raw list of city ids in a response is a list somebody
 * exports. The counts come from the service, which reads them from the recipient
 * rows rather than from a number anybody maintained by hand.
 */
function toMessageCampaignView(campaign: MessageCampaignSummary): MessageCampaignView {
  return {
    publicId: campaign.publicId,
    kind: campaign.kind,
    status: campaign.status,
    bodyText: campaign.bodyText,
    parseMode: campaign.parseMode,
    dryRun: campaign.dryRun,
    estimatedRecipients: campaign.estimatedRecipients,
    counts: campaign.counts,
    appliedFilters: Object.keys(campaign.audience),
    eventPublicId: campaign.eventPublicId,
    pausedAt: campaign.pausedAt?.toISOString() ?? null,
    pauseReason: campaign.pauseReason,
    createdAt: campaign.createdAt.toISOString(),
    confirmedAt: campaign.confirmedAt?.toISOString() ?? null,
    startedAt: campaign.startedAt?.toISOString() ?? null,
    finishedAt: campaign.finishedAt?.toISOString() ?? null,
    cancelledAt: campaign.cancelledAt?.toISOString() ?? null,
  };
}

/** The Telegram id as a string — see the contract for why that is deliberate. */
function toTelegramIdentityView(identity: TelegramIdentity): TelegramIdentityView {
  return {
    telegramUserId: identity.telegramUserId,
    username: identity.username,
    directLink: identity.directLink,
    linkUnavailableReason: identity.linkUnavailableReason,
    botBlocked: identity.botBlocked,
    lastSeenAt: identity.lastSeenAt.toISOString(),
  };
}

/** Field by field (§3.6 layer 2). Nothing here can carry a token. */
function toChannelConfigView(config: ChannelConfigStatus): ChannelConfigView {
  return {
    membershipRequired: config.membershipRequired,
    requiredActions: config.requiredActions,
    verifyViaTelegram: config.verifyViaTelegram,
    updatedAt: config.updatedAt.toISOString(),
    channels: config.channels.map(toRequiredChannelView),
    allChannels: config.allChannels.map(toRequiredChannelView),
    hasJoinLink: config.hasJoinLink,
    canVerify: config.canVerify,
    warnings: config.warnings,
  };
}

/**
 * One channel, field by field.
 *
 * `chatIdentifier` **is** projected here, unlike on the user-facing membership
 * view: the operator typed it and has to be able to correct it, and this route is
 * behind `channel.manage`. It is still not a secret — it is the same `@payetam`
 * that appears in the channel's public URL.
 */
function toRequiredChannelView(channel: RequiredChannelRecord): RequiredChannelView {
  return {
    id: channel.id,
    title: channel.title,
    chatIdentifier: channel.chatIdentifier,
    publicUsername: channel.publicUsername,
    inviteUrl: channel.inviteUrl,
    joinUrl: channel.joinUrl,
    sortOrder: channel.sortOrder,
    isActive: channel.isActive,
  };
}

/**
 * One bug report on the wire.
 *
 * A mapper rather than a spread, for the reason every other view in this
 * codebase has one: the domain summary is already narrow, but a spread would
 * carry whatever a future field adds — and the reporter's internal id is exactly
 * the sort of thing that gets added to a summary for a query's convenience.
 */
function toBugReportView(report: BugReportSummary): BugReportView {
  return {
    publicId: report.publicId,
    userPublicId: report.userPublicId,
    description: report.description,
    screenshotFileIds: report.screenshotFileIds,
    appVersion: report.appVersion,
    status: report.status,
    adminNote: report.adminNote,
    createdAt: report.createdAt.toISOString(),
    handledAt: report.handledAt?.toISOString() ?? null,
  };
}
