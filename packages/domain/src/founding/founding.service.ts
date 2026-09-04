import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';

/** The reason code written to the ledger. Stable: the admin panel renders it. */
export const FOUNDING_REWARD_REASON = 'founding.member_reward';

/**
 * The ledger's exactly-once key for a user's founding grant.
 *
 * A function rather than a template at the call site, for the reason
 * `onboardingRewardKey` is one: this string *is* the guarantee, and two call
 * sites that formatted it differently would grant twice with nothing downstream
 * able to tell they meant the same thing.
 */
export function foundingRewardKey(userId: string): string {
  return `founding:${userId}`;
}

/** What a member was actually given. Every field is snapshotted on the row. */
export interface FoundingAward {
  rank: number;
  tier: number;
  coins: number;
}

/** The public counter, for the channel post and the bot's read-only screen. */
export interface FoundingProgress {
  awarded: number;
  max: number;
}

/** One row of `founding_campaign`, as the conditional UPDATE returns it. */
interface AllocatedRank {
  rank: number;
}

/** The six numbers the tier lookup is arithmetic over. */
const TIER_KEYS = [
  'founding.tier1_max_rank',
  'founding.tier1_coins',
  'founding.tier2_max_rank',
  'founding.tier2_coins',
  'founding.tier3_max_rank',
  'founding.tier3_coins',
] as const;

/**
 * The launch campaign: the first N members, ranked (v0.9.0).
 *
 * ── What this is, and what it deliberately is not ───────────────────────────
 *
 * A rank is allocated **inside the transaction that completes a profile**, next
 * to the fifty onboarding coins and the +5 trust movement that already happen
 * there. It is not a `gift_code` with `max_redemptions = 1000`, which is the
 * obvious implementation and would have needed no migration at all: with a code,
 * "member #427" means "the 427th person who typed a string", and a number that
 * sits on a profile for months and gets published to a channel cannot be a count
 * of who found and typed a code.
 *
 * ── The allocator ───────────────────────────────────────────────────────────
 *
 * One conditional `UPDATE … RETURNING`, no retry loop. Gap-free because a
 * rolled-back transaction returns its number, which a Postgres sequence would
 * not — and a gap is visible to users here, not just to the database.
 *
 * ── Lock ordering, which callers must preserve ──────────────────────────────
 *
 * `founding_campaign → coin_account`, which is the shape of both pairs the
 * product already has (`event → coin_account` and `gift_code → coin_account`):
 * the resource row first, the coin account second, never the reverse (ADR-0006).
 * `ProfileService` takes the `user` row before either, so the full order on that
 * path is `user → founding_campaign → coin_account`.
 *
 * The counter row's lock is then held for the remainder of the caller's
 * transaction, so concurrent profile completions serialise on it. That is an
 * accepted cost at this scale — the campaign is a four-figure number of users
 * over weeks — and it is the first thing to measure if profile completion ever
 * becomes a hot path.
 */
