import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Gender, OnboardingState } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import type { Env } from '@payetam/config';
import { AppError, ErrorCode } from '@payetam/shared';
import { CatalogService, type CityLaunchStatus, type NamedRef } from '../catalog/catalog.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { TRUST_PROFILE_COMPLETE_REASON, TrustService } from '../economy/trust.service';
import { FoundingService, type FoundingAward } from '../founding/founding.service';
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

/**
 * A partial edit of a profile that already exists (M22 phase 2).
 *
 * Every field is `T | undefined` and three of them are `T | null | undefined`,
 * spelled out rather than `Partial<…>` because the workspace runs
 * `exactOptionalPropertyTypes`: under that flag `bio?: string | null` accepts an
 * absent key and rejects an explicit `bio: undefined`, and a Zod-parsed body
 * hands over exactly the latter.
 *
 * The three-way distinction is the contract: **absent** leaves the column alone,
 * **null** clears it, and a value sets it.
 */
export interface UpdateProfileInput {
  displayName?: string | undefined;
  gender?: Gender | null | undefined;
  birthYear?: number | undefined;
  cityId?: string | undefined;
  districtId?: string | null | undefined;
  bio?: string | null | undefined;
  interestIds?: string[] | undefined;
  inviteOptOut?: boolean | undefined;
}

/**
 * Who is making the edit.
 *
 * The domain method is one method for both, because a validation rule that holds
 * for a user and not for staff is a rule somebody will find the other way round.
 * What differs is only the audit row — and that difference is exactly what this
 * discriminant exists to record.
 */
export type ProfileEditor =
  { kind: 'USER' } | { kind: 'ADMIN'; adminUserId: string; reason: string };

