import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';

/**
 * Reads policy numbers out of `app_setting`.
 *
 * ADR-0007 and ADR-0011: every tunable number in the product — reward amounts,
 * penalty thresholds, the report threshold, ranking weights — lives in the
 * database so tuning is a config change rather than a deploy.
 *
 * The defaults below are not a second source of truth. They are what the system
 * does when a row is missing: on a fresh database, before the seed has run, or
 * after someone deletes a key by hand. The alternative — throwing — would mean a
 * missing config row takes onboarding down, which is a worse failure than
 * granting the documented default. Every default here matches plan §11.
 */
export const SETTING_DEFAULTS = {
  /** Coins granted once, when a user first completes their profile. */
  'economy.onboarding_reward_coins': 50,

  /**
   * The referral pair (plan §11), paid only after the referred user **attends**
   * an event — not on signup. A referral that pays out for creating an account
   * pays out for creating accounts (T6).
   */
  'economy.referral_referrer_coins': 30,
  'economy.referral_referred_coins': 10,

  /**
   * The two coin sinks in MVP (plan §2.9). Boost buys 24 hours near the top of
   * discovery; VIP is a one-off placement flag.
   */
  'economy.boost_coins': 40,
  'economy.boost_duration_hours': 24,
  'economy.vip_coins': 100,

  /**
   * Where a new account starts (plan §11). The 0–100 *range* is deliberately not
   * here: ADR-0007 writes it into the schema as a CHECK, and a configurable clamp
   * over a fixed constraint would be a setting whose only possible effect is a
   * constraint violation.
   */
  'trust.initial_score': 50,
  /** Completing a profile is the first thing that moves the score (plan §11). */
  'trust.profile_complete_delta': 5,

  /**
   * Referral velocity, recorded in `fraud_signals` rather than enforced.
   *
   * T6 asks for velocity limits and for `fraud_signals` for admin review, and the
   * order matters: a false positive here silently steals somebody's reward, so
   * this flags for a human instead of refusing. The real control is that the
   * reward requires an attended event, which does not scale to a farm.
   */
  'referral.velocity_window_hours': 24,
  'referral.velocity_threshold': 10,
  /** The legal minimum age for the platform. Enforced at profile write (plan §4.1). */
  'profile.min_age_years': 18,
  /** Events a host may create in one Tehran day (plan §11, T6.1). */
  'events.max_per_day': 5,
  /** Upcoming, non-retired events a host may hold at once (plan §11). */
  'events.max_concurrent_active': 3,

  /**
   * How long a host has to decide, and how close to the event a decision still
   * means anything: the deadline is `min(now + 24h, starts_at - 3h)` (plan §11).
   * Both matter because a PENDING request holds a seat — these numbers bound how
   * long an undecided request keeps one out of circulation.
   */
  'participation.host_response_hours': 24,
  'participation.min_hours_before_event': 3,
  /** Cancel within this many minutes of being accepted and it costs nothing. */
  'participation.grace_minutes': 15,

  /**
   * The promoted-request deadline: `min(now + 12h, starts_at - 3h)` (ADR-0011).
   *
   * Shorter than the 24 hours a fresh request gets, and deliberately so — a
   * promotion happens because a seat came free, which is later in the event's
   * life and leaves less room to dither. Separate keys from the
   * `participation.*` pair above even though the second number matches today,
   * because ADR-0011 names them separately and they are tuned against different
   * things.
   */
  'waitlist.promotion_deadline_hours': 12,
  'waitlist.min_hours_before_event': 3,

  // Ranking weights (plan §11). Fractions, not integers — read with `getNumber`.
  // Trust is capped at 0.10 deliberately: §12 resolves "Trust Score in ranking"
  // against "no unfair discrimination" by keeping trust a tenth of the signal, so
  // a new host with a neutral score is never buried.
  'ranking.weight_time_proximity': 0.35,
  'ranking.weight_popularity': 0.2,
  'ranking.weight_recency': 0.15,
  'ranking.weight_boost': 0.15,
  'ranking.weight_trust': 0.1,
  'ranking.weight_interest_match': 0.05,
} as const satisfies Record<string, number>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * An integer policy number.
   *
   * Falls back to the documented default when the row is absent, and also when
   * the stored value is not an integer. A garbled `app_setting` row is an admin
   * mistake; letting it become `NaN` coins would turn that mistake into a
   * corrupted ledger, which no amount of later correction fully undoes.
   *
   * **Pass `tx` when reading inside a transaction.** Without it this borrows a
   * second connection from the pool while the caller still holds the first, and
   * N concurrent callers doing that exhaust the pool and wait on each other
   * forever. It shows up as "Unable to start a transaction in the given time" —
   * a message that describes the symptom and hides the cause completely.
   */
  async getInt(key: SettingKey, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return this.read(key, (value) => Number.isInteger(value), tx);
  }

  /**
   * A fractional policy number — a ranking weight, a penalty multiplier.
   *
   * Same fallback discipline as `getInt`, minus the integrality requirement.
   * Kept as a separate method rather than relaxing `getInt`, because a coin
   * amount that arrives as 12.5 is a bug and should still be rejected.
   */
  async getNumber(key: SettingKey, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return this.read(key, (value) => Number.isFinite(value), tx);
  }

  /** Reads several keys at once. One round trip instead of one per weight. */
  async getNumbers<K extends SettingKey>(
    keys: readonly K[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Record<K, number>> {
    const rows = await tx.appSetting.findMany({ where: { key: { in: [...keys] } } });
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    return Object.fromEntries(
      keys.map((key) => {
        const value = stored.get(key);
        return [
          key,
          typeof value === 'number' && Number.isFinite(value) ? value : SETTING_DEFAULTS[key],
        ];
      }),
    ) as Record<K, number>;
  }

  private async read(
    key: SettingKey,
    accept: (value: number) => boolean,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const row = await tx.appSetting.findUnique({ where: { key } });
    if (!row) return SETTING_DEFAULTS[key];

    const value = row.value;
    return typeof value === 'number' && accept(value) ? value : SETTING_DEFAULTS[key];
  }
}