@Injectable()
export class FoundingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
  ) {}

  /**
   * Allocates at most one rank for this user, and pays the tier's grant.
   *
   * Returns `null` when the campaign is switched off, when it is full, or when
   * this user already has a rank — three different facts that are one answer to
   * the caller: there is nothing to announce.
   *
   * **Must be called inside a transaction.** The rank and the coins have to
   * commit together, and the caller's own writes have to roll back with them —
   * a member row for a profile that failed to save would be a rank nobody can
   * account for.
   */
  async award(userId: string, tx: Prisma.TransactionClient): Promise<FoundingAward | null> {
    /**
     * The kill switch, before the counter is touched.
     *
     * First, so that switching the campaign off costs one settings read and
     * takes no lock at all — the same ordering `GiftCodeService` uses for
     * `giftcode.enabled`, and for the same reason: the cheapest possible answer
     * on the path that is about to become the common one.
     */
    if ((await this.settings.getInt('founding.enabled', tx)) === 0) return null;

    /**
     * Already a member.
     *
     * Checked before allocating rather than after, because a rank taken from the
     * counter and then discarded is a permanent gap. The PRIMARY KEY on
     * `user_id` is still the real guarantee — this read only stops the common
     * case from burning a number, and cannot be relied on to stop a racing one.
     */
    const existing = await tx.foundingMember.findUnique({
      where: { userId },
      select: { rank: true, tier: true, coins: true },
    });
    if (existing) return null;

    /**
     * The allocation, and the lock.
     *
     * `WHERE next_rank <= max_rank` is what makes the cap a count rather than a
     * race: every concurrent completion serialises on this row, so ten
     * transactions competing for the last slot produce one winner and nine rows
     * that come back empty. Reading the counter and then updating it would let
     * all ten see the same free slot.
     */
    const allocated = await tx.$queryRaw<AllocatedRank[]>`
      UPDATE "founding_campaign"
         SET "next_rank" = "next_rank" + 1
       WHERE "id" = 1 AND "next_rank" <= "max_rank"
      RETURNING "next_rank" - 1 AS "rank"
    `;
    const row = allocated[0];
    // The campaign is full, or the singleton is missing. Both mean the same
    // thing to the caller, and neither is an error: the user completed their
    // profile and everything else about that succeeded.
    if (!row) return null;
    const rank = row.rank;

    const tiers = await this.settings.getNumbers(TIER_KEYS, tx);
    const { tier, coins } = tierFor(rank, tiers);

    /**
     * The coins, and the row that records them, in that order so the member row
     * can point at the ledger row that paid it.
     *
     * `apply` joins this transaction, which is what makes "the balance moved"
     * and "the member exists" one fact rather than two. A zero grant writes no
     * ledger row — `CoinService` skips the write at zero, so a free tier leaves
     * no row claiming somebody was paid nothing — and `coin_ledger_id` is
     * nullable for exactly that case.
     */
    let coinLedgerId: string | null = null;
    if (coins > 0) {
      const movement = await this.coins.apply(
        {
          userId,
          amount: coins,
          type: 'FOUNDING_REWARD',
          reasonCode: FOUNDING_REWARD_REASON,
          idempotencyKey: foundingRewardKey(userId),
          actorType: 'SYSTEM',
          refType: 'founding_member',
          refId: userId,
          metadata: { rank, tier },
        },
        tx,
      );
      coinLedgerId = movement.ledgerId;
    }

    /**
     * No `catch` on the unique violation, deliberately, and it is the one place
     * in this file where the difference matters.
     *
     * `GiftCodeService` swallows its unique violation into a refusal because a
     * second redemption is a user error with a sensible answer. Here it would be
     * an allocator bug, and the rank just taken from the counter is only
     * returned if this transaction aborts. Letting it propagate is what keeps
     * the numbering gap-free; catching it would trade a loud failure for a
     * permanent hole in a sequence that users can see.
     */
    await tx.foundingMember.create({
      data: { userId, rank, tier, coins, coinLedgerId },
    });

    return { rank, tier, coins };
  }

  /**
   * How many ranks have been handed out, and the cap.
   *
   * No lock and no transaction: this feeds a channel post and a read-only
   * screen, where a count that is one behind for a moment is not wrong in any
   * way a reader could notice.
   */
  async progress(tx: Prisma.TransactionClient = this.prisma): Promise<FoundingProgress> {
    const campaign = await tx.foundingCampaign.findUnique({
      where: { id: 1 },
      select: { nextRank: true, maxRank: true },
    });
    if (!campaign) return { awarded: 0, max: 0 };
    return { awarded: campaign.nextRank - 1, max: campaign.maxRank };
  }

  /** This user's rank, or null. The profile screen's read. */
  async memberOf(
    userId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<FoundingAward | null> {
    const row = await tx.foundingMember.findUnique({
      where: { userId },
      select: { rank: true, tier: true, coins: true },
    });
    return row ?? null;
  }
}

/**
 * Which tier a rank falls in, and what it pays.
 *
 * Pure and exported so the boundaries can be tested without a database — the
 * interesting cases are 100/101 and 400/401, and neither needs a transaction to
 * be wrong.
 *
 * A rank past the last boundary gets the **last tier** rather than no tier. The
 * cap normally makes that unreachable, but `founding.tier3_max_rank` and
 * `founding_campaign.max_rank` are two numbers that can drift apart, and the
 * failure mode of drift should be a mislabelled member rather than one who was
 * allocated a rank and then handed nothing.
 */
export function tierFor(
  rank: number,
  tiers: Record<(typeof TIER_KEYS)[number], number>,
): { tier: number; coins: number } {
  if (rank <= tiers['founding.tier1_max_rank']) {
    return { tier: 1, coins: tiers['founding.tier1_coins'] };
  }
  if (rank <= tiers['founding.tier2_max_rank']) {
    return { tier: 2, coins: tiers['founding.tier2_coins'] };
  }
  return { tier: 3, coins: tiers['founding.tier3_coins'] };
}
