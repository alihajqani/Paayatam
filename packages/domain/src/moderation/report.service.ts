import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ModerationSubjectType, Prisma, ReportReason } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { assertEventTransition } from '../events/state-machine';
import { isUniqueViolation } from '../identity/user.service';
import { OutboxService } from '../outbox/outbox.service';

export interface FileReportInput {
  targetType: ModerationSubjectType;
  /** The **public** id of the thing being reported; resolved internally here. */
  targetPublicId: string;
  reason: ReportReason;
  description?: string;
}

export interface FiledReport {
  publicId: string;
  status: 'OPEN';
  /** True when this report is the one that crossed the threshold. */
  triggeredReview: boolean;
}

/**
 * Reports, and the threshold that acts on them (plan §11, §12).
 *
 * Two properties carry this module:
 *
 * **One report per person per thing**, enforced by `UNIQUE (target_type,
 * target_id, reporter_user_id)` — invariant 5. That index is not merely a
 * duplicate guard; it is what makes the auto-hide threshold mean *distinct
 * people*. Counting rows counts reporters, so "three reports" cannot be one
 * determined person clicking three times, and nobody can hide a rival's event
 * alone.
 *
 * **The owner is told, and never told by whom.** A notification that named the
 * reporter would make reporting an act with a personal cost, which is how a
 * reporting system stops being used precisely when it is needed. The outbox
 * payload carries the subject and the count, never a reporter.
 */
