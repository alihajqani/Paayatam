import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { NoShowClaimKind, ParticipantStatus, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import type { AdminSession } from '../adminaccess/admin-access.service';
import { PERMISSIONS } from '../adminaccess/permissions';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService, participantTrustPenaltyKey } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { isUniqueViolation } from '../identity/user.service';
import { OutboxService } from '../outbox/outbox.service';
import { assertParticipantTransition } from '../participation/state-machine';
import { lockEventForUpdate } from './event-lock';
import { hostDepositRefundKey, hostRewardKey } from './host-reward.service';

export const NO_SHOW_DISPUTE_UPHELD_REASON = 'no_show.dispute_upheld';
export const HOST_ABSENT_REASON = 'no_show.host_absent';

/** Exactly-once keys for what an upheld claim moves. */
export function noShowDisputeTrustKey(participantId: string): string {
  return `trust-noshow-dispute:${participantId}`;
}
export function hostAbsentPenaltyKey(eventId: string): string {
  return `host-absent-penalty:${eventId}`;
}
export function hostAbsentTrustKey(eventId: string): string {
  return `trust-host-absent:${eventId}`;
}

/** What the bot says before it opens the form, so nobody types into a refusal. */
export interface ClaimReadiness {
  eventTitle: string;
  /** The end of the window this claim is inside. */
  closesAt: Date;
}

/** One statement on a case, as the person deciding it reads it. */
export interface CaseClaim {
  kind: NoShowClaimKind;
  /** Who said it, by side — never an id. */
  authorRole: 'GUEST' | 'HOST';
  authorDisplayName: string;
  statement: string;
  createdAt: Date;
}

const OPEN_CASE_STATUSES = ['OPEN', 'IN_REVIEW', 'ESCALATED'] as const;

/** Seats a report about the host can come from: somebody who was expected there. */
const SEATED: readonly ParticipantStatus[] = ['ACCEPTED', 'COMPLETED', 'NO_SHOW'];

const MIN_STATEMENT = 10;
const MAX_STATEMENT = 500;

/**
 * No-shows in both directions (plan 08, decided 2026-09-14).
 *
 * ── The two directions, and why they are not symmetrical ────────────────────
 *
 * **A guest marked absent** (`GUEST_ABSENT_DISPUTE`) was charged at once, because
 * a host who was there is a first-hand witness, one person is affected and the
 * amount is bounded; making every no-show a case would bury the queue under
 * the ninety-nine that nobody disputes. The dispute comes after, and an upheld
 * one reverses exactly what `markNoShow` took.
 *
 * **A host who did not come** (`HOST_ABSENT_REPORT`) moves nothing until a
 * moderator decides: the amount is larger (the host's price, plus every guest's
 * join deposit back), several people are affected, and co-witnessing can be
 * manufactured — three reporters can be three friends. The host is asked for
 * their side first (`HOST_ABSENT_RESPONSE`), within
 * `cancellation.response_window_hours`.
 *
 * ── «The bot decides; it does not choose the amount» ────────────────────────
 *
 * Plan 07's rule, and why this needs no ADR. A moderator says *whether* a claim
 * is right. What follows is fixed here: the exact ledger rows on the
 * participation are reversed, the host pays `hostPriceFor('NO_SHOW')`, and every
 * key is derived from the thing it undoes, so a second decision cannot move
 * anything twice. Which is also why this is `report.review`, a permission the
 * bot session already holds (ADR-0018), and not `coin.adjust`.
 *
 * ── Why `decideCase` refuses these cases ────────────────────────────────────
 *
 * Its REJECTED on an EVENT case means «hide this activity», which is not an
 * answer to «did the host come?». The two decisions are different questions, and
 * `WRONG_CASE_DECISION` keeps either from standing in for the other.
 */