export interface ProfileDetail {
  displayName: string;
  gender: Gender | null;
  birthYear: number | null;
  city: NamedRef;
  district: NamedRef | null;
  bio: string | null;
  interests: NamedRef[];
  /** Whether this user has asked not to receive event invitations (M22). */
  inviteOptOut: boolean;
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
  /**
   * The launch-campaign rank, when this call allocated one (v0.9.0).
   *
   * Null for the overwhelming majority of calls — every completion after the
   * campaign fills, every one while it is switched off, and every re-edit of a
   * profile that was already complete. The adapter renders a line only when this
   * is set, so "nothing to announce" needs no separate flag.
   */
  founding: FoundingAward | null;
  /**
   * Where their city stands, when the product does not run there yet (v0.10.0).
   *
   * Null for the two open cities, which is the common case and needs no line on
   * the screen. Present for everybody else, and the reason completing a profile
   * in a closed city is allowed at all: it is what turns «شهر شما باز نیست» from
   * a dead end into a queue with a number on it.
   */
  cityLaunch: CityLaunchStatus | null;
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
    private readonly founding: FoundingService,
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
      inviteOptOut: profile.inviteOptOut,
      completedAt: profile.completedAt,
    };
  }

  /**
   * Applies a partial edit to a profile that already exists (M22 phase 2).
   *
   * Separate from `complete` rather than folded into it, and the separation is
   * the point. `complete` is an onboarding step: it takes a whole profile,
   * advances `onboarding_state`, grants coins and moves the Trust Score. None of
   * that may happen again when somebody fixes a typo in their bio — and the way
   * to guarantee it does not is for the edit path to have no code that could.
   *
   * ── The rules it does keep ──────────────────────────────────────────────────
   *
   * **Age is re-checked whenever a birth year is sent**, on the server clock, by
   * the same `isOldEnough` the onboarding path uses (invariant 9). Editing your
   * way under eighteen has to be as impossible as signing up under eighteen.
   *
   * **The city and the district are resolved together, always.** A district only
   * means something inside its city, so sending a new city without a district
   * clears the district rather than leaving one that now belongs somewhere else.
   * Sending a district alone resolves it against the city already stored.
   *
   * **`completed_at` and `onboarding_state` are never touched.** A later edit is
   * an edit, not a second completion — which is what the column's own comment has
   * said since M3 and what nothing enforced until now.
   *
   * One transaction, so a partial write cannot leave a profile whose interests
   * belong to the edit and whose city does not.
   */
  async update(
    userId: string,
    input: UpdateProfileInput,
    editor: ProfileEditor = { kind: 'USER' },
  ): Promise<ProfileDetail> {
    const now = this.clock.now();

    // Before the transaction, and only when a year was actually sent: refusing
    // an under-age edit should not depend on having taken a lock first, and the
    // overwhelming majority of edits do not touch the year at all.
    if (input.birthYear !== undefined) {
      const minAge = await this.settings.getInt('profile.min_age_years');
      if (!isOldEnough(input.birthYear, minAge, now, this.env.APP_TIMEZONE)) {
        throw new AppError(ErrorCode.AGE_BELOW_MINIMUM);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userProfile.findUnique({
        where: { userId },
        select: {
          displayName: true,
          gender: true,
          birthYear: true,
          cityId: true,
          districtId: true,
          bio: true,
          inviteOptOut: true,
        },
      });
      // Editing something that was never created is not an edit. The Mini App
      // routes an unfinished user to onboarding; this is the same refusal for
      // anybody who reaches the endpoint another way.
      if (!existing) throw new AppError(ErrorCode.PROFILE_INCOMPLETE);

      const data: {
        displayName?: string;
        gender?: Gender | null;
        birthYear?: number;
        cityId?: string;
        districtId?: string | null;
        bio?: string | null;
        inviteOptOut?: boolean;
      } = {};

      if (input.displayName !== undefined) data.displayName = input.displayName;
      if (input.gender !== undefined) data.gender = input.gender;
      if (input.birthYear !== undefined) data.birthYear = input.birthYear;
      if (input.bio !== undefined) data.bio = input.bio;
      if (input.inviteOptOut !== undefined) data.inviteOptOut = input.inviteOptOut;

      /**
       * The city/district pair, resolved as a pair.
       *
       * Checked inside the transaction against the live catalog, so an admin
       * deactivating a city while this runs cannot be beaten by a request that
       * read the catalog five minutes ago — the same reason `complete` resolves
       * here rather than at the edge.
       */
      if (input.cityId !== undefined || input.districtId !== undefined) {
        const cityId = input.cityId ?? existing.cityId;
        // A new city with no district named clears the old one: a district that
        // belongs to the city somebody just left is not a place they are.
        const districtId =
          input.districtId !== undefined
            ? input.districtId
            : input.cityId !== undefined && input.cityId !== existing.cityId
              ? null
              : existing.districtId;

        const location = await this.catalog.resolveLocation(cityId, districtId ?? undefined, tx);
        data.cityId = location.cityId;
        data.districtId = location.districtId;
      }

      if (Object.keys(data).length > 0) {
        await tx.userProfile.update({ where: { userId }, data });
      }

      let interestIds: string[] | null = null;
      if (input.interestIds !== undefined) {
        interestIds = await this.catalog.assertInterestsSelectable(input.interestIds, tx);
        // Drop-then-add, exactly as `complete` does it and for the same reason:
        // delete-all-then-insert makes two concurrent identical edits collide on
        // the primary key and abort the loser's whole transaction.
        await tx.userInterest.deleteMany({ where: { userId, interestId: { notIn: interestIds } } });
        await tx.userInterest.createMany({
          data: interestIds.map((interestId) => ({ userId, interestId })),
          skipDuplicates: true,
        });
      }

      /**
       * What the audit row says, and what it deliberately does not.
       *
       * A user editing their own profile gets **field names only** — that is the
       * discipline `complete` already follows, and ADR-0009's reason holds: the
       * trail records that a change happened, not a second copy of the content.
       *
       * An **admin** editing somebody else's profile gets old and new values for
       * the fields a support conversation is about, because an unexplained change
       * to another person's record is not reviewable later. The bio is the one
       * exception on both sides: it is free text a user wrote, `user.read` already
       * masks it for staff, and copying it verbatim into a table staff export
       * would put it somewhere the masking does not reach. Its lengths go in
       * instead, which is enough to see that something was removed.
       */
      const changed = fieldsChanged(existing, data, interestIds);

      await this.audit.record(
        {
          actorType: editor.kind === 'ADMIN' ? 'ADMIN' : 'USER',
          actorId: editor.kind === 'ADMIN' ? editor.adminUserId : userId,
          action: editor.kind === 'ADMIN' ? 'admin.profile.updated' : 'profile.updated',
          targetType: 'user_profile',
          targetId: userId,
          ...(editor.kind === 'ADMIN'
            ? {
                before: valueSnapshot(existing),
                after: {
                  ...valueSnapshot({ ...existing, ...data }),
                  reason: editor.reason,
                  changedFields: changed,
                },
              }
            : { after: { changedFields: changed } }),
        },
        tx,
      );
    });

    const profile = await this.find(userId);
    // Unreachable: the transaction above refused when there was none.
    if (!profile) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return profile;
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

      let founding: FoundingAward | null = null;
      if (previousState !== 'PROFILE_COMPLETE') {
        await tx.user.update({
          where: { id: userId },
          data: { onboardingState: 'PROFILE_COMPLETE' },
        });

        /**
         * The launch campaign's rank (v0.9.0).
         *
         * **Before** the coin movements below, and that ordering is load-bearing
         * rather than stylistic: `award` takes `founding_campaign` and then
         * `coin_account`, so running it after this method had already taken
         * `coin_account` would invert the pair and hand the product its first
         * deadlock-shaped lock cycle (ADR-0006). The full order on this path is
         * `user → founding_campaign → coin_account`.
         *
         * **Only on a genuine first completion**, which is why it sits inside
         * this branch rather than relying on `award`'s own idempotency. Users who
         * were already `PROFILE_COMPLETE` when the campaign shipped are not
         * ranked by editing their bio: that would hand the first hundred slots to
         * whoever happened to open the profile screen in the week after a deploy,
         * which is a lottery rather than a launch campaign. Granting them ranks is
         * a deliberate backfill ordered by `user_profile.completed_at`, not a
         * side effect of an edit.
         */
        founding = await this.founding.award(userId, tx);
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
            // Extends the existing row rather than writing a second one: one
            // action, one entry. The rank is a fact about this completion, not
            // an event of its own, and a `founding.awarded` row would make the
            // trail claim two things happened where a user did one.
            foundingRank: founding?.rank ?? null,
            foundingTier: founding?.tier ?? null,
          },
        },
        tx,
      );

      return {
        balance: movement.balance,
        rewardGranted: movement.applied,
        trustScore: trust.score,
        founding,
      };
    });

    const profile = await this.find(userId);
    if (!profile) {
      // Unreachable: the transaction above committed one.
      throw new AppError(ErrorCode.INTERNAL_ERROR);
    }

    /**
     * Read **after** the transaction, deliberately.
     *
     * The count has to include the profile that was just written, and nothing
     * about it is enforced on — so putting it inside would lengthen a
     * transaction that already holds the user row, the campaign counter and the
     * coin account, to compute a number for a sentence.
     */
    const launch = await this.catalog.launchStatus(profile.city.id);

    return {
      profile,
      onboardingState: 'PROFILE_COMPLETE',
      balance: result.balance,
      rewardGranted: result.rewardGranted,
      trustScore: result.trustScore,
      founding: result.founding,
      cityLaunch: launch !== null && !launch.launched ? launch : null,
    };
  }
}

