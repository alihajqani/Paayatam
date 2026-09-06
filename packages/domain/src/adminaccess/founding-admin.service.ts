import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { SettingsService } from '../catalog/settings.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** One wave, with what it is configured to pay beside what it actually paid. */
export interface FoundingTierRollup {
  tier: number;
  maxRank: number;
  configuredCoins: number;
  members: number;
  coins: number;
}

/** One city, counted twice: founding members, and every completed profile. */
export interface FoundingCityRollup {
  slug: string;
  nameFa: string;
  isLaunched: boolean;
  members: number;
  profiles: number;
}

export interface FoundingReport {
  enabled: boolean;
  awarded: number;
  max: number;
  remaining: number;
  coinsGranted: number;
  firstAwardedAt: Date | null;
  lastAwardedAt: Date | null;
  joinedLast24h: number;
  joinedLast7Days: number;
  tiers: FoundingTierRollup[];
  trend: Array<{ day: string; members: number; coins: number }>;
  cities: FoundingCityRollup[];
  sources: { referred: number; giftCode: number; direct: number };
  waitlist: {
    threshold: number;
    cities: Array<{ slug: string; nameFa: string; profiles: number }>;
  };
}

export interface FoundingMemberRow {
  rank: number;
  tier: number;
  coins: number;
  awardedAt: Date;
  publicId: string;
  displayName: string | null;
  cityNameFa: string | null;
}

export interface FoundingMemberPage {
  rows: FoundingMemberRow[];
  total: number;
}

/** The three waves the settings describe, in the order `tierFor` reads them. */
const TIER_KEYS = [
  'founding.enabled',
  'founding.tier1_max_rank',
  'founding.tier1_coins',
  'founding.tier2_max_rank',
  'founding.tier2_coins',
  'founding.tier3_max_rank',
  'founding.tier3_coins',
  'city.launch_threshold',
] as const;

/** Days of history the trend carries. Bounded, like every other list here. */
const TREND_DAYS = 90;

const DEFAULT_MEMBER_LIMIT = 50;

/**
 * The launch campaign, as the panel reads it (v0.10.1).
 *
 * ── Why this is its own service, and why it is read-only ────────────────────
 *
 * `FoundingService` allocates ranks and is called from inside a profile
 * completion's transaction; nothing here does. This is the reporting side, and
 * keeping it apart means the allocator has no admin-shaped methods on it that a
 * future caller could reach for from the wrong place.
 *
 * **Nothing here writes.** The campaign has exactly one lever — `founding.enabled`
 * in `app_setting` — and the settings screen already owns it. A second control
 * would be a second write path to one number, with a second audit shape and a
 * second set of validation; the panel reports the switch's position and links to
 * where it is thrown. That is also why invariant 12 has nothing to say about this
 * file: it governs *mutating* admin actions, and there are none.
 *
 * ── Two permissions, because they are two disclosures ───────────────────────
 *
 * `report()` is aggregates and sits behind `dashboard.read`, which is what
 * ADR-0010 gives `ANALYST` and precisely what "read-only aggregates" means.
 * `members()` names people and sits behind `user.read`. "How many joined" and
 * "who are they" are different questions and an analyst is entitled to the first
 * only.
 *
 * ── Every number comes from a durable row ───────────────────────────────────
 *
 * Counts and coins are read from `founding_member`, whose `tier` and `coins` are
 * **snapshotted at allocation**. They are deliberately not recomputed from
 * today's tier boundaries: those are runtime settings, an operator may retune
 * them mid campaign, and a report that recomputed would describe a schedule
 * nobody was ever paid on. The configured numbers appear beside the actual ones
 * so a disagreement is visible rather than hidden.
 */