@Injectable()
export class NoShowClaimService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly penalties: PenaltyService,
    private readonly coins: CoinService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ── A guest marked absent: «من حاضر بودم» ─────────────────────────────────

  /** Whether this guest may dispute this no-show now. Throws the refusal. */
  async disputeReadiness(userId: string, participantPublicId: string): Promise<ClaimReadiness> {
    return this.loadDisputable(this.prisma, userId, participantPublicId, this.clock.now());
  }

  async dispute(userId: string, participantPublicId: string, statement: string): Promise<void> {
    const text = validStatement(statement);
    const now = this.clock.now();

    await this.prisma.$transaction(
      async (tx) => {
        const seat = await this.loadDisputable(tx, userId, participantPublicId, now);

        const moderationCase = await tx.moderationCase.create({
          data: {
            subjectType: 'PARTICIPATION',
            subjectId: seat.participantId,
            trigger: 'DISPUTE',
            status: 'OPEN',
            reportCount: 1,
            createdAt: now,
          },
          select: { id: true },
        });

        await this.writeClaim(tx, {
          eventId: seat.eventId,
          kind: 'GUEST_ABSENT_DISPUTE',
          participantId: seat.participantId,
          authorUserId: userId,
          statement: text,
          moderationCaseId: moderationCase.id,
          now,
        });

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'no_show.disputed',
            targetType: 'event_participant',
            targetId: seat.participantId,
            // The statement stays on the claim row, where a moderator reads it.
            after: { caseId: moderationCase.id },
          },
          tx,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  private async loadDisputable(
    tx: Prisma.TransactionClient,
    userId: string,
    participantPublicId: string,
    now: Date,
  ): Promise<ClaimReadiness & { participantId: string; eventId: string }> {
    const participant = await tx.eventParticipant.findUnique({
      where: { publicId: participantPublicId },
      select: {
        id: true,
        userId: true,
        status: true,
        noShowNotifiedAt: true,
        event: { select: { id: true, title: true } },
      },
    });
    // Not-yours and not-found answer identically (T3.3).
    if (participant === null || participant.userId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND);
    }
    // Already reversed, or never a no-show: nothing to dispute.
    if (participant.status !== 'NO_SHOW') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    const days = await this.settings.getInt('cancellation.dispute_window_days', tx);
    // Never told with a way to dispute: the one-off offer has not reached them.
    if (participant.noShowNotifiedAt === null) throw new AppError(ErrorCode.CLAIM_WINDOW_CLOSED);
    const closesAt = new Date(participant.noShowNotifiedAt.getTime() + days * 86_400_000);
    if (now > closesAt) throw new AppError(ErrorCode.CLAIM_WINDOW_CLOSED);

    await this.assertNotClaimed(tx, 'GUEST_ABSENT_DISPUTE', participant.event.id, userId);

    return {
      participantId: participant.id,
      eventId: participant.event.id,
      eventTitle: participant.event.title,
      closesAt,
    };
  }

  // ── A host who did not come: «میزبان نیامد» ───────────────────────────────

  async hostAbsentReadiness(userId: string, participantPublicId: string): Promise<ClaimReadiness> {
    return this.loadReportable(this.prisma, userId, participantPublicId, this.clock.now());
  }

  async reportHostAbsent(
    userId: string,
    participantPublicId: string,
    statement: string,
  ): Promise<void> {
    const text = validStatement(statement);
    const now = this.clock.now();

    await this.prisma.$transaction(
      async (tx) => {
        const seat = await this.loadReportable(tx, userId, participantPublicId, now);
        // Serialises the first two reports about one evening, so they open one
        // case between them rather than two.
        const event = await lockEventForUpdate(tx, seat.eventId);
        if (event === null) throw new AppError(ErrorCode.NOT_FOUND);

        const existing = await tx.moderationCase.findFirst({
          where: {
            subjectType: 'EVENT',
            subjectId: seat.eventId,
            trigger: 'DISPUTE',
            status: { in: [...OPEN_CASE_STATUSES] },
          },
          select: { id: true },
        });
        const caseId =
          existing?.id ??
          (
            await tx.moderationCase.create({
              data: {
                subjectType: 'EVENT',
                subjectId: seat.eventId,
                trigger: 'DISPUTE',
                status: 'OPEN',
                createdAt: now,
              },
              select: { id: true },
            })
          ).id;

        await this.writeClaim(tx, {
          eventId: seat.eventId,
          kind: 'HOST_ABSENT_REPORT',
          participantId: seat.participantId,
          authorUserId: userId,
          statement: text,
          moderationCaseId: caseId,
          now,
        });

        // The count of distinct people, which is what co-witnessing is worth —
        // evidence for a person to weigh, never proof (plan 08).
        const reporters = await tx.noShowClaim.count({
          where: { moderationCaseId: caseId, kind: 'HOST_ABSENT_REPORT' },
        });
        await tx.moderationCase.update({
          where: { id: caseId },
          data: { reportCount: reporters },
        });

        /**
         * The host is asked for their side once, when the case opens.
         *
         * Not who reported and not what they wrote: the host learns that a report
         * exists and how long they have to answer. Telling them per report would
         * be a count of accusers arriving one message at a time.
         */
        if (existing === null) {
          const hours = await this.settings.getInt('cancellation.response_window_hours', tx);
          const host = await tx.user.findUniqueOrThrow({
            where: { id: event.hostUserId },
            select: { publicId: true },
          });
          await this.outbox.emit(
            {
              aggregateType: 'moderation_case',
              aggregateId: caseId,
              eventType: 'no_show.host_absent_reported',
              payload: {
                hostUserPublicId: host.publicId,
                eventPublicId: event.publicId,
                eventTitle: event.title,
                respondBy: new Date(now.getTime() + hours * 3_600_000).toISOString(),
              },
            },
            tx,
          );
        }

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'no_show.host_absent_reported',
            targetType: 'event',
            targetId: seat.eventId,
            after: { caseId, reporters },
          },
          tx,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  private async loadReportable(
    tx: Prisma.TransactionClient,
    userId: string,
    participantPublicId: string,
    now: Date,
  ): Promise<ClaimReadiness & { participantId: string; eventId: string }> {
    const participant = await tx.eventParticipant.findUnique({
      where: { publicId: participantPublicId },
      select: {
        id: true,
        userId: true,
        status: true,
        event: { select: { id: true, title: true, endsAt: true, hostAbsentAt: true } },
      },
    });
    if (participant === null || participant.userId !== userId) {
      throw new AppError(ErrorCode.NOT_FOUND);
    }
    if (!SEATED.includes(participant.status)) {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);
    }
    // «He did not come» is not a claim anybody can make before the evening.
    if (participant.event.endsAt > now) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);
    // Already decided that way: there is nothing left to report.
    if (participant.event.hostAbsentAt !== null) {
      throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);
    }

    const days = await this.settings.getInt('cancellation.dispute_window_days', tx);
    const closesAt = new Date(participant.event.endsAt.getTime() + days * 86_400_000);
    if (now > closesAt) throw new AppError(ErrorCode.CLAIM_WINDOW_CLOSED);

    await this.assertNotClaimed(tx, 'HOST_ABSENT_REPORT', participant.event.id, userId);

    return {
      participantId: participant.id,
      eventId: participant.event.id,
      eventTitle: participant.event.title,
      closesAt,
    };
  }

  // ── The host's side ───────────────────────────────────────────────────────

  async responseReadiness(hostUserId: string, eventPublicId: string): Promise<ClaimReadiness> {
    const found = await this.loadAnswerable(
      this.prisma,
      hostUserId,
      eventPublicId,
      this.clock.now(),
    );
    return { eventTitle: found.eventTitle, closesAt: found.closesAt };
  }

  async respondAsHost(hostUserId: string, eventPublicId: string, statement: string): Promise<void> {
    const text = validStatement(statement);
    const now = this.clock.now();

    await this.prisma.$transaction(
      async (tx) => {
        const found = await this.loadAnswerable(tx, hostUserId, eventPublicId, now);

        await this.writeClaim(tx, {
          eventId: found.eventId,
          kind: 'HOST_ABSENT_RESPONSE',
          participantId: null,
          authorUserId: hostUserId,
          statement: text,
          moderationCaseId: found.caseId,
          now,
        });

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: hostUserId,
            action: 'no_show.host_responded',
            targetType: 'event',
            targetId: found.eventId,
            after: { caseId: found.caseId },
          },
          tx,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  private async loadAnswerable(
    tx: Prisma.TransactionClient,
    hostUserId: string,
    eventPublicId: string,
    now: Date,
  ): Promise<ClaimReadiness & { eventId: string; caseId: string }> {
    const event = await tx.event.findUnique({
      where: { publicId: eventPublicId },
      select: { id: true, title: true, hostUserId: true },
    });
    if (event === null || event.hostUserId !== hostUserId) throw new AppError(ErrorCode.NOT_FOUND);

    const moderationCase = await tx.moderationCase.findFirst({
      where: {
        subjectType: 'EVENT',
        subjectId: event.id,
        trigger: 'DISPUTE',
        status: { in: [...OPEN_CASE_STATUSES] },
      },
      select: { id: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    // Decided already, or never reported: an answer has nowhere to go.
    if (moderationCase === null) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    const hours = await this.settings.getInt('cancellation.response_window_hours', tx);
    const closesAt = new Date(moderationCase.createdAt.getTime() + hours * 3_600_000);
    if (now > closesAt) throw new AppError(ErrorCode.CLAIM_WINDOW_CLOSED);

    await this.assertNotClaimed(tx, 'HOST_ABSENT_RESPONSE', event.id, hostUserId);

    return { eventId: event.id, eventTitle: event.title, caseId: moderationCase.id, closesAt };
  }

  // ── Deciding ──────────────────────────────────────────────────────────────

  /**
   * Every statement on one case, oldest first, for the person deciding it.
   *
   * Names by side and display name, never an id. Unlike a report, the parties
   * here already know one another — the host accepted the guest — so there is
   * no reporter to protect from the person reported.
   */
  async claimsForCase(caseId: string): Promise<CaseClaim[]> {
    const rows = await this.prisma.noShowClaim.findMany({
      where: { moderationCaseId: caseId },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        kind: true,
        statement: true,
        createdAt: true,
        author: { select: { profile: { select: { displayName: true } } } },
      },
    });
    return rows.map((row) => ({
      kind: row.kind,
      authorRole: row.kind === 'HOST_ABSENT_RESPONSE' ? 'HOST' : 'GUEST',
      authorDisplayName: row.author.profile?.displayName ?? 'کاربر پایه‌تَم',
      statement: row.statement,
      createdAt: row.createdAt,
    }));
  }

  async decide(
    session: AdminSession,
    caseId: string,
    input: { upheld: boolean; note: string },
  ): Promise<void> {
    if (!session.permissions.includes(PERMISSIONS.REPORT_REVIEW)) {
      throw new AppError(ErrorCode.FORBIDDEN, { required: PERMISSIONS.REPORT_REVIEW });
    }
    // §7: a terminal case carries who decided and why.
    const note = input.note.trim();
    if (note.length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const now = this.clock.now();

    await this.prisma.$transaction(
      async (tx) => {
        const moderationCase = await tx.moderationCase.findUnique({
          where: { id: caseId },
          select: { id: true, status: true, subjectType: true, subjectId: true, trigger: true },
        });
        if (moderationCase === null) throw new AppError(ErrorCode.NOT_FOUND);
        if (moderationCase.trigger !== 'DISPUTE') {
          throw new AppError(ErrorCode.WRONG_CASE_DECISION);
        }
        if (!OPEN_CASE_STATUSES.some((status) => status === moderationCase.status)) {
          throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);
        }

        const actor = { adminUserId: session.adminUserId, now, caseId };
        if (moderationCase.subjectType === 'PARTICIPATION') {
          await this.settleDispute(tx, moderationCase.subjectId, input.upheld, actor);
        } else if (moderationCase.subjectType === 'EVENT') {
          await this.settleHostAbsence(tx, moderationCase.subjectId, input.upheld, actor);
        } else {
          throw new AppError(ErrorCode.WRONG_CASE_DECISION);
        }

        await tx.moderationCase.update({
          where: { id: caseId },
          data: {
            status: input.upheld ? 'APPROVED' : 'REJECTED',
            decision: input.upheld ? 'UPHELD' : 'DISMISSED',
            decisionNote: note,
            decidedBy: session.adminUserId,
            decidedAt: now,
          },
        });

        await this.audit.record(
          {
            actorType: 'ADMIN',
            actorId: session.adminUserId,
            action: 'moderation.dispute_decided',
            targetType: 'moderation_case',
            targetId: caseId,
            before: { status: moderationCase.status },
            after: { upheld: input.upheld, note, subjectType: moderationCase.subjectType },
          },
          tx,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /** «من حاضر بودم», decided. */
  private async settleDispute(
    tx: Prisma.TransactionClient,
    participantId: string,
    upheld: boolean,
    actor: { adminUserId: string; now: Date; caseId: string },
  ): Promise<void> {
    const seat = await tx.eventParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: {
        eventId: true,
        user: { select: { publicId: true } },
        event: { select: { title: true, host: { select: { publicId: true } } } },
      },
    });
    const event = await lockEventForUpdate(tx, seat.eventId);
    if (event === null) throw new AppError(ErrorCode.NOT_FOUND);

    let coinsReturned = 0;
    if (upheld) {
      coinsReturned = await this.reverseNoShow(tx, participantId, actor);
      // The host hears that the record changed — not what the guest wrote.
      await this.tell(tx, actor.caseId, {
        recipientUserPublicId: seat.event.host.publicId,
        recipientRole: 'HOST',
        kind: 'GUEST_ABSENT_DISPUTE',
        upheld: true,
        eventTitle: seat.event.title,
      });
    }

    await this.tell(tx, actor.caseId, {
      recipientUserPublicId: seat.user.publicId,
      recipientRole: 'GUEST',
      kind: 'GUEST_ABSENT_DISPUTE',
      upheld,
      eventTitle: seat.event.title,
      coins: coinsReturned,
    });
  }

  /**
   * «میزبان نیامد», decided — every consequence in this one transaction.
   *
   * Upheld: the host pays `hostPriceFor('NO_SHOW')`; **every** guest who had a
   * seat gets their join deposit back, reporters or not, because the evening did
   * not happen for any of them; a no-show that host recorded for that night is
   * reversed, and a dispute still open about one is closed with it — nobody
   * should have to argue separately against a host found absent; and the host's
   * deposit is refused, and taken back if it was already paid.
   */
  private async settleHostAbsence(
    tx: Prisma.TransactionClient,
    eventId: string,
    upheld: boolean,
    actor: { adminUserId: string; now: Date; caseId: string },
  ): Promise<void> {
    const event = await lockEventForUpdate(tx, eventId);
    if (event === null) throw new AppError(ErrorCode.NOT_FOUND);

    const detail = await tx.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { hostAbsentAt: true, host: { select: { publicId: true } } },
    });

    const reporters = await tx.noShowClaim.findMany({
      where: { moderationCaseId: actor.caseId, kind: 'HOST_ABSENT_REPORT' },
      select: { author: { select: { publicId: true } } },
    });

    if (!upheld) {
      for (const reporter of reporters) {
        await this.tell(tx, actor.caseId, {
          recipientUserPublicId: reporter.author.publicId,
          recipientRole: 'GUEST',
          kind: 'HOST_ABSENT_REPORT',
          upheld: false,
          eventTitle: event.title,
        });
      }
      // The host was told a report exists, so they are told it was not upheld.
      await this.tell(tx, actor.caseId, {
        recipientUserPublicId: detail.host.publicId,
        recipientRole: 'HOST',
        kind: 'HOST_ABSENT_REPORT',
        upheld: false,
        eventTitle: event.title,
      });
      return;
    }

    if (detail.hostAbsentAt !== null) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    const seated = await tx.eventParticipant.findMany({
      where: { eventId, status: { in: [...SEATED] } },
      select: { id: true, userId: true, status: true, user: { select: { publicId: true } } },
    });

    // Every account this touches, locked in one fixed order (ADR-0006).
    await this.penalties.lockAccounts(tx, [event.hostUserId, ...seated.map((row) => row.userId)]);

    const price = await this.penalties.hostPriceFor('NO_SHOW', tx);
    const penalty = await this.coins.penalize(
      {
        userId: event.hostUserId,
        amount: price.coins,
        type: 'NO_SHOW_PENALTY',
        reasonCode: HOST_ABSENT_REASON,
        idempotencyKey: hostAbsentPenaltyKey(eventId),
        actorType: 'ADMIN',
        actorId: actor.adminUserId,
        refType: 'event',
        refId: eventId,
        metadata: { caseId: actor.caseId, seated: seated.length },
      },
      tx,
    );
    if (price.trust > 0) {
      await this.trust.apply(
        {
          userId: event.hostUserId,
          delta: -price.trust,
          type: 'NO_SHOW',
          reasonCode: HOST_ABSENT_REASON,
          idempotencyKey: hostAbsentTrustKey(eventId),
          actorType: 'ADMIN',
          actorId: actor.adminUserId,
          refType: 'event',
          refId: eventId,
        },
        tx,
      );
    }

    /**
     * The host's deposit and bonus, taken back if the hourly settlement paid them
     * before the decision. The sweep has held since the first report opened this
     * case; this covers a report that arrived after a payout.
     */
    const paid = await tx.coinLedger.findMany({
      where: {
        idempotencyKey: { in: [hostDepositRefundKey(eventId), hostRewardKey(eventId)] },
        reversal: { is: null },
      },
      select: { id: true },
    });
    for (const row of paid) {
      await this.coins.reverse(
        {
          ledgerId: row.id,
          reasonCode: HOST_ABSENT_REASON,
          actorType: 'ADMIN',
          actorId: actor.adminUserId,
        },
        tx,
      );
    }

    await tx.event.update({ where: { id: eventId }, data: { hostAbsentAt: actor.now } });

    for (const guest of seated) {
      let coins = await this.penalties.refundParticipant(tx, guest.id, actor.adminUserId, {
        actorType: 'ADMIN',
        reasonCode: HOST_ABSENT_REASON,
      });
      if (guest.status === 'NO_SHOW') {
        coins += await this.reverseNoShow(tx, guest.id, actor);
        // A dispute about this very no-show is answered by this decision.
        await tx.moderationCase.updateMany({
          where: {
            subjectType: 'PARTICIPATION',
            subjectId: guest.id,
            trigger: 'DISPUTE',
            status: { in: [...OPEN_CASE_STATUSES] },
          },
          data: {
            status: 'APPROVED',
            decision: 'UPHELD',
            decisionNote: `با پروندهٔ نیامدن میزبان (${actor.caseId}) بسته شد.`,
            decidedBy: actor.adminUserId,
            decidedAt: actor.now,
          },
        });
      }
      await this.tell(tx, actor.caseId, {
        recipientUserPublicId: guest.user.publicId,
        recipientRole: 'GUEST',
        kind: 'HOST_ABSENT_REPORT',
        upheld: true,
        eventTitle: event.title,
        coins,
      });
    }

    await this.tell(tx, actor.caseId, {
      recipientUserPublicId: detail.host.publicId,
      recipientRole: 'HOST',
      kind: 'HOST_ABSENT_REPORT',
      upheld: true,
      eventTitle: event.title,
      coins: penalty.charged,
    });
  }

  /**
   * Undo one no-show: the penalty row, the trust it cost, and the status.
   *
   * The coins are the exact ledger row `markNoShow` stored on the participation,
   * and `UNIQUE (reverses_ledger_id)` makes a second reversal impossible. The
   * trust is a forward movement of the size that was really taken — read from
   * the ledger, not from today's setting. A penalty capped at an empty balance
   * wrote no row, so there is nothing to return and nothing is promised.
   */
  private async reverseNoShow(
    tx: Prisma.TransactionClient,
    participantId: string,
    actor: { adminUserId: string },
  ): Promise<number> {
    const participant = await tx.eventParticipant.findUniqueOrThrow({
      where: { id: participantId },
      select: { id: true, userId: true, status: true, penaltyLedgerId: true },
    });
    assertParticipantTransition(participant.status, 'COMPLETED', participant.id);

    let coinsReturned = 0;
    if (participant.penaltyLedgerId !== null) {
      const charge = await tx.coinLedger.findUniqueOrThrow({
        where: { id: participant.penaltyLedgerId },
        select: { amount: true, reversal: { select: { id: true } } },
      });
      if (charge.reversal === null) {
        await this.coins.reverse(
          {
            ledgerId: participant.penaltyLedgerId,
            reasonCode: NO_SHOW_DISPUTE_UPHELD_REASON,
            actorType: 'ADMIN',
            actorId: actor.adminUserId,
          },
          tx,
        );
        coinsReturned = Math.abs(charge.amount);
      }
    }

    const taken = await tx.trustScoreLedger.findUnique({
      where: { idempotencyKey: participantTrustPenaltyKey(participant.id) },
      select: { delta: true },
    });
    if (taken !== null && taken.delta < 0) {
      await this.trust.apply(
        {
          userId: participant.userId,
          delta: -taken.delta,
          type: 'MODERATION',
          reasonCode: NO_SHOW_DISPUTE_UPHELD_REASON,
          idempotencyKey: noShowDisputeTrustKey(participant.id),
          actorType: 'ADMIN',
          actorId: actor.adminUserId,
          refType: 'event_participant',
          refId: participant.id,
        },
        tx,
      );
    }

    await tx.eventParticipant.update({
      where: { id: participant.id },
      data: { status: 'COMPLETED', attended: true, version: { increment: 1 } },
    });

    await this.audit.record(
      {
        actorType: 'ADMIN',
        actorId: actor.adminUserId,
        action: 'participation.no_show_reversed',
        targetType: 'event_participant',
        targetId: participant.id,
        before: { status: participant.status },
        after: { status: 'COMPLETED', coinsReturned },
      },
      tx,
    );

    return coinsReturned;
  }

  /** One outbox row per recipient: each is told something different. */
  private async tell(
    tx: Prisma.TransactionClient,
    caseId: string,
    payload: {
      recipientUserPublicId: string;
      recipientRole: 'GUEST' | 'HOST';
      kind: NoShowClaimKind;
      upheld: boolean;
      eventTitle: string;
      coins?: number;
    },
  ): Promise<void> {
    await this.outbox.emit(
      {
        aggregateType: 'moderation_case',
        aggregateId: caseId,
        eventType: 'no_show.claim_decided',
        payload: { ...payload, coins: payload.coins ?? 0 },
      },
      tx,
    );
  }

  // ── The no-shows recorded before any of this existed ──────────────────────

  /**
   * Tell each earlier no-show, once, that they can now dispute it (plan 08,
   * decided 2026-09-14: a one-off message, the window running from it).
   *
   * Until v0.13.0 no message about a no-show was sent at all, and the one sent
   * since carried no button — so the window cannot run from the no-show itself.
   * `no_show_notified_at` is the claim: every new no-show writes it in
   * `markNoShow`, so after the first pass this finds nothing.
   */
  async offerPastDisputes(limit = 100): Promise<number> {
    const now = this.clock.now();
    const days = await this.settings.getInt('cancellation.dispute_window_days');

    const rows = await this.prisma.eventParticipant.findMany({
      where: { status: 'NO_SHOW', noShowNotifiedAt: null },
      select: {
        id: true,
        publicId: true,
        user: { select: { publicId: true } },
        event: { select: { publicId: true, title: true } },
      },
      take: limit,
    });

    let offered = 0;
    for (const row of rows) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.eventParticipant.updateMany({
          where: { id: row.id, noShowNotifiedAt: null },
          data: { noShowNotifiedAt: now },
        });
        if (updated.count === 0) return false;

        await this.outbox.emit(
          {
            aggregateType: 'event_participant',
            aggregateId: row.id,
            eventType: 'participation.no_show_dispute_offer',
            payload: {
              participantPublicId: row.publicId,
              participantUserPublicId: row.user.publicId,
              eventPublicId: row.event.publicId,
              eventTitle: row.event.title,
              disputeClosesAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
            },
          },
          tx,
        );
        return true;
      });
      if (claimed) offered += 1;
    }
    return offered;
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  private async assertNotClaimed(
    tx: Prisma.TransactionClient,
    kind: NoShowClaimKind,
    eventId: string,
    authorUserId: string,
  ): Promise<void> {
    const existing = await tx.noShowClaim.findUnique({
      where: { kind_eventId_authorUserId: { kind, eventId, authorUserId } },
      select: { id: true },
    });
    if (existing !== null) throw new AppError(ErrorCode.ALREADY_CLAIMED);
  }

  private async writeClaim(
    tx: Prisma.TransactionClient,
    input: {
      eventId: string;
      kind: NoShowClaimKind;
      participantId: string | null;
      authorUserId: string;
      statement: string;
      moderationCaseId: string;
      now: Date;
    },
  ): Promise<void> {
    try {
      await tx.noShowClaim.create({
        data: {
          eventId: input.eventId,
          kind: input.kind,
          participantId: input.participantId,
          authorUserId: input.authorUserId,
          statement: input.statement,
          moderationCaseId: input.moderationCaseId,
          createdAt: input.now,
        },
      });
    } catch (error) {
      // Two taps racing past the read above: the UNIQUE answers.
      if (isUniqueViolation(error)) throw new AppError(ErrorCode.ALREADY_CLAIMED);
      throw error;
    }
  }
}

/** The form's bound, restated where a caller that skipped the form meets it. */
function validStatement(statement: string): string {
  const text = statement.trim();
  if (text.length < MIN_STATEMENT || text.length > MAX_STATEMENT) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'statement' });
  }
  return text;
}
