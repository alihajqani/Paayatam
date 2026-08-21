import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@payetam/db';
import type { ReferralRejectionReason, ReferralStatus } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { assertReferralTransition } from '../economy/referral-state-machine';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/**
 * What the panel shows for one referral.
 *
 * Two people by `public_id` and nothing else — no display names, no Telegram
 * anything. A referral is a relationship between two accounts, and reviewing it
 * for fraud is a question about *behaviour*: how many, how fast, from where. A
 * name would answer none of that and would put two profiles on a screen that has
 * no reason to show them.
 */
export interface ReferralReview {
  id: string;
  referrerPublicId: string;
  referredPublicId: string;
  status: ReferralStatus;
  /**
   * Whether this referral carries velocity or pattern signals (T6).
   *
   * A boolean on the list and the detail behind it on one row, so a moderator can
   * sort a queue by "worth looking at" without every page fetching JSON nobody
   * reads.
   */
  flagged: boolean;
  /** The signals themselves. Internal, and never projected to either user. */
  fraudSignals: Prisma.JsonValue | null;
  qualifiedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: ReferralRejectionReason | null;
  /** Internal free text. Same rule as `fraudSignals`. */
  reviewNote: string | null;
  createdAt: Date;
}

export interface ReferralListFilters {
  status?: ReferralStatus;
  /** Only the ones a signal fired on. The queue a moderator actually works. */
  flaggedOnly?: boolean;
  /** Everything this account referred, for "is this a farm?". */
  referrerPublicId?: string;
  limit?: number;
  offset?: number;
}

export interface ReferralPage {
  referrals: ReferralReview[];
  total: number;
}

/**
 * Reviewing and rejecting referrals (M19, ADR-0010, T6).
 *
 * The half of T6 that was missing. Velocity signals have been written to
 * `referral.fraud_signals` since M9 *"for admin review"*, and there was no admin
 * surface to review them from and no state to move a referral into — the enum
 * carried `REJECTED` and nothing wrote it. An enum value nothing writes and a
 * signal nobody can act on are the same bug seen from two sides.
 *
 * Three properties hold everything here together:
 *
 *  1. **A rejection is a human act.** Nothing in the settlement path calls this.
 *     T6 is explicit that a wrong automatic rejection silently steals a real
 *     user's reward, so the automation records and a person decides.
 *  2. **A rejection cannot pay and cannot unpay.** `PENDING → REJECTED` is the
 *     only way in, so a `QUALIFIED` referral — one that has already produced two
 *     `coin_ledger` rows — can never be relabelled as refused. Taking coins back
 *     is `CoinService.reverse`, a separate and deliberate act.
 *  3. **Reinstating restores eligibility, never the reward.** `REJECTED →
 *     PENDING` puts the referral back in the ordinary path, where
 *     `qualifyForAttendance` still checks the attendance for itself and the
 *     idempotency key still guards the payout. There is no `REJECTED →
 *     QUALIFIED`: an admin may restore a chance and may not grant a reward.
 *
 * The permission is `referral.manage`, held by `SUPER_ADMIN` and `MODERATOR`.
 * Fraud review is moderation, and nothing behind this key can move a balance —
 * which is why it does not need to be as narrow as `coin.adjust`.
 */
