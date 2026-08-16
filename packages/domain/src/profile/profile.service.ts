import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Gender, OnboardingState } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import type { Env } from '@payetam/config';
import { AppError, ErrorCode } from '@payetam/shared';
import { CatalogService, type NamedRef } from '../catalog/catalog.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { TRUST_PROFILE_COMPLETE_REASON, TrustService } from '../economy/trust.service';
import { AuditService } from '../audit/audit.service';
import { isOldEnough } from './age';

export interface CompleteProfileInput {
  displayName: string;
  gender?: Gender;
  birthYear: number;
  cityId: string;
  districtId?: string;
  bio?: string;
  interestIds: string[];
}

export interface ProfileDetail {
  displayName: string;
  gender: Gender | null;
  birthYear: number | null;
  city: NamedRef;
  district: NamedRef | null;
  bio: string | null;
  interests: NamedRef[];
  completedAt: Date | null;
}

export interface ProfileCompletion {
  profile: ProfileDetail;
  onboardingState: OnboardingState;
  balance: number;
  /** True only for the call that actually granted the coins. */
  rewardGranted: boolean;
  /** The score after the profile-completion movement (plan §11: +5). */
  trustScore: number;
}

/** The reason code written to the ledger. Stable: the admin panel renders it. */
export const ONBOARDING_REWARD_REASON = 'onboarding.profile_completed';

/**
 * Derives the ledger's exactly-once key for a user's onboarding reward.
 *
 * A function rather than a template at the call site, because this string *is*
 * the guarantee: two call sites that format it differently would grant the
 * reward twice, and nothing downstream could tell that they meant the same thing.
 */
export function onboardingRewardKey(userId: string): string {
  return `onboarding:${userId}`;
}

/** The same discipline for the trust half: one key, one movement, ever. */
export function profileTrustKey(userId: string): string {
  return `trust-profile:${userId}`;
}

