import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma, ReviewPairStatus } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService, type SettingKey } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { TrustService } from '../economy/trust.service';
import { isUniqueViolation } from '../identity/user.service';
import { ModerationService, type ContentScan } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  REVEALED_PAIR_STATUSES,
  assertReviewPairTransition,
  assertReviewTransition,
} from './state-machine';

export const REVIEW_REWARD_REASON = 'review.submitted';
export const REVIEW_RATING_REASON = 'review.rating';

/** The exactly-once keys. One reward per review, one trust movement per review. */
export function reviewRewardKey(reviewId: string): string {
  return `review-reward:${reviewId}`;
}
export function reviewTrustKey(reviewId: string): string {
  return `trust-review:${reviewId}`;
}

/** Which side of the participation somebody is writing from. */
export type ReviewerRole = 'HOST' | 'GUEST';

const RATING_TRUST_KEYS: Record<number, SettingKey> = {
  5: 'trust.review_rating_5',
  4: 'trust.review_rating_4',
  3: 'trust.review_rating_3',
  2: 'trust.review_rating_2',
  1: 'trust.review_rating_1',
};

export interface SubmitReviewInput {
  rating: number;
  tags?: string[];
  comment?: string;
}

/** A review the caller still owes somebody. */
export interface PendingReview {
  participantPublicId: string;
  eventPublicId: string;
  eventTitle: string;
  /** Who the caller would be reviewing, by public id and display name only. */
  revieweePublicId: string;
  revieweeDisplayName: string;
  role: ReviewerRole;
  opensAt: Date;
  deadlineAt: Date;
}

/**
 * A review as the world eventually sees it.
 *
 * Deliberately not the row: `reviewer_user_id` is absent, because a revealed
 * review is attributed to its author only where the reader is entitled to know —
 * and on a public profile they are not.
 */
export interface RevealedReview {
  publicId: string;
  rating: number;
  tags: string[];
  comment: string | null;
  submittedAt: Date;
  revealedAt: Date | null;
  /** True when this arrived through D7a: revealed, but the other side never wrote. */
  withoutCounterpart: boolean;
}

/** What the caller wrote, which they may always read back. */
export interface OwnReview {
  publicId: string;
  participantPublicId: string;
  rating: number;
  tags: string[];
  comment: string | null;
  submittedAt: Date;
  /** Null once the edit window has closed or the pair has revealed. */
  editableUntil: Date | null;
  revealed: boolean;
}

/**
 * Blind reviews (ADR-0011, D7/D7a; invariant 8).
 *
 * **The one property this service exists to guarantee: neither party can read the
 * other's review while writing their own.** Everything else here is bookkeeping.
 *
 * That property is enforced by making readability a fact about the *pair* rather
 * than about a review. Every public read joins through `review_pair` and filters
 * on `REVEALED_PAIR_STATUSES`, so an unrevealed review is **absent from the
 * response** rather than filtered out of a response that briefly contained it. The
 * plan is explicit that this belongs at the API layer and not in the interface,
 * and the tests assert it there.
 *
 * Why it matters, stated plainly: if A can see B's two stars before writing their
 * own, A's rating becomes a reaction instead of an assessment, and the whole
 * reputation signal decays into reciprocal score-trading. Retaliation is not
 * discouraged here, it is made impossible.
 */
