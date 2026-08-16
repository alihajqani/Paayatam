import { describe, expect, it } from 'vitest';
import type { PrismaService } from '@payetam/db';
import { SETTING_DEFAULTS, SettingsService } from './settings.service';

/**
 * A stub, not a database. What is under test here is the fallback policy — what
 * happens when a row is missing or malformed — which is pure decision logic. The
 * behaviour that genuinely depends on Postgres is tested in the `.int.test.ts`
 * files instead.
 */
function serviceReturning(value: unknown): SettingsService {
  const prisma = {
    appSetting: {
      findUnique: () => Promise.resolve(value === undefined ? null : { value }),
    },
  } as unknown as PrismaService;

  return new SettingsService(prisma);
}

describe('SettingsService.getInt', () => {
  it('returns the stored value', async () => {
    await expect(serviceReturning(75).getInt('economy.onboarding_reward_coins')).resolves.toBe(75);
  });

  it('falls back to the documented default when the row is missing', async () => {
    // A fresh database, or a key deleted by hand. Taking onboarding down over a
    // missing config row would be a worse failure than granting the default.
    await expect(
      serviceReturning(undefined).getInt('economy.onboarding_reward_coins'),
    ).resolves.toBe(SETTING_DEFAULTS['economy.onboarding_reward_coins']);
  });

  it.each([
    ['a string', '50'],
    ['a float', 12.5],
    ['null', null],
    ['an object', { coins: 50 }],
    ['an array', [50]],
    ['a boolean', true],
  ])('falls back when the stored value is %s', async (_label, stored) => {
    // An admin typo must not become NaN coins in an append-only ledger. There is
    // no clean way to un-write that row.
    await expect(serviceReturning(stored).getInt('economy.onboarding_reward_coins')).resolves.toBe(
      SETTING_DEFAULTS['economy.onboarding_reward_coins'],
    );
  });

  it('agrees with the policy defaults in plan §11', () => {
    expect(SETTING_DEFAULTS['economy.onboarding_reward_coins']).toBe(50);
    expect(SETTING_DEFAULTS['profile.min_age_years']).toBe(18);
  });
});