/**
 * Owns `user_profile` and `user_interest` (plan §3.3).
 *
 * The invariant it defends is 18+ at write. Everything else here exists to make
 * one sentence true: **completing a profile grants the onboarding reward exactly
 * once**, no matter how many times, or how concurrently, it is called.
 */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
  ) {}

  async find(userId: string): Promise<ProfileDetail | null> {
    const profile = await this.prisma.userProfile.findUnique({
      where: { userId },
      include: {
        city: { select: { id: true, slug: true, nameFa: true } },
        district: { select: { id: true, slug: true, nameFa: true } },
      },
    });
    if (!profile) return null;

    const interests = await this.prisma.userInterest.findMany({
      where: { userId },
      include: { interest: { select: { id: true, slug: true, nameFa: true } } },
      orderBy: { interest: { sortOrder: 'asc' } },
    });

    return {
      displayName: profile.displayName,
      gender: profile.gender,
      birthYear: profile.birthYear,
      city: profile.city,
      district: profile.district,
      bio: profile.bio,
      interests: interests.map((row) => row.interest),
      completedAt: profile.completedAt,
    };
  }

  /**
   * Writes the profile, advances onboarding, and grants the reward.
   *
   * Everything is one transaction on purpose: a reward that commits without the
   * profile, or a profile that commits without the reward, are both states a
   * user would have to contact support about.
   *
   * Idempotent, and tested under concurrency. Two guards, at different levels:
   * the user row lock below serialises callers, and the ledger's UNIQUE
   * `idempotency_key` is what still holds if a future caller forgets the lock.
   * The second is the real guarantee; the first is what keeps the profile write
   * itself deterministic.
   */
  async complete(userId: string, input: CompleteProfileInput): Promise<ProfileCompletion> {
    const now = this.clock.now();

    // Before the transaction: cheap, and refusing an under-age user should not
    // depend on having taken a lock first.
    const minAge = await this.settings.getInt('profile.min_age_years');
    if (!isOldEnough(input.birthYear, minAge, now, this.env.APP_TIMEZONE)) {
      throw new AppError(ErrorCode.AGE_BELOW_MINIMUM);
    }

    const [rewardCoins, trustDelta] = await Promise.all([
      this.settings.getInt('economy.onboarding_reward_coins'),
      this.settings.getInt('trust.profile_complete_delta'),
    ]);

    const result = await this.prisma.$transaction(async (tx) => {
      // Lock ordering: user row first, then the coin account inside CoinService.
      // Every module that touches both must use this order (ADR-0006).
      const [locked] = await tx.$queryRaw<{ onboarding_state: OnboardingState }[]>`
        SELECT "onboarding_state" FROM "user" WHERE "id" = ${userId} FOR UPDATE
      `;
      if (!locked) {
        throw new AppError(ErrorCode.UNAUTHENTICATED);
      }
      const previousState = locked.onboarding_state;
      if (previousState === 'NEW') {
        // The guard already enforces this. Restated here because the bot will
        // call the same service in M4, and a domain rule that only holds for one
        // adapter is not a domain rule.
        throw new AppError(ErrorCode.TERMS_NOT_ACCEPTED);
      }

      // Checked inside the transaction, so an admin deactivating a city while
      // this runs cannot be beaten by a request that read the catalog earlier.
      const location = await this.catalog.resolveLocation(input.cityId, input.districtId, tx);
      const interestIds = await this.catalog.assertInterestsSelectable(input.interestIds, tx);

      const existing = await tx.userProfile.findUnique({
        where: { userId },
        select: { completedAt: true },
      });
      // Never moved once set: a later edit is an edit, not a second completion.
      const completedAt = existing?.completedAt ?? now;

      const data = {
        displayName: input.displayName,
        gender: input.gender ?? null,
        birthYear: input.birthYear,
        cityId: location.cityId,
        districtId: location.districtId,
        bio: input.bio ?? null,
        completedAt,
      };
      await tx.userProfile.upsert({
        where: { userId },
        create: { userId, ...data },
        update: data,
      });

      // Drop-then-add rather than delete-all-then-insert. Deleting only what is
      // no longer wanted, and inserting with ON CONFLICT DO NOTHING, means two
      // concurrent calls with the same selection cannot collide on the primary
      // key — which delete-all-then-insert does, aborting the loser's whole
      // transaction and with it the profile write.
      await tx.userInterest.deleteMany({ where: { userId, interestId: { notIn: interestIds } } });
      await tx.userInterest.createMany({
        data: interestIds.map((interestId) => ({ userId, interestId })),
        skipDuplicates: true,
      });

      if (previousState !== 'PROFILE_COMPLETE') {
        await tx.user.update({
          where: { id: userId },
          data: { onboardingState: 'PROFILE_COMPLETE' },
        });
      }

      // Joins this transaction: the reward commits with the profile that earned
      // it, or neither does.
      const movement = await this.coins.apply(
        {
          userId,
          amount: rewardCoins,
          type: 'ONBOARDING_REWARD',
          reasonCode: ONBOARDING_REWARD_REASON,
          idempotencyKey: onboardingRewardKey(userId),
          actorType: 'SYSTEM',
          refType: 'user_profile',
          refId: userId,
        },
        tx,
      );

      /**
       * The first thing that ever moves a reputation (plan §11: +5).
       *
       * Same key discipline as the coins, and the same transaction: a profile
       * that commits without its trust movement is a user whose score never
       * catches up, and there is no later event that would notice. It also seeds
       * the score, so most users' trust ledger opens with the starting fifty and
       * this five, which is exactly the history the admin panel should show.
       */
      const trust = await this.trust.apply(
        {
          userId,
          delta: trustDelta,
          type: 'PROFILE_COMPLETE',
          reasonCode: TRUST_PROFILE_COMPLETE_REASON,
          idempotencyKey: profileTrustKey(userId),
          actorType: 'SYSTEM',
          refType: 'user_profile',
          refId: userId,
        },
        tx,
      );

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: previousState === 'PROFILE_COMPLETE' ? 'profile.updated' : 'profile.completed',
          targetType: 'user_profile',
          targetId: userId,
          before: { onboardingState: previousState },
          // Deliberately no display name or bio: `audit_log` records that a
          // change happened, not a copy of the content (ADR-0009).
          after: {
            onboardingState: 'PROFILE_COMPLETE',
            cityId: location.cityId,
            districtId: location.districtId,
            interestCount: interestIds.length,
            rewardGranted: movement.applied,
            trustScore: trust.score,
          },
        },
        tx,
      );

      return {
        balance: movement.balance,
        rewardGranted: movement.applied,
        trustScore: trust.score,
      };
    });

    const profile = await this.find(userId);
    if (!profile) {
      // Unreachable: the transaction above committed one.
      throw new AppError(ErrorCode.INTERNAL_ERROR);
    }

    return {
      profile,
      onboardingState: 'PROFILE_COMPLETE',
      balance: result.balance,
      rewardGranted: result.rewardGranted,
      trustScore: result.trustScore,
    };
  }
}
