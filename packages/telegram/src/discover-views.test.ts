import { describe, expect, it } from 'vitest';
import {
  encodeBackCallback,
  parseBackCallback,
  parseDiscoverCallback,
  type DiscoverFilters,
} from './callback-data';
import { activeFilterCount, discoverFilterPanelRows, discoverListRows } from './discover-filters';

const CATEGORY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function filters(overrides: Partial<DiscoverFilters> = {}): DiscoverFilters {
  return { when: 'a', cost: 'a', categoryId: null, page: 0, view: 'l', ...overrides };
}

const labels = (rows: { text: string }[][]): string[] => rows.flat().map((b) => b.text);

/**
 * One message with two faces: the numbered list, and the panel that filters it.
 *
 * Six filter rows and five activities do not fit on a phone together, and the
 * list is what somebody came for — so the panel is behind a button and opens in
 * place, exactly as an anonymous-chat bot does it.
 */
describe('the list view', () => {
  it('offers a way into the filters', () => {
    const rows = discoverListRows(filters(), false, 0);
    const opener = rows.flat().find((button) => button.text.includes('فیلترها'));

    expect(opener).toBeDefined();
    expect(parseDiscoverCallback(opener?.callbackData ?? '')?.view).toBe('f');
  });

  /** A count, so the button is not a mystery box once something is narrowing. */
  it('says how many filters are in force', () => {
    expect(labels(discoverListRows(filters(), false, 0))).toContain('⚙️ فیلترها');
    expect(labels(discoverListRows(filters(), false, 2))).toContain('⚙️ فیلترها (۲)');
  });

  it('carries the paging row above it when there is more than one page', () => {
    const rows = discoverListRows(filters(), true, 0);

    expect(labels(rows)).toContain('بعدی ›');
    // Paging first: the reader's next move on a list is usually another page.
    expect(rows[0]?.some((button) => button.text.includes('صفحهٔ'))).toBe(true);
  });

  it('counts only the filters that narrow anything', () => {
    expect(activeFilterCount(filters())).toBe(0);
    expect(activeFilterCount(filters({ when: 't' }))).toBe(1);
    expect(activeFilterCount(filters({ when: 't', cost: 'f', categoryId: CATEGORY }))).toBe(3);
  });
});

describe('the filter panel', () => {
  const categories = [{ id: CATEGORY, label: 'ورزش' }];

  /**
   * A screen you can open and not close is one whose only exit is re-running the
   * command that drew it — which loses the page the reader was on.
   */
  it('always offers the way back to the list', () => {
    const rows = discoverFilterPanelRows(filters({ view: 'f' }), categories);
    const back = rows.flat().find((button) => button.text.includes('بازگشت'));

    expect(back).toBeDefined();
    expect(parseDiscoverCallback(back?.callbackData ?? '')?.view).toBe('l');
  });

  /**
   * Narrowing a search is two or three taps, and being thrown back to the list
   * after each one would make the third a navigation problem.
   */
  it('stays in the panel when a filter is applied', () => {
    const rows = discoverFilterPanelRows(filters({ view: 'f' }), categories);

    for (const button of rows.flat()) {
      const decoded = parseDiscoverCallback(button.callbackData);
      if (decoded === null) continue;
      if (button.text.includes('بازگشت')) continue;
      expect(decoded.view, button.text).toBe('f');
    }
  });

  it('keeps the page the reader was on when they open and close the panel', () => {
    const [opener] = discoverListRows(filters({ page: 3 }), false, 0)
      .flat()
      .filter((button) => button.text.includes('فیلترها'));
    const opened = parseDiscoverCallback(opener?.callbackData ?? '');

    expect(opened?.page).toBe(3);
  });
});

/**
 * «بازگشت به فهرست» from an activity: the detail message and the `/event_…` that
 * opened it both go, so the list is the last thing in the chat again.
 */
describe('the back-to-list button', () => {
  it('round-trips the message it has to delete', () => {
    expect(parseBackCallback(encodeBackCallback('d', 4321))).toEqual({
      target: 'd',
      commandMessageId: 4321,
    });
  });

  /** No command to tidy — a deep link out of the channel, say — is null, not zero. */
  it('tells "no message" apart from message zero', () => {
    expect(parseBackCallback(encodeBackCallback('d', null))).toEqual({
      target: 'd',
      commandMessageId: null,
    });
    expect(parseBackCallback('bk:d:0')?.commandMessageId).toBeNull();
  });

  it('fails the parse for a tampered or foreign payload', () => {
    expect(parseBackCallback('bk:x:1')).toBeNull();
    expect(parseBackCallback('bk:d:-1')).toBeNull();
    expect(parseBackCallback('bk:d:abc')).toBeNull();
    expect(parseBackCallback('dc:aa0l:all')).toBeNull();
  });

  it('stays inside Telegram’s 64 bytes', () => {
    const widest = encodeBackCallback('d', 2_147_483_647);
    expect(Buffer.byteLength(widest, 'utf8')).toBeLessThanOrEqual(64);
  });
});
