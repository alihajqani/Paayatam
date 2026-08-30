import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ModerationCaseStatus, ModerationSubjectType, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { CoinService } from '../economy/coin.service';
import { TrustService } from '../economy/trust.service';
import { assertEventTransition } from '../events/state-machine';
import { SETTING_DEFAULTS, type SettingKey } from '../catalog/settings.service';
import { ProfileService, type ProfileDetail } from '../profile/profile.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS, ROLE_PERMISSIONS, type RoleKey } from './permissions';

export interface CaseSummary {
  id: string;
  subjectType: ModerationSubjectType;
  subjectId: string;
  status: ModerationCaseStatus;
  trigger: string;
  reportCount: number;
  createdAt: Date;
}

/**
 * One case, with the context a moderator needs to decide it (v0.6.3, ADR-0018).
 *
 * ── Why this is not just `CaseSummary` with the subject attached ────────────
 *
 * The bot renders this, and the bot's session holds `event.moderate` and
 * `report.review` and **nothing else** — no `chat.read`, no `user.read`. So what
 * is carried here is bounded by that, deliberately:
 *
 *  * **An event's own title and description**, because they are already public:
 *    the event is on a discovery screen and possibly in a channel, and judging
 *    it against the rules is exactly what `event.moderate` is for.
 *  * **The reasons attached to the reports**, counted. That is `report.review`,
 *    and counts rather than the reporters' free text — a moderator sorting a
 *    queue needs to know that six people said «کلاهبرداری», and the paragraphs
 *    behind that belong on a screen that is not a forwardable chat message.
 *  * **How many blacklist terms matched**, never which text they matched. The
 *    same rule `matched_terms` already follows.
 *
 * A `MESSAGE` case carries none of it, and says so. Private conversations are
 * behind break-glass — a permission, a case, a reason and a fifteen-minute clock
 * — and no amount of convenience makes a bot the right surface for one.
 */
export interface CaseDetail extends CaseSummary {
  /** The event's own words, when the subject is an event. Null otherwise. */
  eventTitle: string | null;
  eventDescription: string | null;
  eventStatus: string | null;
  /** `{ reason, count }`, never the reporters' descriptions. */
  reportReasons: { reason: string; count: number }[];
  /** How many blacklist terms matched, never which text they matched. */
  matchedTermCount: number;
}

/** The exactly-once key for an admin's hand-written balance change. */
export function adminAdjustmentKey(reference: string): string {
  return `admin-adjust:${reference}`;
}

/**
 * What an admin can actually do (ADR-0010, invariant 12).
 *
 * Every method here begins with `assertPermission` and ends with an audit row, and
 * neither is optional. That pairing is invariant 12 in code: *"every mutating
 * admin action requires a permission check in the service layer and writes
 * `audit_log`"*. Putting the check here rather than in a controller guard is what
 * makes it hold for the jobs, scripts and bot handlers that do not exist yet.
 */
