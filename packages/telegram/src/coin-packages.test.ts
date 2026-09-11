import { describe, expect, it } from 'vitest';
import { buyCoinsRow, formatCoinPackages, type CoinPackage } from './coin-packages';
import { encodeBuyCallback, parseBuyCallback } from './callback-data';

/**
 * The price list is the economy's entrance (ADR-0019).
 *
 * Everything else in this product that produces a coin is capped and most are
 * once per lifetime, so this screen is the only answer the product has to "I
 * have run out". What it is tested for is therefore not prose but arithmetic:
 * the ladder only does its job if the per-coin figures are right, and a wrong
 * one is a pricing decision made by a rounding bug.
 */
const CONTACT = '@payetam_support';

/** Plan §6's table, which is also `SETTING_DEFAULTS`. */
const TIERS: CoinPackage[] = [
  { name: 'کوچک', coins: 45, toman: 45_000 },
  { name: 'میانه', coins: 110, toman: 99_000, featured: true },
  { name: 'بزرگ', coins: 250, toman: 209_000 },
  { name: 'فصلی', coins: 600, toman: 469_000 },
];

function render(overrides: Partial<Parameters<typeof formatCoinPackages>[0]> = {}): string {
  return formatCoinPackages({
    packages: TIERS,
    referencePrice: 950,
    contact: CONTACT,
    balance: 0,
    ...overrides,
  });
}

describe('the coin price list', () => {
  it('prices every tier in coins and in toman, grouped and in Persian digits', () => {
    const text = render();

    expect(text).toContain('۴۵ سکه · ۴۵,۰۰۰ تومان');
    expect(text).toContain('۱۱۰ سکه · ۹۹,۰۰۰ تومان');
    expect(text).toContain('۲۵۰ سکه · ۲۰۹,۰۰۰ تومان');
    expect(text).toContain('۶۰۰ سکه · ۴۶۹,۰۰۰ تومان');
  });

  /**
   * The comparison the whole ladder rests on. Without it the four rows are four
   * prices, and the reason the medium tier is the sensible one is invisible.
   */
  it('shows what one coin costs in each tier', () => {
    const text = render();

    expect(text).toContain('هر سکه ۱,۰۰۰ تومان');
    expect(text).toContain('هر سکه ۹۰۰ تومان');
    expect(text).toContain('هر سکه ۸۳۶ تومان');
    // 469,000 ÷ 600 is 781.67 — rounded, not truncated.
    expect(text).toContain('هر سکه ۷۸۲ تومان');
  });

  /**
   * The small tier is deliberately **above** the reference price: its job is to
   * make the medium one look cheap. A discount badge on it would be false, and
   * the code must not produce one from a negative number.
   */
  it('never claims a discount on the tier that is more expensive than the anchor', () => {
    const text = render({ packages: [TIERS[0] as CoinPackage] });

    expect(text).not.toContain('ارزان‌تر');
  });

  it('names a discount only once it is worth naming', () => {
    const text = render();

    // 836 and 782 against 950: 12% and 18%, the two the plan advertises.
    expect(text).toContain('۱۲٪ ارزان‌تر');
    expect(text).toContain('۱۸٪ ارزان‌تر');
    // The medium tier saves about 5%, which is noise on a screen whose job is
    // one comparison.
    expect(text).not.toContain('۵٪ ارزان‌تر');
  });

  it('marks exactly one tier', () => {
    const text = render();

    expect(text.match(/★/g)).toHaveLength(1);
    expect(text).toContain('★ <b>میانه</b>');
  });

  it('anchors on the reference price', () => {
    expect(render()).toContain('هر سکه حدود ۹۵۰ تومان');
  });

  /**
   * Three steps, and the tracking number is the one that matters: it is what
   * makes the deposit findable in a banking app and what the operator writes
   * into the ledger row, which is what stops one transfer being credited twice.
   */
  it('sends the reader to a person, with the tracking number asked for', () => {
    const text = render();

    expect(text).toContain(CONTACT);
    expect(text).toContain('شمارهٔ پیگیری');
  });

  /**
   * This is the one screen in the product that sends somebody to move money,
   * which makes it the exact screen a scammer would imitate.
   */
  it('says plainly that the bot never asks for a card number', () => {
    expect(render()).toContain('پایه‌تَم هرگز شمارهٔ کارت');
  });

  it('shows the balance the reader is trying to change', () => {
    expect(render({ balance: 12 })).toContain('۱۲ سکه');
  });

  /**
   * Every tier zeroed is how an operator closes the shop without a release. The
   * screen has to say so — an empty table reads as broken, and the reader still
   * needs somewhere to go.
   */
  it('says the shop is closed rather than drawing an empty table', () => {
    const text = render({ packages: [] });

    expect(text).toContain('فروش سکه فعلاً باز نیست');
    expect(text).toContain(CONTACT);
  });

  /** A reference price of zero must not divide the screen into NaN. */
  it('survives a reference price of zero', () => {
    const text = render({ referencePrice: 0 });

    expect(text).not.toContain('NaN');
    expect(text).toContain('۴۵ سکه');
  });

  /**
   * The names are constants today. The escape is what keeps that from being the
   * reason this is safe — the message goes out with `parse_mode: HTML`.
   */
  it('escapes a package name rather than trusting it', () => {
    const text = render({ packages: [{ name: '<b>x', coins: 10, toman: 10_000 }] });

    expect(text).toContain('&lt;b&gt;x');
  });
});

describe('the button that opens it', () => {
  it('round-trips', () => {
    expect(parseBuyCallback(encodeBuyCallback())).toBe(true);
  });

  it('carries no package, so no order is implied by a tap', () => {
    // Three parts, and the value slot spends the same `x` every other
    // id-less callback in this codec does.
    expect(encodeBuyCallback().split(':')).toEqual(['by', 'coins', 'x']);
  });

  it('refuses anything else', () => {
    expect(parseBuyCallback('by:coins:abc')).toBe(false);
    expect(parseBuyCallback('by:other:x')).toBe(false);
    expect(parseBuyCallback('wl:0:x')).toBe(false);
    expect(parseBuyCallback('by:coins')).toBe(false);
    expect(parseBuyCallback('')).toBe(false);
  });

  it('draws one row with one button', () => {
    const row = buyCoinsRow();

    expect(row).toHaveLength(1);
    expect(row[0]).toHaveLength(1);
    expect(row[0]?.[0]?.text).toContain('خرید سکه');
  });
});
