import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { SettingsService } from '../catalog/settings.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** How a metric is doing against its target. */
export type MetricStatus = 'good' | 'warn' | 'bad' | 'unknown';

/**
 * One number, with everything needed to read it without opening the plan.
 *
 * The three fields after `value` are what make this a *report* rather than a
 * dashboard tile. A screen that shows «۳۸٪» and nothing else asks the reader to
 * remember whether high is good — and for four of these seven, it is not.
 */
export interface EconomyMetric {
  key: string;
  /** Persian name. */
  label: string;
  /** Null when there is not enough data to compute it — never zero-as-unknown. */
  value: number | null;
  /** How to read `value`: a ratio in 0–1, a count, a number of days. */
  kind: 'ratio' | 'count' | 'days' | 'perDay' | 'coins';
  status: MetricStatus;
  /** The target, in words: «کمتر از ۳۵٪». */
  target: string;
  /** What this number is measuring, in one or two sentences. */
  meaning: string;
  /** What to do when it is bad. The half a dashboard usually leaves out. */
  advice: string;
  /** The denominator, so a ratio from four data points is not read as a trend. */
  sample: number;
}

export interface EconomyReport {
  /** The rolling window every metric is measured over. */
  windowDays: number;
  metrics: EconomyMetric[];
  /** Where the coins are, right now. */
  supply: {
    held: number;
    grantedFree: number;
    purchased: number;
    burned: number;
    refunded: number;
  };
  /** Sales, which are `ADMIN_ADJUSTMENT` rows whose reason begins `sale:`. */
  revenue: {
    coinsSold: number;
    transactions: number;
    /** At `economy.coin_reference_price_toman`, applied at read time. */
    toman: number;
    referencePrice: number;
  };
  /** What each source put into the economy in the window, largest first. */
  sources: Array<{ type: string; coins: number; entries: number }>;
  /** And what each sink took out. */
  sinks: Array<{ type: string; coins: number; entries: number }>;
}

/** One direction of one ledger type, over the window. `coins` is always positive. */
interface LedgerFlow {
  type: string;
  /** True for money into an account, false for money out of one. */
  credit: boolean;
  coins: number;
  entries: number;
}

/**
 * The window everything here is measured over.
 *
 * Thirty days, matching `economy.earning_cap_days` in spirit but deliberately
 * **not read from it**: that setting bounds what a user may earn, and an operator
 * who shortens it to tighten a cap must not thereby change what every metric on
 * this page means. A reporting window and a policy window are two different
 * things that happen to be the same length.
 */
const WINDOW_DAYS = 30;

/**
 * Coins that were **granted**, not bought.
 *
 * `ADMIN_ADJUSTMENT` is absent because it is both: a sale and a goodwill gift are
 * the same row type, told apart only by the `sale:` prefix on the reason. It is
 * split by that prefix below.
 */
const FREE_GRANT_TYPES = [
  'ONBOARDING_REWARD',
  'FOUNDING_REWARD',
  'REFERRAL_REWARD',
  'REVIEW_REWARD',
  'GIFT_CODE_REDEEM',
  'HOST_REWARD',
  'COMEBACK_GRANT',
] as const;

/** Coins that left the economy for something the user chose to buy. */
const SINK_TYPES = [
  'EVENT_CREATE_SPEND',
  'CHANNEL_POST_SPEND',
  'INVITE_SPEND',
  'EVENT_JOIN_SPEND',
  'BOOST_SPEND',
  'VIP_SPEND',
  'CANCELLATION_PENALTY',
  'NO_SHOW_PENALTY',
] as const;

/**
 * Coins that came **back** — a sink undone rather than a grant.
 *
 * Counted against the burn rather than as free coins, which is the one piece of
 * arithmetic on this page that is easy to get wrong and expensive to get wrong:
 * treating a host's returned deposit as a grant would make every successful host
 * look like a hole in the economy, and the leak rate — the single most important
 * number here — would rise every time the product worked.
 */
const REFUND_TYPES = ['EVENT_DEPOSIT_REFUND', 'HOST_CANCELLATION_REFUND', 'REVERSAL'] as const;

