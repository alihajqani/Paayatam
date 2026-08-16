import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';

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
  /** The legal minimum age for the platform. Enforced at profile write (plan §4.1). */
  'profile.min_age_years': 18,
  /** Events a host may create in one Tehran day (plan §11, T6.1). */
  'events.max_per_day': 5,
  /** Upcoming, non-retired events a host may hold at once (plan §11). */
  'events.max_concurrent_active': 3,

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
   */
  async getInt(key: SettingKey): Promise<number> {
    return this.read(key, (value) => Number.isInteger(value));
  }

  /**
   * A fractional policy number — a ranking weight, a penalty multiplier.
   *
   * Same fallback discipline as `getInt`, minus the integrality requirement.
   * Kept as a separate method rather than relaxing `getInt`, because a coin
   * amount that arrives as 12.5 is a bug and should still be rejected.
   */
  async getNumber(key: SettingKey): Promise<number> {
    return this.read(key, (value) => Number.isFinite(value));
  }

  /** Reads several keys at once. One round trip instead of one per weight. */
  async getNumbers<K extends SettingKey>(keys: readonly K[]): Promise<Record<K, number>> {
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: [...keys] } } });
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

  private async read(key: SettingKey, accept: (value: number) => boolean): Promise<number> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    if (!row) return SETTING_DEFAULTS[key];

    const value = row.value;
    return typeof value === 'number' && accept(value) ? value : SETTING_DEFAULTS[key];
  }
}