/**
 * Which fields this edit actually moved.
 *
 * Compared rather than assumed, so "changed the display name" is not recorded for
 * a request that sent the same display name back. An audit trail full of edits
 * that changed nothing is one nobody reads.
 */
function fieldsChanged(
  before: Record<string, unknown>,
  data: Record<string, unknown>,
  interestIds: string[] | null,
): string[] {
  const changed = Object.keys(data).filter((key) => before[key] !== data[key]);
  if (interestIds !== null) changed.push('interestIds');
  return changed;
}

/**
 * The allowlisted before/after an admin edit records.
 *
 * An allowlist rather than a spread, like every other audit shape in this
 * codebase: `before`/`after` are a read surface staff export, and "it happened to
 * be safe when I wrote it" does not survive somebody adding a column.
 *
 * The bio is a **length**, never the text. See the note at the call site.
 */
function valueSnapshot(row: Record<string, unknown>): Record<string, string | number | null> {
  const bio = row['bio'];
  return {
    displayName: typeof row['displayName'] === 'string' ? row['displayName'] : null,
    gender: typeof row['gender'] === 'string' ? row['gender'] : null,
    birthYear: typeof row['birthYear'] === 'number' ? row['birthYear'] : null,
    cityId: typeof row['cityId'] === 'string' ? row['cityId'] : null,
    districtId: typeof row['districtId'] === 'string' ? row['districtId'] : null,
    bioLength: typeof bio === 'string' ? bio.length : 0,
  };
}