@Injectable()
export class ReviewService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    private readonly trust: TrustService,
    private readonly moderation: ModerationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Judge a review's free text, exactly as an event's is judged (ADR-0012).
   *
   * §4.6 gives `review.moderation_status` and this is what writes it. A review
   * comment is public text about another person, so it gets the same blacklist as
   * an event description — a term that cannot appear in one cannot appear in a
   * review of it either.
   *
   * The verdict maps the way ADR-0012 defines it: `FLAG` stays visible and opens a
   * case, `BLOCK` does not become visible and opens a case. **A blocked comment
   * does not refuse the submission**, which is the one place this differs from
   * event authoring, and deliberately: the review is one half of a pair, and
   * refusing it would let one party's bad language stop the other party's review
   * from ever revealing. The rating still counts, the pair still completes, and
   * only the text is withheld pending a moderator.
   */
  private async judge(
    tx: Prisma.TransactionClient,
    comment: string | undefined,
  ): Promise<{ status: 'APPROVED' | 'FLAGGED' | 'PENDING'; scan: ContentScan | null }> {
    if (comment === undefined || comment.trim() === '') {
      return { status: 'APPROVED', scan: null };
    }

    const scan = await this.moderation.scanText(comment, tx);
    if (scan.decision === 'CLEAN') return { status: 'APPROVED', scan: null };
    return { status: scan.decision === 'FLAG' ? 'FLAGGED' : 'PENDING', scan };
  }

  /**
   * Open the review window for a settled participation.
   *
   * Called from the attendance settlement (M10) inside its transaction, so a
   * participation that completes always has a pair and one that did not complete
   * never does. Idempotent by the UNIQUE on `participant_id`: a re-run of the
   * sweep finds the pair already there rather than opening a second window.
   *
   * A **no-show gets no pair**. Reviewing somebody for not turning up is what the
   * no-show penalty is; asking the two of them to rate an evening that did not
   * happen would produce ratings about nothing.
   */
  async openForParticipant(
    tx: Prisma.TransactionClient,
    input: { participantId: string; eventId: string; endsAt: Date },
  ): Promise<void> {
    const [opensHours, deadlineDays] = await Promise.all([
      this.settings.getInt('review.window_opens_hours', tx),
      this.settings.getInt('review.window_deadline_days', tx),
    ]);

    // Both measured from the event's **end**, per §11's "opens T+24 h, deadline
    // T+7 d" — T is when the thing being reviewed finished, not when the sweep
    // happened to notice.
    const opensAt = new Date(input.endsAt.getTime() + opensHours * 3_600_000);
    const deadlineAt = new Date(input.endsAt.getTime() + deadlineDays * 24 * 3_600_000);

    await tx.reviewPair.createMany({
      data: [{ participantId: input.participantId, eventId: input.eventId, opensAt, deadlineAt }],
      skipDuplicates: true,
    });
  }

  /**
   * What the caller still owes somebody, and by when.
   *
   * Only windows that are actually open: a pair whose `opens_at` has not arrived
   * is not yet answerable, and one past its deadline no longer is. Naming the
   * counterparty is safe here because the two of them have already met — this is
   * the surface where anonymity has ended, by design (ADR-0009).
   *
   * ── `opensAt` in the future, on request (v0.7.0) ────────────────────────────
   *
   * `includeUnopened` relaxes the first half of that window, and only that half:
   * a pair past its deadline stays excluded, because it is genuinely over.
   *
   * It exists because "nothing" was the wrong answer to a real question. Somebody
   * who hosted an activity, held it, and had a guest turn up opened `/reviews`
   * and read «نظر منتظری ندارید» — which is what the screen says when the window
   * has not opened, when the sweep has not run, and when there is genuinely
   * nothing, and those are three different states. The bot passes true and says
   * *when* instead; `GET /me/reviews/pending` does not, because it answers "what
   * can I submit now".
   */
  async listPending(userId: string, includeUnopened = false): Promise<PendingReview[]> {
    const now = this.clock.now();

    const pairs = await this.prisma.reviewPair.findMany({
      where: {
        status: { in: ['PENDING', 'PARTIAL'] },
        ...(includeUnopened ? {} : { opensAt: { lte: now } }),
        deadlineAt: { gt: now },
        participant: { OR: [{ userId }, { event: { hostUserId: userId } }] },
      },
      select: {
        opensAt: true,
        deadlineAt: true,
        // *Which* side has written, never what they wrote. This is the one fact
        // about the counterparty this path is entitled to, and it is the fact that
        // makes "still pending for me" answerable at all.
        hostReviewId: true,
        guestReviewId: true,
        participant: {
          select: {
            publicId: true,
            userId: true,
            user: { select: { publicId: true, profile: { select: { displayName: true } } } },
            event: {
              select: {
                publicId: true,
                title: true,
                hostUserId: true,
                host: {
                  select: { publicId: true, profile: { select: { displayName: true } } },
                },
              },
            },
          },
        },
      },
      orderBy: { deadlineAt: 'asc' },
      take: 100,
    });

    const pending: PendingReview[] = [];
    for (const pair of pairs) {
      const role: ReviewerRole = pair.participant.event.hostUserId === userId ? 'HOST' : 'GUEST';
      // The host reviews the guest and the guest reviews the host: the reviewee is
      // always the other side of this one participation.
      const counterpart = role === 'HOST' ? pair.participant.user : pair.participant.event.host;

      // Already written is not still pending. A PARTIAL pair is pending for
      // exactly one of the two people in it, and which one is decided by whichever
      // of the two columns is still empty.
      const mine = role === 'HOST' ? pair.hostReviewId : pair.guestReviewId;
      if (mine !== null) continue;

      pending.push({
        participantPublicId: pair.participant.publicId,
        eventPublicId: pair.participant.event.publicId,
        eventTitle: pair.participant.event.title,
        revieweePublicId: counterpart.publicId,
        revieweeDisplayName: counterpart.profile?.displayName ?? 'کاربر پایه‌تَم',
        role,
        opensAt: pair.opensAt,
        deadlineAt: pair.deadlineAt,
      });
    }

    return pending;
  }

  /**
   * Write one side of a pair.
   *
   * The transaction does four things that must hold together: the review row, the
   * pair's advance, the reviewer's coins, and — only when this submission is the
   * one that completes the pair — the reveal and both sides' trust. A crash
   * between any two of them would leave a review that moved somebody's score
   * without being visible, or one visible without having moved it.
   *
   * **Nothing about the counterparty's review is read on this path**, revealed or
   * not, which is the point. The pair's status says whether somebody else has
   * written; it does not say what they wrote.
   */
  async submit(
    userId: string,
    participantPublicId: string,
    input: SubmitReviewInput,
  ): Promise<OwnReview> {
    const now = this.clock.now();

    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'rating' });
    }

    const [editMinutes, rewardCoins] = await Promise.all([
      this.settings.getInt('review.edit_window_minutes'),
      this.settings.getInt('economy.review_reward_coins'),
    ]);

    return this.prisma.$transaction(
      async (tx) => {
        const context = await this.loadWritable(tx, userId, participantPublicId, now);
        const verdict = await this.judge(tx, input.comment);

        let review;
        try {
          review = await tx.review.create({
            data: {
              eventId: context.eventId,
              participantId: context.participantId,
              reviewerUserId: userId,
              revieweeUserId: context.revieweeUserId,
              rating: input.rating,
              tags: input.tags ?? [],
              comment: input.comment ?? null,
              moderationStatus: verdict.status,
              submittedAt: now,
              createdAt: now,
              editDeadlineAt: new Date(now.getTime() + editMinutes * 60_000),
            },
            select: { id: true, publicId: true, editDeadlineAt: true },
          });
        } catch (error) {
          // The UNIQUE on `(participant_id, reviewer_user_id)` answering —
          // invariant 6, decided by the database rather than by a read this code
          // performed a moment earlier.
          if (isUniqueViolation(error)) throw new AppError(ErrorCode.ALREADY_REVIEWED);
          throw error;
        }

        if (verdict.scan !== null) {
          await this.moderation.openCase(tx, {
            subjectType: 'REVIEW',
            subjectId: review.id,
            scan: verdict.scan,
          });
        }

        const isHost = context.role === 'HOST';
        const nextStatus: ReviewPairStatus =
          context.pairStatus === 'PENDING' ? 'PARTIAL' : 'REVEALED';
        assertReviewPairTransition(context.pairStatus, nextStatus, context.pairId);

        await tx.reviewPair.update({
          where: { id: context.pairId },
          data: {
            ...(isHost ? { hostReviewId: review.id } : { guestReviewId: review.id }),
            status: nextStatus,
            ...(nextStatus === 'REVEALED' ? { revealedAt: now } : {}),
          },
        });

        /**
         * The reward is for writing one, and it is paid now.
         *
         * Paying at reveal instead would make the reward depend on whether
         * somebody *else* did their part, which is both unfair and exactly the
         * incentive D7 removes elsewhere: it would give a reviewer a reason to care
         * what the counterparty does.
         */
        await this.coins.apply(
          {
            userId,
            amount: rewardCoins,
            type: 'REVIEW_REWARD',
            reasonCode: REVIEW_REWARD_REASON,
            idempotencyKey: reviewRewardKey(review.id),
            actorType: 'SYSTEM',
            refType: 'review',
            refId: review.id,
          },
          tx,
        );

        if (nextStatus === 'REVEALED') {
          await this.revealPair(tx, context.pairId, now, 'REVEALED');
        }

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'review.submitted',
            targetType: 'review',
            targetId: review.id,
            // The rating is a decision about somebody else and belongs in the
            // trail; the comment is free text about a private evening and does
            // not (ADR-0009). It lives on the row, which is where moderation
            // reads it.
            after: { rating: input.rating, pairStatus: nextStatus },
          },
          tx,
        );

        return {
          publicId: review.publicId,
          participantPublicId,
          rating: input.rating,
          tags: input.tags ?? [],
          comment: input.comment ?? null,
          submittedAt: now,
          editableUntil: nextStatus === 'REVEALED' ? null : review.editDeadlineAt,
          revealed: nextStatus === 'REVEALED',
        };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Change your mind, briefly (plan §11: one hour, and never after reveal).
   *
   * Two refusals, and the second is the interesting one. Past the edit deadline is
   * simply the window closing. **After reveal is a refusal even inside the hour**,
   * because once the counterparty can see what you wrote, editing it turns a blind
   * review into a reply — which is the exact dynamic D7 exists to prevent.
   */
  async edit(
    userId: string,
    participantPublicId: string,
    input: SubmitReviewInput,
  ): Promise<OwnReview> {
    const now = this.clock.now();

    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, { field: 'rating' });
    }

    return this.prisma.$transaction(async (tx) => {
      const participant = await tx.eventParticipant.findUnique({
        where: { publicId: participantPublicId },
        select: { id: true },
      });
      if (!participant) throw new AppError(ErrorCode.NOT_FOUND);

      const review = await tx.review.findUnique({
        where: {
          participantId_reviewerUserId: {
            participantId: participant.id,
            reviewerUserId: userId,
          },
        },
        select: {
          id: true,
          publicId: true,
          status: true,
          submittedAt: true,
          editDeadlineAt: true,
        },
      });
      if (!review) throw new AppError(ErrorCode.NOT_FOUND);

      if (review.status !== 'SUBMITTED') throw new AppError(ErrorCode.REVIEW_NOT_EDITABLE);
      if (review.editDeadlineAt <= now) throw new AppError(ErrorCode.REVIEW_NOT_EDITABLE);

      // Re-judged, because an edit is new text. Without this, "submit something
      // clean, then edit it into something else" would be the obvious way past
      // the scanner.
      const verdict = await this.judge(tx, input.comment);

      await tx.review.update({
        where: { id: review.id },
        data: {
          rating: input.rating,
          tags: input.tags ?? [],
          comment: input.comment ?? null,
          moderationStatus: verdict.status,
        },
      });

      if (verdict.scan !== null) {
        await this.moderation.openCase(tx, {
          subjectType: 'REVIEW',
          subjectId: review.id,
          scan: verdict.scan,
        });
      }

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'review.edited',
          targetType: 'review',
          targetId: review.id,
          after: { rating: input.rating },
        },
        tx,
      );

      return {
        publicId: review.publicId,
        participantPublicId,
        rating: input.rating,
        tags: input.tags ?? [],
        comment: input.comment ?? null,
        submittedAt: review.submittedAt,
        editableUntil: review.editDeadlineAt,
        revealed: false,
      };
    });
  }

  /**
   * Everything the world may see about one person.
   *
   * **Invariant 8 lives here.** The filter is on the *pair's* status, not the
   * review's: a review whose pair has not revealed is not in this result at all.
   * A `WHERE` on the review's own status would be one refactor away from being
   * true only by accident, because a review is SUBMITTED both before its
   * counterparty writes and while the pair sits waiting.
   */
  async listForUser(revieweePublicId: string, limit = 50): Promise<RevealedReview[]> {
    const user = await this.prisma.user.findUnique({
      where: { publicId: revieweePublicId },
      select: { id: true },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    const rows = await this.prisma.review.findMany({
      where: {
        revieweeUserId: user.id,
        status: 'REVEALED',
        // ADR-0012's rule, applied to reviews: FLAG stays visible and opens a
        // case, BLOCK does not become visible. PENDING is what a BLOCK verdict
        // writes, so the allowlist is the two that publish rather than a denylist
        // of the ones that do not — a new status added later defaults to hidden.
        moderationStatus: { in: ['APPROVED', 'FLAGGED'] },
        // The pair is the authority on whether anybody may read this.
        OR: [
          { pairAsHost: { status: { in: [...REVEALED_PAIR_STATUSES] } } },
          { pairAsGuest: { status: { in: [...REVEALED_PAIR_STATUSES] } } },
        ],
      },
      select: {
        publicId: true,
        rating: true,
        tags: true,
        comment: true,
        submittedAt: true,
        revealedAt: true,
        pairAsHost: { select: { status: true } },
        pairAsGuest: { select: { status: true } },
      },
      orderBy: { submittedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });

    return rows.map((row) => ({
      publicId: row.publicId,
      rating: row.rating,
      tags: row.tags,
      comment: row.comment,
      submittedAt: row.submittedAt,
      revealedAt: row.revealedAt,
      // «بدون بازخورد متقابل» — D7a asks for this to be *marked*, so the reader
      // knows the other side never answered and can weigh it accordingly.
      withoutCounterpart: (row.pairAsHost?.status ?? row.pairAsGuest?.status) === 'EXPIRED_PARTIAL',
    }));
  }

  /** What the caller wrote about this participation, which is always theirs to read. */
  async findOwn(userId: string, participantPublicId: string): Promise<OwnReview | null> {
    const now = this.clock.now();

    const participant = await this.prisma.eventParticipant.findUnique({
      where: { publicId: participantPublicId },
      select: { id: true },
    });
    if (!participant) throw new AppError(ErrorCode.NOT_FOUND);

    const review = await this.prisma.review.findUnique({
      where: {
        participantId_reviewerUserId: { participantId: participant.id, reviewerUserId: userId },
      },
      select: {
        publicId: true,
        rating: true,
        tags: true,
        comment: true,
        submittedAt: true,
        editDeadlineAt: true,
        status: true,
      },
    });
    if (!review) return null;

    const editable = review.status === 'SUBMITTED' && review.editDeadlineAt > now;
    return {
      publicId: review.publicId,
      participantPublicId,
      rating: review.rating,
      tags: review.tags,
      comment: review.comment,
      submittedAt: review.submittedAt,
      editableUntil: editable ? review.editDeadlineAt : null,
      revealed: review.status === 'REVEALED',
    };
  }

  /**
   * The deadline sweep (plan §3.5: hourly).
   *
   * Settles every pair whose window has closed. One side written becomes
   * `EXPIRED_PARTIAL` and **is revealed** — D7a, so the reviewer's effort is not
   * thrown away for the counterparty's silence — and neither side becomes
   * `EXPIRED_EMPTY`, which reveals nothing because there is nothing to reveal.
   *
   * One transaction per pair. Scheduling it is M13's repeatable job, exactly as
   * M6 left `expireOverdue` and M10 left the attendance sweep.
   */
  async settleExpired(limit = 200): Promise<{ partial: number; empty: number }> {
    const now = this.clock.now();

    const due = await this.prisma.reviewPair.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL'] }, deadlineAt: { lte: now } },
      select: { id: true },
      orderBy: { deadlineAt: 'asc' },
      take: limit,
    });

    const result = { partial: 0, empty: 0 };
    for (const { id } of due) {
      const settled = await this.settleOne(id, now);
      if (settled === 'EXPIRED_PARTIAL') result.partial += 1;
      if (settled === 'EXPIRED_EMPTY') result.empty += 1;
    }
    return result;
  }

  /**
   * Tell both sides their review window has opened (v0.8.1).
   *
   * ── The template that had no producer ───────────────────────────────────────
   *
   * `TEMPLATES.REVIEW_WINDOW_OPEN` has had Persian copy, a notification category
   * and a `render()` case since M12, and **nothing has ever emitted it**. The
   * window opens 24 hours after an activity ends and closes seven days later, and
   * for that entire week the only way to find out a review was waiting was to
   * open `/reviews` and look. `PROJECT_MEMORY` §7 trap 24 is the same shape one
   * layer up — *when an error is built to carry detail, grep for who reads it* —
   * and this is its mirror: when a template is written, grep for who sends it.
   *
   * It matters more here than a missed nudge usually would, because the pair is
   * **blind**. A review nobody writes is not just one missing rating: the
   * counterparty's review never reveals either, so one person's silence costs two
   * people their feedback.
   *
   * ── Why both sides, always ─────────────────────────────────────────────────
   *
   * The window opens for the pair, not for a person, and at the moment it opens
   * neither side has written — `opensAt` is in the future for the whole period a
   * review could already have been submitted. So there is no "who still owes one"
   * to compute here; that is `listPending`'s job, and `/reviews` is where the
   * message sends them.
   *
   * ── Exactly once, and what happens on the first run ────────────────────────
   *
   * `reminded_at` is stamped in the same transaction as the outbox row, so a
   * crash between them is impossible and a re-run finds nothing. Pairs that
   * existed before migration 0045 all read NULL, so the first sweep after the
   * deploy reminds everybody whose window is currently open — which is the point,
   * not a side effect: those are exactly the people who are owed a review and
   * have never been told.
   *
   * Bounded by `limit` per run like every other sweep here, so a backlog is
   * worked through over several hours rather than becoming one burst against
   * Telegram's rate limit.
   */
  async announceOpenWindows(limit = 200): Promise<number> {
    const now = this.clock.now();

    const due = await this.prisma.reviewPair.findMany({
      where: {
        remindedAt: null,
        opensAt: { lte: now },
        // Past the deadline there is nothing to write, so a reminder would be an
        // invitation to a form that refuses. `settleExpired` has these.
        deadlineAt: { gt: now },
        status: { in: ['PENDING', 'PARTIAL'] },
      },
      select: { id: true },
      orderBy: { opensAt: 'asc' },
      take: limit,
    });

    let announced = 0;
    for (const { id } of due) {
      if (await this.announceOne(id, now)) announced += 1;
    }
    return announced;
  }

  /** One pair, in its own transaction — the shape every sweep here uses. */
  private async announceOne(pairId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        /**
         * Claimed by the update, not by the scan.
         *
         * `updateMany` with `reminded_at: null` in the filter is the claim: two
         * workers running the sweep at once both scanned the same row, and
         * exactly one of them matches. A read-then-write would have a window
         * between them, and the visible cost of losing that race is somebody
         * being told twice about the same review.
         */
        const claimed = await tx.reviewPair.updateMany({
          where: { id: pairId, remindedAt: null },
          data: { remindedAt: now },
        });
        if (claimed.count === 0) return false;

        const pair = await tx.reviewPair.findUniqueOrThrow({
          where: { id: pairId },
          select: {
            deadlineAt: true,
            participant: {
              select: {
                publicId: true,
                user: { select: { publicId: true } },
                event: {
                  select: { publicId: true, title: true, host: { select: { publicId: true } } },
                },
              },
            },
          },
        });

        await this.outbox.emit(
          {
            aggregateType: 'review_pair',
            aggregateId: pairId,
            eventType: 'review.window_open',
            // Public ids only — this payload becomes the text of a Telegram
            // message (ADR-0009, invariant 7).
            payload: {
              participantPublicId: pair.participant.publicId,
              eventPublicId: pair.participant.event.publicId,
              eventTitle: pair.participant.event.title,
              hostUserPublicId: pair.participant.event.host.publicId,
              guestUserPublicId: pair.participant.user.publicId,
              /**
               * How long is left, rounded **up**.
               *
               * The template says «تا N روز آینده», and rounding down would say
               * «تا ۰ روز» on the last day — a deadline the reader has already
               * missed, for a form that still works.
               */
              daysLeft: Math.max(
                Math.ceil((pair.deadlineAt.getTime() - now.getTime()) / 86_400_000),
                1,
              ),
            },
          },
          tx,
        );

        return true;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  private async settleOne(pairId: string, now: Date): Promise<ReviewPairStatus | null> {
    return this.prisma.$transaction(
      async (tx) => {
        // Re-read under the transaction: a submission may have landed between the
        // scan that selected this pair and this transaction starting.
        const pair = await tx.reviewPair.findUniqueOrThrow({
          where: { id: pairId },
          select: { status: true, deadlineAt: true },
        });
        if (pair.status !== 'PENDING' && pair.status !== 'PARTIAL') return null;
        if (pair.deadlineAt > now) return null;

        const next: ReviewPairStatus =
          pair.status === 'PARTIAL' ? 'EXPIRED_PARTIAL' : 'EXPIRED_EMPTY';
        assertReviewPairTransition(pair.status, next, pairId);

        await tx.reviewPair.update({
          where: { id: pairId },
          data: { status: next, revealedAt: now },
        });

        if (next === 'EXPIRED_PARTIAL') await this.revealPair(tx, pairId, now, next);

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'review_pair.expired',
            targetType: 'review_pair',
            targetId: pairId,
            before: { status: pair.status },
            after: { status: next },
          },
          tx,
        );

        return next;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Reveal whatever the pair holds, and apply the reputation it earned.
   *
   * The trust half is where D7a bites. A pair that revealed because **both** sides
   * wrote moves both scores. A pair that expired with one side written reveals that
   * review but moves nothing, because somebody who never reviewed cannot have their
   * score moved by a counterparty they had no opportunity to answer. That default
   * is overridable at runtime through `review.partial_reveal_affects_trust`, which
   * is the flag the plan flags.
   */
  private async revealPair(
    tx: Prisma.TransactionClient,
    pairId: string,
    now: Date,
    outcome: 'REVEALED' | 'EXPIRED_PARTIAL',
  ): Promise<void> {
    const pair = await tx.reviewPair.findUniqueOrThrow({
      where: { id: pairId },
      select: {
        participant: {
          select: {
            publicId: true,
            user: { select: { publicId: true } },
            // `title` so the reveal notification can name the event: every template
            // that says «…» reads `eventTitle` from the payload.
            event: {
              select: { publicId: true, title: true, host: { select: { publicId: true } } },
            },
          },
        },
        hostReview: { select: { id: true, status: true, rating: true, revieweeUserId: true } },
        guestReview: { select: { id: true, status: true, rating: true, revieweeUserId: true } },
      },
    });

    const affectsTrust =
      outcome === 'REVEALED' ||
      (await this.settings.getInt('review.partial_reveal_affects_trust', tx)) === 1;

    for (const review of [pair.hostReview, pair.guestReview]) {
      if (!review || review.status !== 'SUBMITTED') continue;

      assertReviewTransition(review.status, 'REVEALED', review.id);
      await tx.review.update({
        where: { id: review.id },
        data: { status: 'REVEALED', revealedAt: now },
      });

      if (affectsTrust) await this.applyRatingTrust(tx, review);
    }

    /**
     * One domain event for the pair, not one per review.
     *
     * Both sides become visible at the same instant, so both people learn at the
     * same instant — telling one of them first would hand them a head start on a
     * reply, which is the asymmetry D7 exists to remove. M13's relay fans this out.
     */
    await this.outbox.emit(
      {
        aggregateType: 'review_pair',
        aggregateId: pairId,
        eventType: 'review.revealed',
        // Public ids only: this payload becomes the text of a Telegram message
        // (ADR-0009). Both people are named because both are being told.
        payload: {
          participantPublicId: pair.participant.publicId,
          eventPublicId: pair.participant.event.publicId,
          eventTitle: pair.participant.event.title,
          hostUserPublicId: pair.participant.event.host.publicId,
          guestUserPublicId: pair.participant.user.publicId,
          outcome,
          revealedAt: now.toISOString(),
        },
      },
      tx,
    );
  }

  private async applyRatingTrust(
    tx: Prisma.TransactionClient,
    review: { id: string; rating: number; revieweeUserId: string },
  ): Promise<void> {
    const key = RATING_TRUST_KEYS[review.rating];
    if (!key) return;

    const delta = await this.settings.getInt(key, tx);
    // Three stars is worth nothing by policy, and a zero movement is rejected as a
    // bug by `TrustService` — correctly, since it would consume a key for a
    // movement no rule intended.
    if (delta === 0) return;

    await this.trust.apply(
      {
        userId: review.revieweeUserId,
        delta,
        type: 'REVIEW',
        reasonCode: REVIEW_RATING_REASON,
        idempotencyKey: reviewTrustKey(review.id),
        actorType: 'SYSTEM',
        refType: 'review',
        refId: review.id,
        metadata: { rating: review.rating },
      },
      tx,
    );
  }

  /**
   * Everything `submit` needs, with every refusal in one place.
   *
   * Deliberately loads no review of the counterparty's — not even to count one.
   * The pair's status carries whether somebody else has written, which is all this
   * path is entitled to know.
   */
  private async loadWritable(
    tx: Prisma.TransactionClient,
    userId: string,
    participantPublicId: string,
    now: Date,
  ): Promise<{
    participantId: string;
    eventId: string;
    pairId: string;
    pairStatus: ReviewPairStatus;
    revieweeUserId: string;
    role: ReviewerRole;
  }> {
    const participant = await tx.eventParticipant.findUnique({
      where: { publicId: participantPublicId },
      select: {
        id: true,
        userId: true,
        eventId: true,
        event: { select: { hostUserId: true } },
        reviewPair: { select: { id: true, status: true, opensAt: true, deadlineAt: true } },
      },
    });
    // Not-yours and not-found answer identically: whether a participation exists
    // is not something a stranger may learn (T3.3).
    if (!participant) throw new AppError(ErrorCode.NOT_FOUND);

    const isHost = participant.event.hostUserId === userId;
    const isGuest = participant.userId === userId;
    if (!isHost && !isGuest) throw new AppError(ErrorCode.NOT_FOUND);

    const pair = participant.reviewPair;
    // No pair means the participation never completed — a cancellation, a no-show,
    // or an event that has not been settled yet. There is nothing to review.
    if (!pair) throw new AppError(ErrorCode.REVIEW_WINDOW_CLOSED);
    if (pair.opensAt > now || pair.deadlineAt <= now) {
      throw new AppError(ErrorCode.REVIEW_WINDOW_CLOSED);
    }
    if (pair.status !== 'PENDING' && pair.status !== 'PARTIAL') {
      throw new AppError(ErrorCode.REVIEW_WINDOW_CLOSED);
    }

    return {
      participantId: participant.id,
      eventId: participant.eventId,
      pairId: pair.id,
      pairStatus: pair.status,
      revieweeUserId: isHost ? participant.userId : participant.event.hostUserId,
      role: isHost ? 'HOST' : 'GUEST',
    };
  }
}
