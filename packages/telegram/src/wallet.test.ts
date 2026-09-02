import { describe, expect, it } from 'vitest';
import { parseWalletCallback } from './callback-data';
import { formatWallet, walletPageRow } from './wallet';

const LINE = {
  amount: -15,
  balanceAfter: 35,
  type: 'EVENT_CREATE_SPEND',
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
};

/**
 * Five to a page, and a way to the sixth (v0.7.0).
 *
 * Twenty rows in one message pushed the balance off the top of the screen, and
 * it was a fixed slice: an account with fifty movements had thirty the bot could
 * not reach at all.
 */
describe('the wallet ledger pages', () => {
  it('draws no control when one page is the whole ledger', () => {
    expect(walletPageRow(0, false)).toEqual([]);
  });

  it('offers both directions from the middle, and neither past the ends', () => {
    const [row] = walletPageRow(2, true);
    const [previous, here, next] = row ?? [];

    expect(parseWalletCallback(previous?.callbackData ?? '')).toBe(1);
    expect(parseWalletCallback(here?.callbackData ?? '')).toBe(2);
    expect(parseWalletCallback(next?.callbackData ?? '')).toBe(3);

    const [first] = walletPageRow(0, true);
    expect(first).toHaveLength(2);
    const [last] = walletPageRow(3, false);
    expect(last).toHaveLength(2);
  });

  /** «تراکنش‌های اخیر» on page three would be a heading that lies. */
  it('stops calling the rows recent once the reader has paged on', () => {
    expect(formatWallet(20, [LINE], 0)).toContain('تراکنش‌های اخیر');

    const later = formatWallet(20, [LINE], 2);
    expect(later).not.toContain('تراکنش‌های اخیر');
    expect(later).toContain('صفحهٔ ۳');
  });

  it('keeps the balance at the head of every page', () => {
    expect(formatWallet(20, [LINE], 4)).toContain('موجودی: ۲۰ سکه');
  });

  /** A page past the end is an empty page, not «هنوز تراکنشی ندارید». */
  it('does not tell a paging reader they have never transacted', () => {
    expect(formatWallet(20, [], 3)).toContain('تراکنش دیگری نیست');
    expect(formatWallet(20, [], 0)).toContain('هنوز تراکنشی ندارید');
  });
});

describe('parseWalletCallback', () => {
  it('refuses anything that is not its own protocol', () => {
    expect(parseWalletCallback('mv:1:x')).toBeNull();
    expect(parseWalletCallback('wl:1')).toBeNull();
    expect(parseWalletCallback('wl:zz:x')).toBeNull();
  });
});