@Injectable()
export class ReferralAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The review queue, newest first, with a total behind the page.
   *
   * No audit row — invariant 12 is about mutations. `flaggedOnly` is the filter
   * the queue is actually worked from: the overwhelming majority of referrals
   * have no signals at all, which is what makes a non-null `fraud_signals` mean
   * something when somebody goes looking (T6).
   */
  async list(session: AdminSession, filters: ReferralListFilters = {}): Promise<ReferralPage> {
    this.access.assertPermission(session, PERMISSIONS.REFERRAL_MANAGE);

    const referrer =
      filters.referrerPublicId === undefined
        ? undefined
        : await this.prisma.user.findUnique({
            where: { publicId: filters.referrerPublicId },
            select: { id: true },
          });
    // A filter naming somebody who does not exist matches nothing, rather than
    // silently matching everybody — which is what dropping the clause would do.
    if (filters.referrerPublicId !== undefined && !referrer) {
      return { referrals: [], total: 0 };
    }

    const where: Prisma.ReferralWhereInput = {
      ...(filters.status !== undefined ? { status: filters.status } : {}),
      ...(filters.flaggedOnly === true ? { fraudSignals: { not: Prisma.DbNull } } : {}),
      ...(referrer != null ? { referrerUserId: referrer.id } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(filters.limit ?? 50, 1), 200),
        skip: Math.max(filters.offset ?? 0, 0),
        select: REFERRAL_SELECT,
      }),
      this.prisma.referral.count({ where }),
    ]);

    return { referrals: rows.map(toReview), total };
  }

  /** One referral, with its signals. The detail behind a queue row. */
  async get(session: AdminSession, referralId: string): Promise<ReferralReview> {
    this.access.assertPermission(session, PERMISSIONS.REFERRAL_MANAGE);

    const row = await this.prisma.referral.findUnique({
      where: { id: referralId },
      select: REFERRAL_SELECT,
    });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);
    return toReview(row);
  }

  /**
   * Refuse a referral, in writing.
   *
   * The reason is a **code** and the note is free text, and they are separated
   * because they have different audiences: the code is countable and rendered in
   * Persian to the person it happened to, and the note is for the next moderator.
   * Neither is optional — §7's rule for a moderation case is that a terminal
   * state needs a signature and an explanation, and this is the other terminal
   * decision in the product that withholds money.
   *
   * `assertReferralTransition` is what refuses a `QUALIFIED` referral: it has
   * already produced two ledger rows, and a status saying "rejected" over them
   * would be a record disagreeing with itself (invariant 10).
   */
  async reject(
    session: AdminSession,
    referralId: string,
    input: { reason: ReferralRejectionReason; note: string },
  ): Promise<ReferralReview> {
    this.access.assertPermission(session, PERMISSIONS.REFERRAL_MANAGE);
    if (input.note.trim().length < 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'note' });
    }
    const now = this.clock.now();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.referral.findUnique({
        where: { id: referralId },
        select: { id: true, status: true, referrerUserId: true },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

      assertReferralTransition(existing.status, 'REJECTED', referralId);

      const updated = await tx.referral.update({
        where: { id: referralId },
        data: {
          status: 'REJECTED',
          rejectedAt: now,
          rejectionReason: input.reason,
          rejectedByAdminId: session.adminUserId,
          reviewNote: input.note.trim(),
        },
        select: REFERRAL_SELECT,
      });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'referral.rejected',
          targetType: 'referral',
          targetId: referralId,
          before: { status: existing.status },
          // The note is in the trail as well as on the row: the row can be
          // rewritten by a reinstatement and `audit_log` cannot (invariant 10).
          after: { status: 'REJECTED', reason: input.reason, note: input.note.trim() },
        },
        tx,
      );

      return toReview(updated);
    });
  }

  /**
   * Put a rejected referral back into the ordinary path.
   *
   * **This pays nobody.** It restores `PENDING`, and the referral then earns its
   * reward exactly as any other does: `ReferralService.qualifyForAttendance`
   * checks the attendance condition itself rather than trusting a caller, and the
   * payout is guarded by an idempotency key derived from the referral. So a
   * referral rejected *after* qualifying cannot exist (the state machine refuses
   * it), and one reinstated after a mistaken rejection is simply eligible again.
   *
   * The rejection columns are cleared, because the second CHECK on the table says
   * a referral that is not `REJECTED` carries no rejection — a live referral
   * displayed beside a stale reason is a moderator reading something untrue.
   */
  async reinstate(
    session: AdminSession,
    referralId: string,
    note: string,
  ): Promise<ReferralReview> {
    this.access.assertPermission(session, PERMISSIONS.REFERRAL_MANAGE);
    if (note.trim().length < 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'note' });
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.referral.findUnique({
        where: { id: referralId },
        select: { id: true, status: true, rejectionReason: true },
      });
      if (!existing) throw new AppError(ErrorCode.NOT_FOUND);

      assertReferralTransition(existing.status, 'PENDING', referralId);

      const updated = await tx.referral.update({
        where: { id: referralId },
        data: {
          status: 'PENDING',
          rejectedAt: null,
          rejectionReason: null,
          rejectedByAdminId: null,
          reviewNote: note.trim(),
        },
        select: REFERRAL_SELECT,
      });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'referral.reinstated',
          targetType: 'referral',
          targetId: referralId,
          before: { status: existing.status, reason: existing.rejectionReason },
          after: { status: 'PENDING', note: note.trim() },
        },
        tx,
      );

      return toReview(updated);
    });
  }
}

/**
 * Field by field, never a spread (§3.6 layer 2).
 *
 * `referral` carries two internal user ids and the ledger row that paid it.
 * Neither user id may leave the backend, and the ledger id belongs to the economy
 * views rather than to a fraud queue.
 */
const REFERRAL_SELECT = {
  id: true,
  status: true,
  fraudSignals: true,
  qualifiedAt: true,
  rejectedAt: true,
  rejectionReason: true,
  reviewNote: true,
  createdAt: true,
  referrer: { select: { publicId: true } },
  referred: { select: { publicId: true } },
} as const;

function toReview(row: {
  id: string;
  status: ReferralStatus;
  fraudSignals: Prisma.JsonValue | null;
  qualifiedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: ReferralRejectionReason | null;
  reviewNote: string | null;
  createdAt: Date;
  referrer: { publicId: string };
  referred: { publicId: string };
}): ReferralReview {
  return {
    id: row.id,
    referrerPublicId: row.referrer.publicId,
    referredPublicId: row.referred.publicId,
    status: row.status,
    flagged: row.fraudSignals !== null,
    fraudSignals: row.fraudSignals,
    qualifiedAt: row.qualifiedAt,
    rejectedAt: row.rejectedAt,
    rejectionReason: row.rejectionReason,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt,
  };
}
