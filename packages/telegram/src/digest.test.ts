import { describe, expect, it } from 'vitest';
import { buildDigest, TELEGRAM_MESSAGE_LIMIT } from './digest';

function entries(count: number, text = 'مورد'): string[] {
  return Array.from({ length: count }, (_, i) => `${text} ${String(i)}`);
}

describe('buildDigest', () => {
  it('renders the empty sentence alone when there is nothing to list', () => {
    const text = buildDigest({ title: 'عنوان', empty: 'چیزی نیست.', entries: [] });

    expect(text).toBe('<b>عنوان</b>\n\nچیزی نیست.');
  });

  it('keeps every entry when the list is small', () => {
    const text = buildDigest({ title: 'ع', empty: '-', entries: entries(3) });

    expect(text).toContain('مورد 0');
    expect(text).toContain('مورد 2');
    expect(text).not.toContain('مورد دیگر');
  });

  /**
   * The bug this module exists for. `listMine` and `listForUser` take no `take`
   * at all, so the digest is as long as the user is prolific — and past
   * Telegram's limit the send is a permanent 400 that `classify` retries.
   */
  it('stays under Telegram’s message limit for an unbounded list', () => {
    const text = buildDigest({
      title: 'رویدادهای شما',
      empty: '-',
      entries: entries(500, 'یک عنوان نسبتاً بلند برای آزمودن سقف پیام'),
    });

    expect(text.length).toBeLessThan(TELEGRAM_MESSAGE_LIMIT);
  });

  it('caps the number of entries even when they are all short', () => {
    const text = buildDigest({ title: 'ع', empty: '-', entries: entries(63) });

    expect(text).toContain('مورد 19');
    expect(text).not.toContain('مورد 20');
  });

  /** Showing 20 of 63 without saying so is a digest that lies about the total. */
  it('says how many it did not show, in Persian digits', () => {
    const text = buildDigest({ title: 'ع', empty: '-', entries: entries(63) });

    expect(text).toContain('و ۴۳ مورد دیگر');
  });

  it('trims from the end, so the most relevant entries survive', () => {
    const text = buildDigest({ title: 'ع', empty: '-', entries: entries(30) });

    expect(text).toContain('مورد 0');
    expect(text).not.toContain('مورد 29');
  });

  /**
   * A heading and a tail with nothing between them reads as a bug rather than as
   * a limit, so one over-budget entry is kept rather than dropped.
   */
  it('keeps a single entry that alone exceeds the budget', () => {
    const huge = 'ا'.repeat(5000);
    const text = buildDigest({ title: 'ع', empty: '-', entries: [huge] });

    expect(text).toContain(huge);
  });
});
