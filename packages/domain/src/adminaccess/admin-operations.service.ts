import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ModerationCaseStatus, ModerationSubjectType, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { CoinService } from '../economy/coin.service';
import { TrustService } from '../economy/trust.service';
import { assertEventTransition } from '../events/state-machine';
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