@Injectable()
export class FoundingAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The whole campaign in one round of parallel aggregates.
   *
   * One request, for the reason the dashboard is one request: a screen that
   * fetched a count per card would be a page of round trips and the first thing
   * to get slow. Nothing here is per-row.
   */
  async report(session: AdminSession): Promise<FoundingReport> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const now = this.clock.now();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

    const [campaign, config, totals, byTier, last24h, last7Days, trend, places, sources] =
      await Promise.all([
        this.prisma.foundingCampaign.findUnique({
          where: { id: 1 },
          select: { nextRank: true, maxRank: true },
        }),
        this.settings.getNumbers(TIER_KEYS),
        this.prisma.foundingMember.aggregate({
          _sum: { coins: true },
          _min: { awardedAt: true },
          _max: { awardedAt: true },
        }),
        this.prisma.foundingMember.groupBy({
          by: ['tier'],
          _count: { _all: true },
          _sum: { coins: true },
        }),
        this.prisma.foundingMember.count({ where: { awardedAt: { gte: dayAgo } } }),
        this.prisma.foundingMember.count({ where: { awardedAt: { gte: weekAgo } } }),
        /**
         * The daily curve. Raw SQL because the grouping key is a date
         * truncation and Prisma's `groupBy` cannot express one.
         *
         * Newest first with a `LIMIT`, then reversed below — the alternative,
         * a `WHERE awarded_at >= <90 days ago>`, returns nothing at all for a
         * campaign that finished three months ago, which is exactly when
         * somebody is reading the report to see how it went.
         */
        this.prisma.$queryRaw<Array<{ day: Date; members: bigint; coins: bigint | null }>>`
          SELECT date_trunc('day', "awarded_at") AS day,
                 COUNT(*)     AS members,
                 SUM("coins") AS coins
          FROM "founding_member"
          GROUP BY 1
          ORDER BY 1 DESC
          LIMIT ${TREND_DAYS}
        `,
        /**
         * Where everybody is, in one pass over the profiles.
         *
         * `LEFT JOIN` rather than two queries, because the two questions this
         * screen asks about a city — "how many members came from here" and "how
         * many people are waiting here" — are the same scan with a different
         * filter, and the second is the denominator of the first. The join
         * cannot multiply rows: `founding_member.user_id` is its PRIMARY KEY.
         *
         * A full aggregate over `user_profile`. That is right at a four-figure
         * user count and is the first thing to index if it stops being.
         */
        this.prisma.$queryRaw<
          Array<{
            slug: string;
            name_fa: string;
            is_launched: boolean;
            members: bigint;
            profiles: bigint;
          }>
        >`
          SELECT c."slug",
                 c."name_fa",
                 c."is_launched",
                 COUNT(*) FILTER (WHERE fm."user_id" IS NOT NULL) AS members,
                 COUNT(*)                                          AS profiles
          FROM "user_profile" p
          JOIN "city" c ON c."id" = p."city_id"
          LEFT JOIN "founding_member" fm ON fm."user_id" = p."user_id"
          GROUP BY c."slug", c."name_fa", c."is_launched"
        `,
        this.acquisitionSources(),
      ]);

    const awarded = campaign === null ? 0 : campaign.nextRank - 1;
    const max = campaign?.maxRank ?? 0;

    const counted = new Map(
      byTier.map((row) => [row.tier, { members: row._count._all, coins: row._sum.coins ?? 0 }]),
    );

    const cities = places
      .map((row) => ({
        slug: row.slug,
        nameFa: row.name_fa,
        isLaunched: row.is_launched,
        members: Number(row.members),
        profiles: Number(row.profiles),
      }))
      .sort((a, b) => b.members - a.members || b.profiles - a.profiles);

    return {
      enabled: config['founding.enabled'] !== 0,
      awarded,
      max,
      // Floored, because `max_rank` and the tier boundaries are two numbers an
      // operator can move apart. A negative "remaining" is a configuration
      // story, not a count, and belongs nowhere on a report.
      remaining: Math.max(0, max - awarded),
      coinsGranted: totals._sum.coins ?? 0,
      firstAwardedAt: totals._min.awardedAt,
      lastAwardedAt: totals._max.awardedAt,
      joinedLast24h: last24h,
      joinedLast7Days: last7Days,
      tiers: this.rollUpTiers(config, counted),
      trend: [...trend].reverse().map((bucket) => ({
        day: bucket.day.toISOString().slice(0, 10),
        members: Number(bucket.members),
        coins: Number(bucket.coins ?? 0n),
      })),
      cities: cities.filter((row) => row.members > 0),
      sources,
      waitlist: {
        threshold: config['city.launch_threshold'],
        cities: cities
          .filter((row) => !row.isLaunched && row.profiles > 0)
          .sort((a, b) => b.profiles - a.profiles)
          .map((row) => ({ slug: row.slug, nameFa: row.nameFa, profiles: row.profiles })),
      },
    };
  }

  /**
   * The roster, by rank.
   *
   * `user.read`, not `dashboard.read`: this one names people. Bounded and
   * reporting its total, like every other admin list.
   *
   * Ascending by rank rather than newest-first, because the question somebody
   * opens this to answer is "who are the first hundred?" and the answer to that
   * starts at one.
   */
  async members(
    session: AdminSession,
    filters: { tier?: number; limit?: number; offset?: number } = {},
  ): Promise<FoundingMemberPage> {
    this.access.assertPermission(session, PERMISSIONS.USER_READ);

    const where = filters.tier === undefined ? {} : { tier: filters.tier };
    const take = filters.limit ?? DEFAULT_MEMBER_LIMIT;
    const skip = filters.offset ?? 0;

    const [rows, total] = await Promise.all([
      this.prisma.foundingMember.findMany({
        where,
        orderBy: { rank: 'asc' },
        take,
        skip,
        /**
         * An explicit `select` all the way down, never an `include`.
         *
         * `founding_member.user_id` is the **internal** id and it does not leave
         * the backend (invariant 7); `publicId` is what the panel links on. The
         * user's relations reach `telegram_account`, and a spread here is how
         * that ends up in a response.
         */
        select: {
          rank: true,
          tier: true,
          coins: true,
          awardedAt: true,
          user: {
            select: {
              publicId: true,
              profile: { select: { displayName: true, city: { select: { nameFa: true } } } },
            },
          },
        },
      }),
      this.prisma.foundingMember.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        rank: row.rank,
        tier: row.tier,
        coins: row.coins,
        awardedAt: row.awardedAt,
        publicId: row.user.publicId,
        displayName: row.user.profile?.displayName ?? null,
        cityNameFa: row.user.profile?.city.nameFa ?? null,
      })),
      total,
    };
  }

  /**
   * How the members reached the product.
   *
   * **Three independent counts, not a partition.** One person can both arrive on
   * a referral code and later redeem a gift code, so the first two overlap and
   * do not sum to the total; `direct` is "neither", which is the only one of the
   * three that is a complement of anything. Reporting them as slices of a whole
   * would be a lie with arithmetic on top.
   *
   * `giftCode` is honestly labelled on the screen: redeeming a code is not by
   * itself an acquisition channel — it can happen months after signing up — and
   * it is here because the campaign is the thing gift codes are being minted
   * for, so "did the codes reach the founders?" is a question worth answering.
   */
  private async acquisitionSources(): Promise<{
    referred: number;
    giftCode: number;
    direct: number;
  }> {
    const [referred, giftCode, direct] = await Promise.all([
      this.prisma.foundingMember.count({
        where: { user: { referralReceived: { isNot: null } } },
      }),
      this.prisma.foundingMember.count({
        where: { user: { giftCodeRedemptions: { some: {} } } },
      }),
      this.prisma.foundingMember.count({
        where: {
          user: { referralReceived: { is: null }, giftCodeRedemptions: { none: {} } },
        },
      }),
    ]);
    return { referred, giftCode, direct };
  }

  /**
   * The configured waves, with the snapshotted counts merged in.
   *
   * A tier the snapshot holds and the configuration does not still appears, with
   * zeroes for its boundaries. That is the same reasoning `tierFor` uses for a
   * rank past the last boundary: the two numbers can drift, and the failure mode
   * of drift should be a visible oddity on a report rather than members quietly
   * missing from the totals.
   */
  private rollUpTiers(
    config: Record<(typeof TIER_KEYS)[number], number>,
    counted: Map<number, { members: number; coins: number }>,
  ): FoundingTierRollup[] {
    const configured: FoundingTierRollup[] = [
      {
        tier: 1,
        maxRank: config['founding.tier1_max_rank'],
        configuredCoins: config['founding.tier1_coins'],
        members: 0,
        coins: 0,
      },
      {
        tier: 2,
        maxRank: config['founding.tier2_max_rank'],
        configuredCoins: config['founding.tier2_coins'],
        members: 0,
        coins: 0,
      },
      {
        tier: 3,
        maxRank: config['founding.tier3_max_rank'],
        configuredCoins: config['founding.tier3_coins'],
        members: 0,
        coins: 0,
      },
    ];

    for (const row of configured) {
      const actual = counted.get(row.tier);
      if (actual !== undefined) {
        row.members = actual.members;
        row.coins = actual.coins;
      }
      counted.delete(row.tier);
    }

    for (const [tier, actual] of [...counted.entries()].sort((a, b) => a[0] - b[0])) {
      configured.push({ tier, maxRank: 0, configuredCoins: 0, ...actual });
    }

    return configured;
  }
}
