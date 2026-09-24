import { describe, expect, it } from 'vitest';
import { foundingLine, onboardingGiftLine } from './bot.service';

/**
 * «۳۵ سکه هدیه گرفتید — تقریباً دو بار شرکت در رویداد.»
 *
 * ── Why this line has a test of its own ─────────────────────────────────────
 *
 * Because the arithmetic in it is the free runway, and the free runway is one of
 * the two things §10 of the coin economy plan says invalidates the whole plan if
 * it is mis-cut. It is also arithmetic that is easy to get *plausibly* wrong:
 * dividing the grant by the sticker price of a join gives one activity, dividing
 * by the effective price — the join minus the rebate for reviewing it — gives
 * two, and both look correct in isolation.
 *
 * Two is right, and the plan's own runway table is why: 35 → 20 → 5, because
 * somebody who joins also writes the review. Getting this wrong understates the
 * gift at the one moment it is supposed to land, or overstates it, which is
 * worse.
 */
describe('onboardingGiftLine', () => {
  it('prices the grant in activities at the effective cost, not the sticker one', () => {
    // The shipped defaults: 35 granted, 20 to join, 5 back for the review.
    const line = onboardingGiftLine(35, 20, 5);
    expect(line).toContain('۳۵ سکه');
    expect(line).toContain('۲ بار');
  });

  it('rounds down, so it never promises an activity the grant cannot fund', () => {
    // 50 over an effective 15 is three and a third. Three is what is on offer.
    expect(onboardingGiftLine(50, 20, 5)).toContain('۳ بار');
  });

  it('says only the amount when the grant does not reach one activity', () => {
    // «تقریباً ۰ بار شرکت» is not a sentence, and «۱ بار» would be a lie.
    const line = onboardingGiftLine(10, 20, 5);
    expect(line).toContain('۱۰ سکه');
    expect(line).not.toContain('بار');
  });

  it('says only the amount when joining is free', () => {
    // No price means "how many activities does this buy" has no answer — and a
    // division by zero would be an `Infinity` on somebody's welcome screen.
    const line = onboardingGiftLine(35, 0, 0);
    expect(line).toContain('۳۵ سکه');
    expect(line).not.toContain('بار');
  });

  it('says only the amount when the review rebate cancels the join price', () => {
    // The configuration the whole rebalance exists to prevent: a review paying
    // back everything an activity costs. The line must not divide by zero or go
    // negative on the way to reporting it.
    const line = onboardingGiftLine(35, 20, 20);
    expect(line).toContain('۳۵ سکه');
    expect(line).not.toContain('بار');
  });

  it('renders nothing at all when no grant was made', () => {
    // Every re-edit of a profile that was already complete. The coins were paid
    // once, months ago, and saying so again would be the product congratulating
    // itself for something that did not just happen.
    expect(onboardingGiftLine(0, 20, 5)).toBe('');
  });
});

/**
 * «🥇 شما نفر ۴۲ از ۱۰۰۰ نفر اولِ پایه‌تم هستید.»
 *
 * The one moment a rank is announced, so it leads with the medal of the tier it
 * landed in — the same medal the roster and the profile card show afterwards.
 */
describe('foundingLine', () => {
  it('leads with the medal of the tier the rank landed in', () => {
    expect(foundingLine({ rank: 42, tier: 1, coins: 150 }, 1000)).toMatch(/^🥇 /u);
    expect(foundingLine({ rank: 250, tier: 2, coins: 80 }, 1000)).toMatch(/^🥈 /u);
    expect(foundingLine({ rank: 900, tier: 3, coins: 40 }, 1000)).toMatch(/^🥉 /u);
  });

  it('keeps the rank and the cap, and drops the old ticket', () => {
    const line = foundingLine({ rank: 42, tier: 1, coins: 150 }, 1000);
    expect(line).toContain('نفر ۴۲ از ۱۰۰۰');
    expect(line).not.toContain('🎟');
  });

  it('renders nothing for somebody the campaign did not rank', () => {
    expect(foundingLine(null, 1000)).toBe('');
  });
});
