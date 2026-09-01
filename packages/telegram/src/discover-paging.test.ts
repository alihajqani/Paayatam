import { describe, expect, it } from 'vitest';
import {
  MAX_DISCOVER_PAGE,
  encodeDiscoverCallback,
  parseDiscoverCallback,
  type DiscoverFilters,
} from './callback-data';
import { describeFilters, discoverFilterRows, discoverPageRow } from './discover-filters';

const CATEGORY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function filters(overrides: Partial<DiscoverFilters> = {}): DiscoverFilters {
  return { when: 'a', cost: 'a', categoryId: null, page: 0, ...overrides };
}

/**
 * Paging `/discover`, which showed five activities and had no way to reach a
 * sixth (v0.6.5).
 *
 * The whole mechanism lives in the callback payload, because the bot keeps no
 * per-user query state: a page button has to carry the entire query plus one, in
 * the sixty-four bytes Telegram allows.
 */
describe('the discovery callback with a page in it', () => {
  it.each([0, 1, 9, 10, 35])('round-trips page %i', (page) => {
    expect(parseDiscoverCallback(encodeDiscoverCallback(filters({ page })))).toEqual(
      filters({ page }),
    );
  });

  it('round-trips a page alongside the other filters', () => {
    const value = filters({ when: 'w', cost: 'f', categoryId: CATEGORY, page: 3 });
    expect(parseDiscoverCallback(encodeDiscoverCallback(value))).toEqual(value);
  });

  /**
   * The compatibility case, and the reason the page is one base-36 character
   * appended to the existing flags rather than a fourth colon-separated field.
   *
   * Every `/discover` message sent before v0.6.5 is still in somebody's chat with
   * two-character flags on its buttons. Those must keep working — a filter that
   * answers «این دکمه دیگر کار نمی‌کند» is worse than one that does not page.
   */
  it('reads a pre-paging payload as page zero', () => {
    expect(parseDiscoverCallback('dc:wf:all')).toEqual({
      when: 'w',
      cost: 'f',
      categoryId: null,
      page: 0,
    });
  });

  it('stays inside Telegram’s 64 bytes at its widest', () => {
    const widest = encodeDiscoverCallback(
      filters({ when: 'w', cost: 'f', categoryId: CATEGORY, page: MAX_DISCOVER_PAGE }),
    );
    expect(Buffer.byteLength(widest, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('refuses a page character outside the encoding', () => {
    expect(parseDiscoverCallback('dc:aa!:all')).toBeNull();
  });

  /** Clamped rather than thrown: a button is built, never validated by a user. */
  it('clamps a page past the maximum instead of encoding an unparseable one', () => {
    const encoded = encodeDiscoverCallback(filters({ page: 999 }));
    expect(parseDiscoverCallback(encoded)).toEqual(filters({ page: MAX_DISCOVER_PAGE }));
  });
});

describe('the paging row', () => {
  /** Nothing to show when the whole result fits on one page. */
  it('is empty on a single page', () => {
    expect(discoverPageRow(filters(), false)).toEqual([]);
  });

  it('offers only «بعدی» on the first page of several', () => {
    const [row] = discoverPageRow(filters(), true);
    expect(row?.map((button) => button.text)).toEqual(['صفحهٔ ۱', 'بعدی ›']);
  });

  it('offers both ends in the middle', () => {
    const [row] = discoverPageRow(filters({ page: 2 }), true);
    expect(row?.map((button) => button.text)).toEqual(['‹ قبلی', 'صفحهٔ ۳', 'بعدی ›']);
  });

  it('drops «بعدی» on the last page', () => {
    const [row] = discoverPageRow(filters({ page: 2 }), false);
    expect(row?.map((button) => button.text)).toEqual(['‹ قبلی', 'صفحهٔ ۳']);
  });

  it('steps one page at a time, carrying every other filter', () => {
    const current = filters({ when: 'w', cost: 'f', categoryId: CATEGORY, page: 2 });
    const [row] = discoverPageRow(current, true);
    const [previous, , next] = row ?? [];

    expect(parseDiscoverCallback(previous?.callbackData ?? '')).toEqual({
      ...current,
      page: 1,
    });
    expect(parseDiscoverCallback(next?.callbackData ?? '')).toEqual({ ...current, page: 3 });
  });
});

/**
 * The interaction between paging and filtering, which is the one that goes wrong
 * quietly.
 *
 * Somebody on page four of «هر زمان» who taps «امروز» is asking a different
 * question. Answering it with page four of a two-page result is an empty screen
 * that reads as an empty city.
 */
describe('changing a filter while paged', () => {
  it('returns to the first page', () => {
    const rows = discoverFilterRows(filters({ page: 4 }));

    for (const row of rows) {
      for (const button of row) {
        expect(parseDiscoverCallback(button.callbackData)?.page).toBe(0);
      }
    }
  });
});

describe('what the digest says it is showing', () => {
  it('says nothing on an unfiltered first page', () => {
    expect(describeFilters(filters(), null)).toBe('');
  });

  /** So a page-three screen with four results does not read as a thin city. */
  it('names the page once there is one to name', () => {
    expect(describeFilters(filters({ page: 2 }), null)).toContain('صفحهٔ ۳');
  });
});