@Injectable()
export class AdminOperationsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly coins: CoinService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
    /**
     * The **same** service a user's own edit goes through (M22 phase 2).
     *
     * Injected rather than reimplemented, so the 18+ check, the city/district
     * pairing and the interest allowlist cannot hold for a user and not for
     * staff. What this class adds is the permission check and the reason — the
     * two things a self-edit does not need.
     */
    private readonly profiles: ProfileService,
  ) {}

  /** The moderation queue, oldest first — a queue nobody works from the bottom. */
  async listCases(session: AdminSession, status?: ModerationCaseStatus): Promise<CaseSummary[]> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);

    const rows = await this.prisma.moderationCase.findMany({
      where: status ? { status } : { status: { in: ['OPEN', 'IN_REVIEW', 'ESCALATED'] } },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        status: true,
        trigger: true,
        reportCount: true,
        createdAt: true,
      },
    });

    return rows;
  }

  /**
   * The titles of the events a queue's cases are about, in one query.
   *
   * `EVENT_MODERATE` guards it like every other read here. It exists because the
   * bot's queue renders a title per row and `listCases` returns up to a hundred:
   * a lookup per case would be a hundred round trips to draw ten lines.
   *
   * Keyed by the **internal** event id, because that is what
   * `moderation_case.subject_id` holds for an `EVENT` case — a moderation case
   * is an admin-side row and has never carried a public id. The map is consumed
   * inside this process and nothing puts a key of it into a message.
   */
  async eventTitlesFor(
    session: AdminSession,
    eventIds: readonly string[],
  ): Promise<Map<string, string>> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);
    if (eventIds.length === 0) return new Map();

    const rows = await this.prisma.event.findMany({
      where: { id: { in: [...eventIds] } },
      select: { id: true, title: true },
    });
    return new Map(rows.map((row) => [row.id, row.title]));
  }

  /**
   * One case, with what the deciding surface is allowed to show (v0.6.3).
   *
   * `EVENT_MODERATE` guards it, exactly as `listCases` and `decideCase` are
   * guarded — invariant 12 does not have a read exemption, and this read is what
   * a decision is made from.
   *
   * The event lookup is by `subject_id`, which for an `EVENT` case is the
   * event's **internal** id: a moderation case is an admin-side row and has
   * never carried a public one. Nothing here returns that id.
   */
  async caseForReview(session: AdminSession, caseId: string): Promise<CaseDetail> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);

    /**
     * The report breakdown is `report.review`, and it **shapes** the response
     * rather than gating it.
     *
     * `can` rather than `assertPermission`, which is what this codebase already
     * does for a read whose contents depend on a second capability: refusing the
     * whole case to a moderator who may judge content but not work the report
     * queue would be a stricter rule than either permission states, and would
     * make one permission silently imply the other.
     *
     * Empty rather than absent, so a caller cannot tell "no reports" from "not
     * allowed to see them" by the shape of the object — and so the renderer needs
     * no branch for a field that might not be there.
     */
    const mayReadReports = this.access.can(session, PERMISSIONS.REPORT_REVIEW);

    const row = await this.prisma.moderationCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        subjectType: true,
        subjectId: true,
        status: true,
        trigger: true,
        reportCount: true,
        createdAt: true,
        matchedTerms: true,
      },
    });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);

    const event =
      row.subjectType === 'EVENT'
        ? await this.prisma.event.findUnique({
            where: { id: row.subjectId },
            select: { title: true, description: true, status: true },
          })
        : null;

    const grouped = mayReadReports
      ? await this.prisma.report.groupBy({
          by: ['reason'],
          where: { moderationCaseId: caseId },
          _count: { reason: true },
        })
      : [];

    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      status: row.status,
      trigger: row.trigger,
      reportCount: row.reportCount,
      createdAt: row.createdAt,
      eventTitle: event?.title ?? null,
      eventDescription: event?.description ?? null,
      eventStatus: event?.status ?? null,
      reportReasons: grouped
        .map((entry) => ({ reason: entry.reason, count: entry._count.reason }))
        .sort((a, b) => b.count - a.count),
      // A count, never the terms and never the text they matched.
      matchedTermCount: Array.isArray(row.matchedTerms) ? row.matchedTerms.length : 0,
    };
  }

  /**
   * Decide a case.
   *
   * `falsePositive` is not decoration: it is what turns ADR-0012's automation
   * tuning from an impression into a number. A moderator who dismisses an
   * auto-blacklist case is saying the scanner was wrong, and that has to be
   * countable or the blacklist can only ever get more aggressive.
   *
   * `APPROVED` on an event case restores it; `REJECTED` keeps it hidden. Both
   * close every report attached, because a report is a request for a decision and
   * the decision has now been made.
   */
  async decideCase(
    session: AdminSession,
    caseId: string,
    input: { decision: 'APPROVED' | 'REJECTED'; note: string; falsePositive?: boolean },
  ): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);
    const now = this.clock.now();

    // §7: "terminal states require `decided_by` + `decision_note`". A decision
    // nobody signed and nobody explained is not reviewable later.
    if (input.note.trim().length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.moderationCase.findUnique({
        where: { id: caseId },
        select: { id: true, status: true, subjectType: true, subjectId: true },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND);
      if (!['OPEN', 'IN_REVIEW', 'ESCALATED'].includes(existing.status)) {
        throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);
      }

      await tx.moderationCase.update({
        where: { id: caseId },
        data: {
          status: input.decision,
          decision: input.decision,
          decisionNote: input.note.trim(),
          decidedBy: session.adminUserId,
          decidedAt: now,
          ...(input.falsePositive !== undefined ? { falsePositive: input.falsePositive } : {}),
        },
      });

      await tx.report.updateMany({
        where: { moderationCaseId: caseId, status: 'OPEN' },
        data: { status: input.decision === 'APPROVED' ? 'DISMISSED' : 'ACTIONED' },
      });

      if (existing.subjectType === 'EVENT') {
        await this.applyEventDecision(tx, existing.subjectId, input.decision, session, now);
      }

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'moderation.case_decided',
          targetType: 'moderation_case',
          targetId: caseId,
          before: { status: existing.status },
          after: {
            status: input.decision,
            note: input.note.trim(),
            falsePositive: input.falsePositive ?? null,
          },
        },
        tx,
      );
    });
  }

  private async applyEventDecision(
    tx: Prisma.TransactionClient,
    eventId: string,
    decision: 'APPROVED' | 'REJECTED',
    session: AdminSession,
    now: Date,
  ): Promise<void> {
    void now;
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: { status: true },
    });
    if (!event) return;

    // Only HIDDEN and PENDING_MODERATION have anywhere to go. An event the host
    // has since cancelled is not resurrected by a moderator agreeing with them.
    if (event.status !== 'HIDDEN' && event.status !== 'PENDING_MODERATION') return;

    const next = decision === 'APPROVED' ? 'PUBLISHED' : 'REJECTED';
    assertEventTransition(event.status, next, eventId);

    await tx.event.update({
      where: { id: eventId },
      data: {
        status: next,
        moderationStatus: decision,
        version: { increment: 1 },
      },
    });

    await this.audit.record(
      {
        actorType: 'ADMIN',
        actorId: session.adminUserId,
        action: 'event.moderated',
        targetType: 'event',
        targetId: eventId,
        before: { status: event.status },
        after: { status: next },
      },
      tx,
    );
  }

  /**
   * Move somebody's balance by hand (§6, `POST /admin/v1/coins/adjust`).
   *
   * `coin.adjust` and **not** a permission `SUPPORT` holds — ADR-0010 is explicit
   * that support cannot move currency, and the plan tests it by name. Support is
   * the role most exposed to social engineering, and "please just add the coins
   * back" is the script.
   *
   * The reason is mandatory (ADR-0010's audit rule) and the movement goes through
   * `CoinService` like every other, so it lands in the same append-only ledger with
   * the same idempotency key discipline. There is no path that writes
   * `coin_account.balance` directly, including this one.
   */
  async adjustCoins(
    session: AdminSession,
    input: { userPublicId: string; amount: number; reason: string; reference: string },
  ): Promise<{ balance: number }> {
    this.access.assertPermission(session, PERMISSIONS.COIN_ADJUST);

    if (!Number.isInteger(input.amount) || input.amount === 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'amount' });
    }
    if (input.reason.trim().length < 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'reason' });
    }

    const user = await this.prisma.user.findUnique({
      where: { publicId: input.userPublicId },
      select: { id: true },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.coins.apply(
        {
          userId: user.id,
          amount: input.amount,
          type: 'ADMIN_ADJUSTMENT',
          reasonCode: 'admin.adjustment',
          // Supplied by the caller so a retried request is one adjustment rather
          // than two. Without it, a flaky connection doubles somebody's balance.
          idempotencyKey: adminAdjustmentKey(input.reference),
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          metadata: { reason: input.reason.trim() },
        },
        tx,
      );

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'coin.adjusted',
          targetType: 'user',
          targetId: user.id,
          after: {
            amount: input.amount,
            reason: input.reason.trim(),
            applied: movement.applied,
            balance: movement.balance,
          },
        },
        tx,
      );

      return { balance: movement.balance };
    });
  }

  /** The same discipline for reputation: a permission, a reason, a ledger row. */
  async adjustTrust(
    session: AdminSession,
    input: { userPublicId: string; delta: number; reason: string; reference: string },
  ): Promise<{ score: number }> {
    this.access.assertPermission(session, PERMISSIONS.TRUST_ADJUST);

    if (!Number.isInteger(input.delta) || input.delta === 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'delta' });
    }
    if (input.reason.trim().length < 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'reason' });
    }

    const user = await this.prisma.user.findUnique({
      where: { publicId: input.userPublicId },
      select: { id: true },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    return this.prisma.$transaction(async (tx) => {
      const movement = await this.trust.apply(
        {
          userId: user.id,
          delta: input.delta,
          type: 'ADMIN_ADJUSTMENT',
          reasonCode: 'admin.adjustment',
          idempotencyKey: `admin-trust:${input.reference}`,
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          metadata: { reason: input.reason.trim() },
        },
        tx,
      );

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'trust.adjusted',
          targetType: 'user',
          targetId: user.id,
          after: { delta: movement.effectiveDelta, reason: input.reason.trim() },
        },
        tx,
      );

      return { score: movement.score };
    });
  }

  /** Suspend or ban an account. */
  async setUserStatus(
    session: AdminSession,
    input: { userPublicId: string; status: 'ACTIVE' | 'SUSPENDED' | 'BANNED'; reason: string },
  ): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.USER_BAN);
    if (input.reason.trim().length < 5) throw new AppError(ErrorCode.VALIDATION_FAILED);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { publicId: input.userPublicId },
        select: { id: true, status: true },
      });
      if (!user) throw new AppError(ErrorCode.NOT_FOUND);

      await tx.user.update({ where: { id: user.id }, data: { status: input.status } });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'user.status_changed',
          targetType: 'user',
          targetId: user.id,
          before: { status: user.status },
          after: { status: input.status, reason: input.reason.trim() },
        },
        tx,
      );
    });
  }

  /**
   * Edit somebody else's profile (M22 phase 2).
   *
   * Behind `user.profile.edit`, which `SUPPORT` deliberately does not hold: the
   * role most exposed to "please just change it for me" is the one that must not
   * be able to. Reading the same record is `user.read`, and support keeps that.
   *
   * The validation is not restated here. It belongs to `ProfileService.update`,
   * which is the path a user's own edit takes — so an admin cannot set a birth
   * year that makes somebody sixteen, cannot pair a district with the wrong city,
   * and cannot select a deactivated interest, for exactly the reasons a user
   * cannot.
   *
   * What this adds is the audit row, and it is richer than a self-edit's: old and
   * new values for the fields a support conversation is about, plus the reason the
   * admin typed. `ProfileService` writes it, because it is the only code that has
   * seen both sides inside one transaction — writing it here would mean reading
   * the row again afterwards and recording a "before" that may already have moved.
   */
  async updateUserProfile(
    session: AdminSession,
    userPublicId: string,
    input: {
      displayName?: string | undefined;
      gender?: 'MALE' | 'FEMALE' | 'PREFER_NOT_SAY' | null | undefined;
      birthYear?: number | undefined;
      cityId?: string | undefined;
      districtId?: string | null | undefined;
      bio?: string | null | undefined;
      reason: string;
    },
  ): Promise<ProfileDetail> {
    this.access.assertPermission(session, PERMISSIONS.USER_PROFILE_EDIT);
    if (input.reason.trim().length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const user = await this.prisma.user.findUnique({
      where: { publicId: userPublicId },
      select: { id: true },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    // Key by key rather than a spread: `exactOptionalPropertyTypes` treats an
    // explicit `undefined` as a *present* key, and a parsed body carries one for
    // every field the panel left alone — which would read as "clear it".
    return this.profiles.update(
      user.id,
      {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.gender !== undefined ? { gender: input.gender } : {}),
        ...(input.birthYear !== undefined ? { birthYear: input.birthYear } : {}),
        ...(input.cityId !== undefined ? { cityId: input.cityId } : {}),
        ...(input.districtId !== undefined ? { districtId: input.districtId } : {}),
        ...(input.bio !== undefined ? { bio: input.bio } : {}),
      },
      { kind: 'ADMIN', adminUserId: session.adminUserId, reason: input.reason.trim() },
    );
  }

  /**
   * Ask for a role change (ADR-0010, rule 4).
   *
   * Requesting is not granting. A `SUPER_ADMIN` writes a request and a *different*
   * admin approves it, which is what stops one compromised account from quietly
   * becoming every role at once — the account with `role.manage` is exactly the one
   * an attacker wants, and unilateral self-promotion is what they would do with it.
   */
  async requestRoleChange(
    session: AdminSession,
    input: { subjectAdminId: string; roleKey: RoleKey; granting: boolean; reason: string },
  ): Promise<{ requestId: string }> {
    this.access.assertPermission(session, PERMISSIONS.ROLE_MANAGE);
    if (input.reason.trim().length < 5) throw new AppError(ErrorCode.VALIDATION_FAILED);
    if (!(input.roleKey in ROLE_PERMISSIONS)) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const created = await this.prisma.roleChangeRequest.create({
      data: {
        subjectAdminId: input.subjectAdminId,
        roleKey: input.roleKey,
        granting: input.granting,
        reason: input.reason.trim(),
        requestedById: session.adminUserId,
        createdAt: this.clock.now(),
      },
      select: { id: true },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'role.change_requested',
      targetType: 'admin_user',
      targetId: input.subjectAdminId,
      after: { roleKey: input.roleKey, granting: input.granting, reason: input.reason.trim() },
    });

    return { requestId: created.id };
  }

  /**
   * Approve somebody else's request, and only somebody else's.
   *
   * The refusal below is duplicated by a CHECK on the table, deliberately: the
   * service gives a useful error and the constraint is what holds if a future path
   * forgets to ask.
   */
  async approveRoleChange(session: AdminSession, requestId: string): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.ROLE_MANAGE);
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      const request = await tx.roleChangeRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          status: true,
          subjectAdminId: true,
          roleKey: true,
          granting: true,
          requestedById: true,
        },
      });
      if (!request) throw new AppError(ErrorCode.NOT_FOUND);
      if (request.status !== 'PENDING') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);
      // Four eyes, not two.
      if (request.requestedById === session.adminUserId) {
        throw new AppError(ErrorCode.FOUR_EYES_REQUIRED);
      }

      const role = await tx.role.findUnique({
        where: { key: request.roleKey },
        select: { id: true },
      });
      if (!role) throw new AppError(ErrorCode.INTERNAL_ERROR);

      if (request.granting) {
        await tx.adminUserRole.createMany({
          data: [{ adminUserId: request.subjectAdminId, roleId: role.id }],
          skipDuplicates: true,
        });
      } else {
        await tx.adminUserRole.deleteMany({
          where: { adminUserId: request.subjectAdminId, roleId: role.id },
        });
      }

      await tx.roleChangeRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', approvedById: session.adminUserId, decidedAt: now },
      });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'role.change_approved',
          targetType: 'admin_user',
          targetId: request.subjectAdminId,
          after: {
            roleKey: request.roleKey,
            granting: request.granting,
            requestedBy: request.requestedById,
          },
        },
        tx,
      );
    });
  }

  /**
   * Moderate an event directly, without waiting for a case (M19).
   *
   * `decideCase` exists for the report-driven path and is the ordinary one. This
   * is the other half a panel needs: a moderator looking at an event *itself*
   * — because somebody phoned, or because they were reading the queue — has to be
   * able to hide it or restore it without first inventing a case to decide.
   *
   * Both directions go through `assertEventTransition`, which is what keeps this
   * from being a back door around the lifecycle: an event the host has since
   * cancelled is not resurrected by a moderator, and one that has already
   * happened is not hidden retroactively.
   *
   * The reason is mandatory for the reason §7 makes it mandatory on a case: a
   * moderation decision nobody explained is one nobody can review.
   */
  async moderateEvent(
    session: AdminSession,
    eventPublicId: string,
    input: { action: 'HIDE' | 'PUBLISH' | 'REJECT'; reason: string },
  ): Promise<{ status: string }> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_MODERATE);
    if (input.reason.trim().length < 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'reason' });
    }

    const next = { HIDE: 'HIDDEN', PUBLISH: 'PUBLISHED', REJECT: 'REJECTED' } as const;

    return this.prisma.$transaction(async (tx) => {
      const event = await tx.event.findUnique({
        where: { publicId: eventPublicId },
        select: { id: true, status: true, deletedAt: true },
      });
      if (!event || event.deletedAt !== null) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

      const target = next[input.action];
      assertEventTransition(event.status, target, event.id);

      await tx.event.update({
        where: { id: event.id },
        data: {
          status: target,
          moderationStatus: input.action === 'PUBLISH' ? 'APPROVED' : 'REJECTED',
          // Optimistic concurrency for the host's own edit form: a moderator
          // hiding an event while its host is editing must make the host's save
          // fail rather than silently un-hide it.
          version: { increment: 1 },
        },
      });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'event.moderated',
          targetType: 'event',
          targetId: event.id,
          before: { status: event.status },
          after: { status: target, reason: input.reason.trim() },
        },
        tx,
      );

      return { status: target };
    });
  }

  /**
   * Close one report without deciding a whole case (M19).
   *
   * A report is a *request for a decision*, and most of them are answered by
   * `decideCase` closing every report attached to a case. This handles the rest:
   * the single report that never crossed the threshold, and the one a moderator
   * reads and resolves on its own.
   *
   * `report.review`, which `SUPPORT` holds — reading and closing complaints is
   * the job. Acting on the *subject* of one is `event.moderate` or `user.ban`,
   * and neither is reachable from here.
   */
  async decideReport(
    session: AdminSession,
    reportPublicId: string,
    input: { status: 'ACTIONED' | 'DISMISSED'; note: string },
  ): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.REPORT_REVIEW);
    if (input.note.trim().length < 3) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'note' });
    }

    await this.prisma.$transaction(async (tx) => {
      const report = await tx.report.findUnique({
        where: { publicId: reportPublicId },
        select: { id: true, status: true, targetType: true, targetId: true },
      });
      if (!report) throw new AppError(ErrorCode.NOT_FOUND);
      // A report is answered once. Re-deciding one is a conflict, not a bug —
      // two moderators reading the same queue is the normal case.
      if (report.status !== 'OPEN') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

      await tx.report.update({ where: { id: report.id }, data: { status: input.status } });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'report.decided',
          targetType: 'report',
          targetId: report.id,
          before: { status: report.status },
          after: {
            status: input.status,
            note: input.note.trim(),
            // The subject, so an incident review can follow the decision to the
            // thing it was about without a second query.
            subjectType: report.targetType,
          },
        },
        tx,
      );
    });
  }

  /**
   * Every tunable number, with its current value and its code default (M19).
   *
   * §11's heading is *"all in `app_setting`, runtime-changeable"*, and M17 seeded
   * the rows so an operator could *find* them. This is the screen that makes them
   * changeable without `psql`.
   *
   * The list is driven by `SETTING_DEFAULTS` rather than by the table, and the
   * direction matters: a key present in the database and absent from the code is
   * a leftover nothing reads, and showing it would invite somebody to tune it.
   * A key in the code with no row is shown with its default, which is exactly
   * what the service would return.
   */
  async listSettings(
    session: AdminSession,
  ): Promise<Array<{ key: string; value: number; defaultValue: number; overridden: boolean }>> {
    this.access.assertPermission(session, PERMISSIONS.SETTINGS_MANAGE);

    const stored = new Map(
      (await this.prisma.appSetting.findMany({ select: { key: true, value: true } })).map((row) => [
        row.key,
        row.value,
      ]),
    );

    return Object.entries(SETTING_DEFAULTS).map(([key, defaultValue]) => {
      const value = stored.get(key);
      const usable = typeof value === 'number' && Number.isFinite(value);
      return {
        key,
        value: usable ? value : defaultValue,
        defaultValue,
        overridden: usable && value !== defaultValue,
      };
    });
  }

  /**
   * Change one policy number.
   *
   * **The key must be one the code knows about.** An arbitrary key would let the
   * panel write rows nothing reads, which is a settings table that stops
   * describing the product — and it is the shape of the "edit any environment
   * variable" screen that must never exist.
   *
   * The value is validated against the *kind* of number the default is: an
   * integer default takes an integer, because a coin amount that arrives as 12.5
   * is a corrupted ledger rather than a rounding question. Both bounds are
   * refused rather than clamped, so an operator who typed the wrong thing is told.
   */
  async updateSetting(
    session: AdminSession,
    key: string,
    value: number,
    reason: string,
  ): Promise<{ key: string; value: number }> {
    this.access.assertPermission(session, PERMISSIONS.SETTINGS_MANAGE);

    if (!(key in SETTING_DEFAULTS)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'key' });
    }
    if (reason.trim().length < 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'reason' });
    }

    const defaultValue = SETTING_DEFAULTS[key as SettingKey];
    if (!Number.isFinite(value) || value < 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'value' });
    }
    if (Number.isInteger(defaultValue) && !Number.isInteger(value)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'value' });
    }

    const before = await this.prisma.appSetting.findUnique({ where: { key } });

    const updated = await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value, updatedBy: session.adminUserId },
      update: { value, version: { increment: 1 }, updatedBy: session.adminUserId },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'setting.changed',
      targetType: 'app_setting',
      targetId: key,
      // `app_setting.value` is `Json`, so it is whatever an earlier writer put
      // there. A non-number is a garbled row — the case `SettingsService.read`
      // already falls back on — and recording the default is what that fallback
      // actually meant.
      before: { value: typeof before?.value === 'number' ? before.value : defaultValue },
      after: { value, reason: reason.trim() },
    });

    return { key, value: updated.value as number };
  }

  /** The audit trail itself, newest first. */
  async listAuditLog(
    session: AdminSession,
    filters: { targetType?: string; targetId?: string; limit?: number } = {},
  ): Promise<Array<{ action: string; actorType: string; createdAt: Date; targetType: string }>> {
    this.access.assertPermission(session, PERMISSIONS.AUDIT_READ);

    return this.prisma.auditLog.findMany({
      where: {
        ...(filters.targetType !== undefined ? { targetType: filters.targetType } : {}),
        ...(filters.targetId !== undefined ? { targetId: filters.targetId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(filters.limit ?? 50, 1), 200),
      select: { action: true, actorType: true, createdAt: true, targetType: true },
    });
  }
}
