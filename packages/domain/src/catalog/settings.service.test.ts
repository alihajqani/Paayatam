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
    expect(SETTING_DEFAULTS['economy.onboarding_reward_coins']).toBe(35);
    expect(SETTING_DEFAULTS['profile.min_age_years']).toBe(18);
  });
});

/**
 * The coin economy's shape, asserted as arithmetic rather than as eleven numbers.
 *
 * ── Why these are tests and not just constants ──────────────────────────────
 *
 * Because the failure they guard against already happened. Joining cost five and
 * reviewing the same activity paid ten, so **every attended activity left a user
 * five coins richer** — the economy was a spring, no single number looked wrong,
 * and nothing anywhere said so. Each case below is a *relation* between numbers,
 * which is the level at which that bug was visible and the level at which the
 * next one will be.
 *
 * A change that breaks one of these is not necessarily wrong. It is a change to
 * the product's economics, and it should have to say so out loud.
 */
describe('the coin economy defaults', () => {
  const join = SETTING_DEFAULTS['economy.event_join_coins'];
  const review = SETTING_DEFAULTS['economy.review_reward_coins'];

  it('is a sink: writing a review never pays back more than joining cost', () => {
    // The original fault, stated directly. At review >= join, every activity a
    // user attends makes them richer and nobody ever reaches zero.
    expect(review).toBeLessThan(join);
  });

  it('leaves the effective price of an activity clearly positive', () => {
    // Join, minus what reviewing it gives back. This is the number the whole
    // revenue model is denominated in.
    expect(join - review).toBeGreaterThan(0);
    // And the rebate is a discount rather than a wage: about a quarter.
    expect(review / join).toBeLessThanOrEqual(0.35);
  });

  it('gives a new profile at least two activities and fewer than four', () => {
    // §9's "two free activities", counted at the **effective** price — join
    // minus what reviewing it gives back — because that is the price somebody
    // who uses the product normally actually pays. At the sticker price of 20,
    // 35 coins looks like one activity and fifteen wasted; at the effective 15
    // it is the two the plan's own runway table shows.
    //
    // Which number this test uses is not a detail: getting it wrong here is
    // getting the free runway wrong, and the free runway is the single thing
    // §10 says invalidates the whole plan if it is mis-cut.
    const free = Math.floor(SETTING_DEFAULTS['economy.onboarding_reward_coins'] / (join - review));
    expect(free).toBeGreaterThanOrEqual(2);
    expect(free).toBeLessThan(4);
  });

  it('returns the registration deposit in full but never more', () => {
    // The deposit refund must match what registration costs, or hosting is
    // either a fee dressed up as a deposit or a mint. `HostRewardService` floors
    // the refund at what was actually charged, so "more" cannot be paid — this
    // asserts the *configuration* agrees with the promise the bot makes.
    const registration =
      SETTING_DEFAULTS['economy.event_create_coins'] +
      SETTING_DEFAULTS['economy.event_channel_publish_coins'];
    expect(SETTING_DEFAULTS['economy.host_deposit_refund_coins']).toBe(registration);
  });

  it('bounds every renewable source, so no grant is infinite', () => {
    // §2's first principle. Three sources grow with activity; each needs a
    // ceiling, and a zero here would mean "uncapped" rather than "no reward".
    expect(SETTING_DEFAULTS['economy.earning_cap_days']).toBeGreaterThan(0);
    expect(SETTING_DEFAULTS['economy.review_reward_cap']).toBeGreaterThan(0);
    expect(SETTING_DEFAULTS['economy.referral_reward_cap']).toBeGreaterThan(0);
    expect(SETTING_DEFAULTS['economy.host_reward_cap']).toBeGreaterThan(0);
  });

  it('caps the most anybody can farm in a month at about five activities', () => {
    // §3's «سقف قابل‌کشت»: the number §12 says to measure. If the top earner in
    // any thirty days exceeds it, a cap has been left off something.
    const farmable =
      SETTING_DEFAULTS['economy.referral_reward_cap'] *
        SETTING_DEFAULTS['economy.referral_referrer_coins'] +
      SETTING_DEFAULTS['economy.review_reward_cap'] +
      SETTING_DEFAULTS['economy.host_reward_cap'];
    expect(farmable).toBeLessThanOrEqual(100);
    // Bounded from below too: a ceiling nobody can reach is a ceiling that
    // measures nothing, and the metric would read healthy forever.
    expect(farmable).toBeGreaterThanOrEqual(4 * join);
  });

  it('keeps the comeback grant out of reach of a fresh account', () => {
    // It is for somebody who used the product and ran out, which is why the
    // trust bar sits above where an account starts.
    expect(SETTING_DEFAULTS['economy.comeback_min_trust']).toBeGreaterThan(
      SETTING_DEFAULTS['trust.initial_score'],
    );
    expect(SETTING_DEFAULTS['economy.comeback_min_attended_events']).toBeGreaterThanOrEqual(2);
  });

  it('prices a no-show above the onboarding gift', () => {
    // §4: the one penalty that has to frighten. Below the gift, a new account
    // can no-show its way through the free runway at no cost at all.
    expect(SETTING_DEFAULTS['cancellation.coins_no_show']).toBeGreaterThan(
      SETTING_DEFAULTS['economy.onboarding_reward_coins'],
    );
  });

  it('keeps the founding campaign cheaper than a month of the revenue target', () => {
    // §8: at 150/80/40 the campaign gave away roughly a month of the target
    // before the product had earned anything — to the people least likely to
    // stay. The 3:2:1 spacing is what survived; the scale is what changed.
    expect(SETTING_DEFAULTS['founding.tier1_coins']).toBeGreaterThan(
      SETTING_DEFAULTS['founding.tier2_coins'],
    );
    expect(SETTING_DEFAULTS['founding.tier2_coins']).toBeGreaterThan(
      SETTING_DEFAULTS['founding.tier3_coins'],
    );
    // Tier 1 buys a handful of activities, not a season of them.
    expect(SETTING_DEFAULTS['founding.tier1_coins'] / join).toBeLessThanOrEqual(2);
  });
});
