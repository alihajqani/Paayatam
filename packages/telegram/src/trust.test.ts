import { describe, expect, it } from 'vitest';
import { parseTrustCallback, parseWalletCallback } from './callback-data';
import { formatTrust, trustPageRow } from './trust';

const LINE = {
  delta: -5,
  scoreAfter: 45,
  type: 'CANCELLATION',
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
};

/**
 * Five to a page, and a way to the sixth (v0.8.1).
 *
 * `/wallet` grew this in v0.7.0 and `/trust` did not, so «سکه و امتیاز» had one
 * half you could read all of and one you could not: twenty rows, fixed, with
 * nothing to say there were more behind them. ADR-0007's «a score nobody can
 * account for is a score nobody can appeal» is not satisfied by showing the most
 * recent twentieth of it.
 */
describe('the Trust Score history pages', () => {
  it('draws no control when one page is the whole history', () => {
    expect(trustPageRow(0, false)).toEqual([]);
  });

  it('offers both directions from the middle, and neither past the ends', () => {
    const [row] = trustPageRow(2, true);
    const [previous, here, next] = row ?? [];

    expect(parseTrustCallback(previous?.callbackData ?? '')).toBe(1);
    expect(parseTrustCallback(here?.callbackData ?? '')).toBe(2);
    expect(parseTrustCallback(next?.callbackData ?? '')).toBe(3);

    const [first] = trustPageRow(0, true);
    expect(first).toHaveLength(2);
    const [last] = trustPageRow(3, false);
    expect(last).toHaveLength(2);
  });

  /** «تغییرهای اخیر» on page three would be a heading that lies. */
  it('stops calling the rows recent once the reader has paged on', () => {
    expect(formatTrust(45, [LINE], 0)).toContain('تغییرهای اخیر');

    const later = formatTrust(45, [LINE], 2);
    expect(later).not.toContain('تغییرهای اخیر');
    expect(later).toContain('صفحهٔ ۳');
  });

  it('keeps the score at the head of every page', () => {
    expect(formatTrust(45, [LINE], 4)).toContain('۴۵ از ۱۰۰');
  });

  /** A page past the end is an empty page, not «هنوز تغییری ثبت نشده». */
  it('does not tell a paging reader nothing has ever moved', () => {
    expect(formatTrust(45, [], 3)).toContain('تغییر دیگری نیست');
    expect(formatTrust(45, [], 0)).toContain('هنوز تغییری ثبت نشده است');
  });

  /**
   * Never *who*. A `REVIEW` row says a review moved the score and no more;
   * naming the reviewer would undo the double-blind the pair exists to hold.
   */
  it('names the kind of movement and not its author', () => {
    const rendered = formatTrust(50, [{ ...LINE, type: 'REVIEW' }], 0);
    expect(rendered).toContain('نظری که دریافت کردید');
    expect(rendered).toContain('−۵');
  });
});

describe('parseTrustCallback', () => {
  it('refuses anything that is not its own protocol', () => {
    expect(parseTrustCallback('mv:1:x')).toBeNull();
    expect(parseTrustCallback('ts:1')).toBeNull();
    expect(parseTrustCallback('')).toBeNull();
  });

  /**
   * `ts:` and `wl:` are separate protocols and each refuses the other.
   *
   * The two page rows are the same shape over the same base-36 slot, so a parser
   * that accepted both would be one mistake away from redrawing the wallet from a
   * tap on the score — the reason `EVENT_CALLBACK_ACTIONS` and `chat:` are split
   * too.
   */
  it('does not answer the wallet, and the wallet does not answer it', () => {
    const [row] = trustPageRow(1, true);
    const here = row?.[0]?.callbackData ?? '';

    expect(parseTrustCallback(here)).not.toBeNull();
    expect(parseWalletCallback(here)).toBeNull();
    expect(parseTrustCallback('wl:1:x')).toBeNull();
  });
});