/**
 * The seven monthly metrics from docs/coin-economy-plan.md §12, computed live.
 *
 * ── Why the targets are constants here ──────────────────────────────────────
 *
 * Every other number in this product is in `app_setting` and this deliberately is
 * not. A target is not an operator's lever, it is the *claim the plan makes* —
 * and a threshold anybody can move is a threshold that gets moved to wherever the
 * current value happens to be, at which point the page always reads green and
 * measures nothing. Changing one of these should be a commit with a reason.
 *
 * ── Read-only, behind `dashboard.read` ─────────────────────────────────────
 *
 * Every number is an aggregate, which is exactly what ADR-0010 gives `ANALYST`.
 * Nothing here names a user: the closest it comes is "the largest amount one
 * account earned in thirty days", which is a number, not a person. Invariant 12
 * has nothing to say about this file because there is no mutating action in it.
 *
 * ── One round of parallel aggregates ───────────────────────────────────────
 *
 * A screen that fetched a metric per card would be seven round trips and the
 * first thing to get slow. Nothing here is per-row and every query is bounded by
 * the window.
 */
@Injectable()
export class EconomyReportService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly settings: SettingsService,
  ) {}

  async report(session: AdminSession): Promise<EconomyReport> {
    this.access.assertPermission(session, PERMISSIONS.DASHBOARD_READ);

    const now = this.clock.now();
    const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

    const [
      held,
      byType,
      adjustments,
      firstPurchase,
      attendedConversion,
      fillRate,
      topEarner,
      reviewRate,
      referencePrice,
    ] = await Promise.all([
      this.prisma.coinAccount.aggregate({ _sum: { balance: true } }),
      this.ledgerByType(since),
      this.adjustments(since),
      this.daysToFirstPurchase(),
      this.attendedToPurchase(),
      this.fillRate(since),
      this.topEarnerIn(since),
      this.reviewRate(since, now),
      this.settings.getInt('economy.coin_reference_price_toman'),
    ]);

    /** Coins moving in one direction, over a set of types. Always non-negative. */
    const sumOf = (types: readonly string[], credit: boolean): number =>
      byType
        .filter((row) => row.credit === credit && types.includes(row.type))
        .reduce((total, row) => total + row.coins, 0);

    const grantedFree = sumOf(FREE_GRANT_TYPES, true) + adjustments.giftCoins;
    const spent = sumOf(SINK_TYPES, false);
    // Credits only. A `REVERSAL` that claws a grant *back* is a debit and is
    // deliberately ignored rather than counted as burn — it is a grant undone,
    // not somebody spending, and counting it as burn would flatter the leak rate.
    const refunded = sumOf(REFUND_TYPES, true);
    // Net, not gross. A charge that was refunded never left the economy, and a
    // leak rate measured against gross spending flatters itself by exactly the
    // amount of money it gave back.
    const burned = Math.max(0, spent - refunded);

    return {
      windowDays: WINDOW_DAYS,
      metrics: [
        this.leakRate(grantedFree, burned),
        this.timeToFirstPurchase(firstPurchase),
        this.conversion(attendedConversion),
        this.fill(fillRate),
        this.topEarner(topEarner),
        this.manualTransactions(adjustments.saleCount),
        this.reviews(reviewRate),
      ],
      supply: {
        held: held._sum.balance ?? 0,
        grantedFree,
        purchased: adjustments.saleCoins,
        burned,
        refunded,
      },
      revenue: {
        coinsSold: adjustments.saleCoins,
        transactions: adjustments.saleCount,
        toman: adjustments.saleCoins * referencePrice,
        referencePrice,
      },
      // Credits and debits, each in its own list, so a type that does both —
      // `ADMIN_ADJUSTMENT`, `REVERSAL` — appears on both sides with its real
      // figures rather than once with a net that hides half of what happened.
      sources: byType
        .filter((row) => row.credit)
        .sort((a, b) => b.coins - a.coins)
        .map((row) => ({ type: row.type, coins: row.coins, entries: row.entries })),
      sinks: byType
        .filter((row) => !row.credit)
        .sort((a, b) => b.coins - a.coins)
        .map((row) => ({ type: row.type, coins: row.coins, entries: row.entries })),
    };
  }

  // ── The seven metrics ──────────────────────────────────────────────────────

  /**
   * **The single most important number on this page.**
   *
   * Free coins over net burn. Below the target the economy is a sink; above it,
   * a spring — and a spring is what the product had when joining cost five and
   * reviewing the same activity paid ten.
   */
  private leakRate(grantedFree: number, burned: number): EconomyMetric {
    const value = burned === 0 ? null : grantedFree / burned;
    return {
      key: 'leak_rate',
      label: 'نرخ نشت',
      value,
      kind: 'ratio',
      status: value === null ? 'unknown' : value < 0.35 ? 'good' : value < 0.5 ? 'warn' : 'bad',
      target: 'کمتر از ۳۵٪',
      meaning:
        'سکه‌ی رایگانی که وارد اقتصاد می‌شود، تقسیم بر سکه‌ای که واقعاً سوخته. ' +
        'تک‌عددی‌ترین شاخص سلامت اقتصاد: می‌گوید اقتصاد چاه است یا چشمه. ' +
        'بازگشت سپرده و بازگشت وجه از سوخت کم شده‌اند، نه اینکه رایگان شمرده شوند.',
      advice:
        'اگر بالای ۵۰٪ رفت، یکی از منابع اعطا سقف ندارد یا هدیه‌ها بزرگ‌ترند از ' +
        'آنچه مصرف می‌شود. اول سقف‌های نظر، دعوت و میزبانی را بررسی کنید و بعد ' +
        'هدیهٔ آغازین را.',
      sample: burned,
    };
  }

  /**
   * The median gap between signing up and buying — the plan's «فرش رایگان» measured
   * from the other end.
   *
   * Two-sided, which is why it is not a simple "higher is better": too short and
   * the product is stingy and burning users who never saw its value; too long and
   * something is leaking coins.
   */
  private timeToFirstPurchase(row: { median: number | null; buyers: number }): EconomyMetric {
    const value = row.median;
    return {
      key: 'days_to_first_purchase',
      label: 'میانهٔ روز تا اولین خرید',
      value,
      kind: 'days',
      status:
        value === null
          ? 'unknown'
          : value >= 30 && value <= 45
            ? 'good'
            : value >= 25 && value <= 75
              ? 'warn'
              : 'bad',
      target: 'بین ۳۰ تا ۴۵ روز',
      meaning:
        'از ثبت‌نام تا نخستین خرید سکه، برای کسانی که خرید کرده‌اند. ' +
        'می‌گوید فرش رایگان درست بریده شده یا نه.',
      advice:
        'زیر ۲۵ روز یعنی خسیس بوده‌اید و دارید کاربر می‌سوزانید — هدیهٔ آغازین را ' +
        'بالا ببرید. بالای ۷۵ روز یعنی جایی نشت دارید — سقف‌ها را دوباره بشمارید.',
      sample: row.buyers,
    };
  }

  /**
   * Of the people who went to three activities, how many bought.
   *
   * The one metric that is **not** about the economy at all. If somebody has been
   * out three times and still will not pay, the answer is not in any price: the
   * activities are not good enough, and no number in the plan fixes that.
   */
  private conversion(row: { converted: number; eligible: number }): EconomyMetric {
    const value = row.eligible === 0 ? null : row.converted / row.eligible;
    return {
      key: 'attended_to_purchase',
      label: 'تبدیل «۳ رویداد رفته» به خرید',
      value,
      kind: 'ratio',
      status: value === null ? 'unknown' : value > 0.35 ? 'good' : value > 0.2 ? 'warn' : 'bad',
      target: 'بیشتر از ۳۵٪',
      meaning:
        'از میان کسانی که در دست‌کم سه فعالیت شرکت کرده‌اند، چند درصد سکه خریده‌اند. ' +
        'می‌گوید محصول ارزشش را ثابت کرده یا نه.',
      advice:
        'اگر پایین است، مسئله قیمت نیست بلکه ارزش است: کسی که سه شب بیرون رفته و ' +
        'حاضر نیست پول بدهد، دارد دربارهٔ کیفیت فعالیت‌ها حرف می‌زند نه دربارهٔ قیمت.',
      sample: row.eligible,
    };
  }

  /**
   * Seats taken over seats offered.
   *
   * **This one governs the rest.** Below its target, no revenue optimisation is
   * allowed at all: every coin taken out of a thin market comes out of that
   * market's liquidity, and the correct move is to *lower* prices, not raise them.
   */
  private fill(row: { accepted: number; capacity: number; events: number }): EconomyMetric {
    const value = row.capacity === 0 ? null : row.accepted / row.capacity;
    return {
      key: 'fill_rate',
      label: 'نرخ پرشدن فعالیت',
      value,
      kind: 'ratio',
      status: value === null ? 'unknown' : value > 0.6 ? 'good' : value > 0.4 ? 'warn' : 'bad',
      target: 'بیشتر از ۶۰٪',
      meaning:
        'صندلی‌های پرشده تقسیم بر صندلی‌های عرضه‌شده، در فعالیت‌هایی که برگزار شده‌اند. ' +
        'فعالیت‌های بدون محدودیت ظرفیت شمرده نمی‌شوند، چون «پر شدن» برایشان معنا ندارد.',
      advice:
        '**حاکم بر بقیهٔ معیارهاست.** زیر ۶۰٪ هیچ بهینه‌سازی درآمدی مجاز نیست: ' +
        'مسئله قیمت نیست، کمبود عرضه است. در آن حالت هزینهٔ درخواست شرکت را ' +
        'موقتاً پایین بیاورید و همهٔ انرژی را روی ساختن فعالیت بگذارید.',
      sample: row.events,
    };
  }

  /** The busiest farmer in thirty days. The plan's own audit of its own caps. */
  private topEarner(coins: number): EconomyMetric {
    return {
      key: 'top_earner',
      label: 'بیشترین سکهٔ کسب‌شدهٔ یک کاربر',
      value: coins,
      kind: 'coins',
      status: coins <= 100 ? 'good' : coins <= 150 ? 'warn' : 'bad',
      target: 'حداکثر ۱۰۰ سکه در ۳۰ روز',
      meaning:
        'بیشترین مجموع سکه‌ای که یک کاربر در ۳۰ روز گذشته از منابع رایگان گرفته. ' +
        'جمع سه سقف — دعوت، نظر و میزبانی — همین عدد را می‌سازد.',
      advice:
        'اگر از ۱۰۰ بالاتر رفت، یعنی یک سقف را جا انداخته‌اید. ' +
        'در دفتر سکه، ردیف‌های همان کاربر را ببینید تا بفهمید کدام منبع بی‌کران است.',
      sample: 1,
    };
  }

  /** The operator's own ceiling: card-to-card is done by hand, one at a time. */
  private manualTransactions(saleCount: number): EconomyMetric {
    const perDay = saleCount / WINDOW_DAYS;
    return {
      key: 'manual_transactions',
      label: 'تراکنش دستی در روز',
      value: perDay,
      kind: 'perDay',
      status: perDay <= 15 ? 'good' : perDay <= 20 ? 'warn' : 'bad',
      target: 'حداکثر ۱۵ در روز',
      meaning:
        'میانگین روزانهٔ فروش کارت‌به‌کارت در ۳۰ روز گذشته. ' +
        'فروش یعنی تعدیل ادمینی که دلیلش با «sale:» شروع می‌شود.',
      advice:
        'هر تراکنش با تأیید بانکی پنج تا شش دقیقه وقت می‌گیرد. ' +
        'بالای ۱۵ در روز یعنی وقتِ درگاه پرداخت رسیده — و آن را باید پیش از ' +
        'تشکیل صف آماده کرد، نه بعدش.',
      sample: saleCount,
    };
  }

  /** The health of the trust signal after the reward was halved. */
  private reviews(row: { written: number; opportunities: number }): EconomyMetric {
    const value = row.opportunities === 0 ? null : row.written / row.opportunities;
    return {
      key: 'review_rate',
      label: 'نرخ نوشتن نظر',
      value,
      kind: 'ratio',
      status: value === null ? 'unknown' : value > 0.5 ? 'good' : value > 0.35 ? 'warn' : 'bad',
      target: 'بیشتر از ۵۰٪',
      meaning:
        'نظرهای نوشته‌شده تقسیم بر فرصت‌های نوشتن نظر. ' +
        'هر شرکتِ تسویه‌شده دو فرصت می‌سازد: یکی برای مهمان و یکی برای میزبان.',
      advice:
        'اگر زیر ۵۰٪ رفت، پاداش نظر را بالا ببرید. نظرها سیگنال اعتماد را ' +
        'می‌سازند، و اعتماد تنها چیزی است که این محصول را از یک گروه تلگرامی ' +
        'جدا می‌کند — افت آن، رتبه‌بندی و دعوت هدفمند را هم بی‌کیفیت می‌کند.',
      sample: row.opportunities,
    };
  }

  // ── The queries ────────────────────────────────────────────────────────────

  /**
   * Every ledger type in the window, split by **direction**. One scan.
   *
   * ── Why the split, and why it is not optional ───────────────────────────────
   *
   * Grouping by type alone gives a *net* per type, and three of these types carry
   * rows in both directions: `ADMIN_ADJUSTMENT` can add or remove, and a
   * `REVERSAL` is positive when it undoes a spend and negative when it claws back
   * a grant. Netting them and then taking an absolute value — which is what a
   * type-only grouping forces — produces a number that is neither the money in
   * nor the money out, and it lands in the leak rate, which is the one figure on
   * this page everything else is judged against.
   *
   * Split by sign, "credits of type X" and "debits of type X" are two facts, and
   * every bucket below picks the one it actually means. Raw SQL because the
   * grouping key is an expression, which Prisma's `groupBy` cannot express.
   */
  private async ledgerByType(since: Date): Promise<LedgerFlow[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ type: string; credit: boolean; coins: bigint | null; entries: bigint }>
    >`
      SELECT "type"::text AS type,
             "amount" > 0 AS credit,
             SUM(ABS("amount")) AS coins,
             COUNT(*)           AS entries
      FROM "coin_ledger"
      WHERE "created_at" >= ${since}
      GROUP BY 1, 2
    `;

    return rows.map((row) => ({
      type: row.type,
      credit: row.credit,
      coins: Number(row.coins ?? 0n),
      entries: Number(row.entries),
    }));
  }

  /**
   * Sales and gifts, told apart by the reason prefix.
   *
   * `metadata->>'reason'` starting with `sale:` is the whole revenue report, and
   * it works only because the operational rule holds: a gift or a compensation
   * must **never** carry that prefix. There is no second place this is enforced,
   * which is stated plainly in the plan and repeated here because this query is
   * what depends on it.
   */
  private async adjustments(
    since: Date,
  ): Promise<{ saleCoins: number; saleCount: number; giftCoins: number }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ is_sale: boolean; coins: bigint | null; entries: bigint }>
    >`
      SELECT COALESCE("metadata"->>'reason', '') LIKE 'sale:%' AS is_sale,
             SUM("amount")                                     AS coins,
             COUNT(*)                                          AS entries
      FROM "coin_ledger"
      WHERE "type" = 'ADMIN_ADJUSTMENT'
        AND "amount" > 0
        AND "created_at" >= ${since}
      GROUP BY 1
    `;

    const sale = rows.find((row) => row.is_sale);
    const gift = rows.find((row) => !row.is_sale);

    return {
      saleCoins: Number(sale?.coins ?? 0n),
      saleCount: Number(sale?.entries ?? 0n),
      giftCoins: Number(gift?.coins ?? 0n),
    };
  }

  /**
   * The median days from signing up to buying.
   *
   * Median rather than mean, and the difference matters here more than usual: one
   * account that signed up in the first week and bought in month nine would drag
   * a mean past every threshold on the page.
   *
   * **Not windowed.** This is a property of a user's whole life, and restricting
   * it to the last thirty days would answer a different question — "who bought
   * recently?" — whose answer is dominated by whoever signed up recently.
   */
  private async daysToFirstPurchase(): Promise<{ median: number | null; buyers: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ median: number | null; buyers: bigint }>>`
      WITH first_sale AS (
        SELECT l."user_id", MIN(l."created_at") AS bought_at
        FROM "coin_ledger" l
        WHERE l."type" = 'ADMIN_ADJUSTMENT'
          AND l."amount" > 0
          AND COALESCE(l."metadata"->>'reason', '') LIKE 'sale:%'
        GROUP BY l."user_id"
      )
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (f."bought_at" - u."created_at")) / 86400.0
             ) AS median,
             COUNT(*) AS buyers
      FROM first_sale f
      JOIN "user" u ON u."id" = f."user_id"
    `;

    const row = rows[0];
    return {
      median: row?.median ?? null,
      buyers: Number(row?.buyers ?? 0n),
    };
  }

  /** Of the users with three or more attended activities, how many have bought. */
  private async attendedToPurchase(): Promise<{ converted: number; eligible: number }> {
    const rows = await this.prisma.$queryRaw<Array<{ eligible: bigint; converted: bigint }>>`
      WITH attended AS (
        SELECT p."user_id"
        FROM "event_participant" p
        WHERE p."status" = 'COMPLETED'
        GROUP BY p."user_id"
        HAVING COUNT(*) >= 3
      )
      SELECT COUNT(*) AS eligible,
             COUNT(*) FILTER (
               WHERE EXISTS (
                 SELECT 1 FROM "coin_ledger" l
                 WHERE l."user_id" = a."user_id"
                   AND l."type" = 'ADMIN_ADJUSTMENT'
                   AND l."amount" > 0
                   AND COALESCE(l."metadata"->>'reason', '') LIKE 'sale:%'
               )
             ) AS converted
      FROM attended a
    `;

    const row = rows[0];
    return {
      eligible: Number(row?.eligible ?? 0n),
      converted: Number(row?.converted ?? 0n),
    };
  }

  /**
   * Seats taken over seats offered, for activities that reached their start.
   *
   * `capacity < 1000` excludes «بدون محدودیت», which is stored as the sentinel
   * 1000 rather than as a null. Including it would make one unlimited activity
   * with four guests read as 0.4% full and drag the whole rate down — the metric
   * would be measuring how many hosts chose "no limit", not how full anything got.
   */
  private async fillRate(
    since: Date,
  ): Promise<{ accepted: number; capacity: number; events: number }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ accepted: bigint | null; capacity: bigint | null; events: bigint }>
    >`
      SELECT SUM(e."accepted_count") AS accepted,
             SUM(e."capacity")       AS capacity,
             COUNT(*)                AS events
      FROM "event" e
      WHERE e."deleted_at" IS NULL
        AND e."status" IN ('COMPLETED', 'ONGOING', 'EXPIRED')
        AND e."starts_at" >= ${since}
        AND e."capacity" < 1000
    `;

    const row = rows[0];
    return {
      accepted: Number(row?.accepted ?? 0n),
      capacity: Number(row?.capacity ?? 0n),
      events: Number(row?.events ?? 0n),
    };
  }

  /**
   * The largest amount any one account earned from free sources in the window.
   *
   * A number, not a person: the panel's job here is to answer "is a cap
   * missing?", and naming who would be a different disclosure behind a different
   * permission. Whoever needs the account opens the ledger, which is where that
   * question belongs.
   */
  private async topEarnerIn(since: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ coins: bigint | null }>>`
      SELECT SUM(l."amount") AS coins
      FROM "coin_ledger" l
      WHERE l."created_at" >= ${since}
        AND l."amount" > 0
        AND l."type" IN ('REFERRAL_REWARD', 'REVIEW_REWARD', 'HOST_REWARD', 'COMEBACK_GRANT')
      GROUP BY l."user_id"
      ORDER BY 1 DESC
      LIMIT 1
    `;

    return Number(rows[0]?.coins ?? 0n);
  }

  /**
   * Reviews written over reviews that could have been.
   *
   * Two opportunities per settled participation — the guest's and the host's —
   * which is what `review_pair` is: one row per participation, two nullable review
   * columns. Counting the columns rather than joining the reviews keeps this a
   * single scan of one table.
   *
   * Only pairs whose window has actually **opened**, so a settlement from an hour
   * ago does not count as a review nobody wrote yet.
   */
  private async reviewRate(
    since: Date,
    now: Date,
  ): Promise<{ written: number; opportunities: number }> {
    // The injected clock, not SQL's `NOW()`. Every other date on this page comes
    // from `CLOCK`, and a report that mixed the two would disagree with itself
    // under a fake clock — which is exactly where it is asserted.
    const rows = await this.prisma.$queryRaw<Array<{ written: bigint; pairs: bigint }>>`
      SELECT COUNT(*) FILTER (WHERE p."host_review_id" IS NOT NULL)
             + COUNT(*) FILTER (WHERE p."guest_review_id" IS NOT NULL) AS written,
             COUNT(*)                                                  AS pairs
      FROM "review_pair" p
      WHERE p."created_at" >= ${since}
        AND p."opens_at" <= ${now}
    `;

    const row = rows[0];
    return {
      written: Number(row?.written ?? 0n),
      opportunities: Number(row?.pairs ?? 0n) * 2,
    };
  }
}