@Injectable()
export class ReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * File one.
   *
   * The insert happens first and the threshold is evaluated after it, inside the
   * same transaction: evaluating first would let two simultaneous third reports
   * both see a count of two and neither of them act.
   */
  async file(reporterUserId: string, input: FileReportInput): Promise<FiledReport> {
    const now = this.clock.now();
    const threshold = await this.settings.getInt('moderation.report_threshold');

    return this.prisma.$transaction(
      async (tx) => {
        const target = await this.resolveTarget(tx, input.targetType, input.targetPublicId);
        if (target.ownerUserId === reporterUserId) {
          throw new AppError(ErrorCode.CANNOT_REPORT_OWN_CONTENT);
        }

        let report;
        try {
          report = await tx.report.create({
            data: {
              targetType: input.targetType,
              targetId: target.id,
              reporterUserId,
              reason: input.reason,
              description: input.description ?? null,
              createdAt: now,
            },
            select: { id: true, publicId: true },
          });
        } catch (error) {
          // Invariant 5 answering. A read-then-write existence check would have a
          // window; this has none.
          if (isUniqueViolation(error)) throw new AppError(ErrorCode.ALREADY_REPORTED);
          throw error;
        }

        // Counted **after** the insert and inside this transaction, so two
        // simultaneous third reports cannot both see two.
        const distinctReporters = await tx.report.count({
          where: { targetType: input.targetType, targetId: target.id, status: 'OPEN' },
        });

        const triggered = distinctReporters >= threshold;
        if (triggered) {
          await this.escalate(tx, {
            targetType: input.targetType,
            targetId: target.id,
            ownerUserId: target.ownerUserId,
            publicId: target.publicId,
            reportCount: distinctReporters,
            now,
          });
        }

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: reporterUserId,
            action: 'report.filed',
            targetType: input.targetType.toLowerCase(),
            targetId: target.id,
            // The reason is a category, not the reporter's free text about
            // somebody else (ADR-0009). The description stays on the row, which
            // is where a moderator reads it.
            after: { reason: input.reason, reportCount: distinctReporters, triggered },
          },
          tx,
        );

        return { publicId: report.publicId, status: 'OPEN' as const, triggeredReview: triggered };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * The threshold is crossed: hide the subject and open a case.
   *
   * Hiding is deliberately reversible and deliberately automatic. A moderator
   * decides whether the reports were right; the automation only decides that
   * enough people objected for a human to look, and that in the meantime the thing
   * should not keep being seen. §7 draws `PUBLISHED → HIDDEN` for exactly this.
   *
   * Idempotent on the case: a fourth and fifth report update the count on the case
   * that already exists rather than opening more of them. A queue with three cases
   * about one event is a queue three people work in parallel.
   */
  private async escalate(
    tx: Prisma.TransactionClient,
    input: {
      targetType: ModerationSubjectType;
      targetId: string;
      ownerUserId: string | null;
      publicId: string;
      reportCount: number;
      now: Date;
    },
  ): Promise<void> {
    const existing = await tx.moderationCase.findFirst({
      where: {
        subjectType: input.targetType,
        subjectId: input.targetId,
        status: { in: ['OPEN', 'IN_REVIEW', 'ESCALATED'] },
      },
      select: { id: true },
    });

    const caseId =
      existing?.id ??
      (
        await tx.moderationCase.create({
          data: {
            subjectType: input.targetType,
            subjectId: input.targetId,
            trigger: 'REPORT_THRESHOLD',
            status: 'OPEN',
            reportCount: input.reportCount,
          },
          select: { id: true },
        })
      ).id;

    if (existing) {
      await tx.moderationCase.update({
        where: { id: caseId },
        data: { reportCount: input.reportCount },
      });
    }

    await tx.report.updateMany({
      where: { targetType: input.targetType, targetId: input.targetId, moderationCaseId: null },
      data: { moderationCaseId: caseId },
    });

    if (input.targetType === 'EVENT') {
      const event = await tx.event.findUniqueOrThrow({
        where: { id: input.targetId },
        select: { status: true },
      });

      // Already hidden, cancelled or finished: the reports still open a case, but
      // there is nothing left to hide and forcing the transition would throw.
      if (event.status === 'PUBLISHED') {
        assertEventTransition(event.status, 'HIDDEN', input.targetId);
        await tx.event.update({
          where: { id: input.targetId },
          data: { status: 'HIDDEN', version: { increment: 1 } },
        });

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'event.auto_hidden',
            targetType: 'event',
            targetId: input.targetId,
            before: { status: 'PUBLISHED' },
            after: { status: 'HIDDEN', reportCount: input.reportCount, caseId },
          },
          tx,
        );
      }
    }

    /**
     * The owner is told, **without any reporter identity**.
     *
     * The payload carries what was hidden and how many people objected, and
     * nothing about who they were. A notification that named them would make
     * reporting an act with a personal cost — which is how a reporting system
     * stops being used at exactly the moment it matters.
     */
    if (input.ownerUserId !== null) {
      await this.outbox.emit(
        {
          aggregateType: 'moderation_case',
          aggregateId: caseId,
          eventType: 'moderation.content_hidden',
          payload: {
            subjectType: input.targetType,
            subjectPublicId: input.publicId,
            ownerUserPublicId: await publicIdOf(tx, input.ownerUserId),
            reportCount: input.reportCount,
          },
        },
        tx,
      );
    }
  }

  /**
   * Public id → internal id, plus who owns the thing.
   *
   * The owner matters twice: they are the one told when it is hidden, and they are
   * the one person who may not report it. "Report your own event" is not a
   * meaningful action, and allowing it would let somebody inflate a count towards
   * their own threshold.
   */
  private async resolveTarget(
    tx: Prisma.TransactionClient,
    targetType: ModerationSubjectType,
    publicId: string,
  ): Promise<{ id: string; publicId: string; ownerUserId: string | null }> {
    switch (targetType) {
      case 'EVENT': {
        const event = await tx.event.findUnique({
          where: { publicId },
          select: { id: true, publicId: true, hostUserId: true, deletedAt: true },
        });
        if (!event || event.deletedAt !== null) throw new AppError(ErrorCode.NOT_FOUND);
        return { id: event.id, publicId: event.publicId, ownerUserId: event.hostUserId };
      }
      case 'USER': {
        const user = await tx.user.findUnique({
          where: { publicId },
          select: { id: true, publicId: true },
        });
        if (!user) throw new AppError(ErrorCode.NOT_FOUND);
        // The subject *is* the owner: reporting yourself is refused by the same
        // check that refuses reporting your own event.
        return { id: user.id, publicId: user.publicId, ownerUserId: user.id };
      }
      case 'REVIEW': {
        const review = await tx.review.findUnique({
          where: { publicId },
          select: { id: true, publicId: true, reviewerUserId: true },
        });
        if (!review) throw new AppError(ErrorCode.NOT_FOUND);
        return { id: review.id, publicId: review.publicId, ownerUserId: review.reviewerUserId };
      }
      case 'MESSAGE': {
        const chat = await tx.anonymousChat.findUnique({
          where: { publicId },
          select: { id: true, publicId: true },
        });
        if (!chat) throw new AppError(ErrorCode.NOT_FOUND);
        /**
         * A chat, not a message, and the owner is nobody.
         *
         * §4.6 gives `MESSAGE` as a target type, but a message has no public id —
         * §4.4 exposes conversations by `anonymous_chat.public_id` and messages
         * only by a per-chat sequence number. Naming an individual message from
         * outside would require an identifier the product deliberately does not
         * publish. Reporting a conversation is what a user can actually do, and it
         * is what opens the case a break-glass grant then requires (T14).
         *
         * No owner, so no notification: telling one side of an anonymous chat that
         * the other reported them is the one notification this module must never
         * send.
         */
        return { id: chat.id, publicId: chat.publicId, ownerUserId: null };
      }
    }
  }
}

async function publicIdOf(tx: Prisma.TransactionClient, userId: string): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return user.publicId;
}
