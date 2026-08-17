import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';

export interface AnonymizationResult {
  userId: string;
  /** Rows whose personal content was replaced rather than deleted. */
  redactedReviews: number;
  redactedReports: number;
}

/** What a deleted account's display name becomes. */
export const ANONYMOUS_DISPLAY_NAME = 'کاربر حذف‌شده';

/**
 * Data-subject deletion (§8, plan §12.5 — *"must be built, not promised"*).
 *
 * The whole difficulty is that a marketplace's history is **jointly owned**. A
 * review somebody wrote is about another person and is part of that person's
 * reputation; a coin ledger row is one side of an accounting identity; a consent
 * record is evidence that consent was given. Deleting a user must remove *their*
 * personal data without destroying other people's records or breaking the
 * invariants those records hold up.
 *
 * So this is anonymisation, not deletion, and the division is explicit:
 *
 *  - **Erased outright**: the Telegram link (the highest-value identifier in the
 *    product), the profile's free text, interests, and every notification.
 *  - **Anonymised in place**: the display name, and the free text of reviews and
 *    reports the user wrote — the *rating* survives because it belongs to the
 *    person reviewed, and the *report* survives because a moderation decision that
 *    cites vanishing evidence is not reviewable.
 *  - **Untouched**: `coin_ledger`, `trust_score_ledger`, `consent` and `audit_log`.
 *    All four are append-only by trigger and all four exist to answer questions
 *    about the past. M2 chose RESTRICT over CASCADE on `consent` for exactly this
 *    reason: "account deletion anonymises; it must not erase the record that
 *    consent was given."
 *
 * **No dangling foreign keys**, which the plan tests: nothing is deleted that
 * anything still points at. The user row itself survives, marked DELETED, because
 * every ledger row, participation and review references it.
 */
@Injectable()
export class AnonymizationService {
  private readonly logger = new Logger(AnonymizationService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * Anonymise one account.
   *
   * Idempotent: running it twice is a no-op, because everything it does is either
   * a delete of rows that are already gone or an overwrite with the same values.
   * That matters because this will be reached from a job, and a job that cannot be
   * re-run is a job nobody dares re-run.
   */
  async anonymize(userId: string, actorAdminId?: string): Promise<AnonymizationResult> {
    const now = this.clock.now();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new AppError(ErrorCode.NOT_FOUND);

    return this.prisma.$transaction(async (tx) => {
      /**
       * The Telegram link goes first and goes entirely.
       *
       * It is the identifier §3.6 builds five layers around, and unlike a display
       * name there is no anonymised form of it worth keeping — a hashed Telegram
       * id is still a Telegram id to anyone holding the original.
       */
      await tx.telegramAccount.deleteMany({ where: { userId } });

      // Interests and notifications are purely personal: nobody else's record
      // depends on either, so they are deleted rather than blanked.
      await tx.userInterest.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({ where: { userId } });

      /**
       * The profile is blanked rather than deleted, because `user_profile` is what
       * a participant list and a review page read to render a name — and a missing
       * row would turn every one of those into a null check nobody wrote.
       */
      await tx.userProfile.updateMany({
        where: { userId },
        data: {
          displayName: ANONYMOUS_DISPLAY_NAME,
          bio: null,
          gender: null,
          birthYear: null,
          districtId: null,
        },
      });

      /**
       * Reviews and reports keep their structure and lose their words.
       *
       * A rating belongs to the person reviewed — erasing it would silently move
       * somebody else's reputation — and a report's existence is what a moderation
       * case was decided on. The free text is the reviewer's own writing, and that
       * is what goes.
       */
      const redactedReviews = await tx.review.updateMany({
        where: { reviewerUserId: userId, comment: { not: null } },
        data: { comment: null },
      });
      const redactedReports = await tx.report.updateMany({
        where: { reporterUserId: userId, description: { not: null } },
        data: { description: null },
      });

      /**
       * The referral code is cleared so it stops working, but the `referral` rows
       * survive: each one is half of somebody else's reward, and deleting them
       * would make a paid-out referral unaccountable.
       */
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          deletedAt: now,
          referralCode: null,
        },
      });

      await this.audit.record(
        {
          actorType: actorAdminId === undefined ? 'SYSTEM' : 'ADMIN',
          ...(actorAdminId !== undefined ? { actorId: actorAdminId } : {}),
          action: 'user.anonymized',
          targetType: 'user',
          targetId: userId,
          before: { status: user.status },
          // Counts, never content. An audit row that quoted the text it removed
          // would be a copy of the thing being deleted (T15).
          after: {
            status: 'DELETED',
            redactedReviews: redactedReviews.count,
            redactedReports: redactedReports.count,
          },
        },
        tx,
      );

      this.logger.log(`Anonymised user ${userId}`);
      return {
        userId,
        redactedReviews: redactedReviews.count,
        redactedReports: redactedReports.count,
      };
    });
  }

  /**
   * Whether an account still holds personal data.
   *
   * Used by the test that the plan asks for — *"anonymization leaves no PII"* —
   * and worth having in the service rather than only in the test: it is the
   * definition of "done", and a definition that lives only in a test is one the
   * next change quietly moves.
   */
  async findResidualPii(userId: string): Promise<string[]> {
    const [telegram, profile, interests, notifications, reviews, reports, user] = await Promise.all(
      [
        this.prisma.telegramAccount.count({ where: { userId } }),
        this.prisma.userProfile.findUnique({
          where: { userId },
          select: { displayName: true, bio: true, birthYear: true, gender: true },
        }),
        this.prisma.userInterest.count({ where: { userId } }),
        this.prisma.notification.count({ where: { userId } }),
        this.prisma.review.count({ where: { reviewerUserId: userId, comment: { not: null } } }),
        this.prisma.report.count({ where: { reporterUserId: userId, description: { not: null } } }),
        this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } }),
      ],
    );

    const residual: string[] = [];
    if (telegram > 0) residual.push('telegram_account');
    if (interests > 0) residual.push('user_interest');
    if (notifications > 0) residual.push('notification');
    if (reviews > 0) residual.push('review.comment');
    if (reports > 0) residual.push('report.description');
    if (user?.referralCode != null) residual.push('user.referral_code');
    if (profile) {
      if (profile.displayName !== ANONYMOUS_DISPLAY_NAME)
        residual.push('user_profile.display_name');
      if (profile.bio !== null) residual.push('user_profile.bio');
      if (profile.birthYear !== null) residual.push('user_profile.birth_year');
      if (profile.gender !== null) residual.push('user_profile.gender');
    }

    return residual;
  }
}
