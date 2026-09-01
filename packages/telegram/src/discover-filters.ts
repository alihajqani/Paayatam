import { encodeDiscoverCallback, type DiscoverFilters } from './callback-data';
import { toPersianDigits } from './escape';

/**
 * The filter row under `/discover` (v0.5.9).
 *
 * ── Every button carries the whole query ────────────────────────────────────
 *
 * A filter button is not "add this to what you remember about me" — the bot
 * remembers nothing — it is "run *this* search". So each one encodes the
 * complete filter set it would produce, which is what lets a stateless handler
 * offer a stateful-feeling control, and what makes a button in a three-day-old
 * message still do exactly what its label says.
 *
 * ── Why the active one is marked rather than removed ────────────────────────
 *
 * A toggle that disappears when it is on leaves somebody unable to see what they
 * asked for. «✅» in front of the active choice, and tapping it again is what
 * clears it — the button that turned a filter on is the button that turns it
 * off, which is the only arrangement nobody has to be taught.
 */
export interface FilterButton {
  text: string;
  callbackData: string;
}

/** The label for a choice, marked when it is the one in force. */
function mark(active: boolean, label: string): string {
  return active ? `✅ ${label}` : label;
}

/**
 * Two rows: when, and how much.
 *
 * The category is not here — it is a list of fourteen and belongs on its own
 * screen, reached by the last button.
 */
export function discoverFilterRows(current: DiscoverFilters): FilterButton[][] {
  /**
   * Every filter change goes back to the first page.
   *
   * Not carrying the page forward is the whole point: somebody on page four of
   * «هر زمان» who taps «امروز» is asking a different question, and answering it
   * with page four of a two-page result is an empty screen that looks like an
   * empty city.
   */
  const withWhen = (when: DiscoverFilters['when']): string =>
    encodeDiscoverCallback({ ...current, when, page: 0 });
  const withCost = (cost: DiscoverFilters['cost']): string =>
    encodeDiscoverCallback({ ...current, cost, page: 0 });

  return [
    [
      { text: mark(current.when === 'a', '🗓 هر زمان'), callbackData: withWhen('a') },
      { text: mark(current.when === 't', '☀️ امروز'), callbackData: withWhen('t') },
      { text: mark(current.when === 'w', '📅 این هفته'), callbackData: withWhen('w') },
    ],
    [
      { text: mark(current.cost === 'a', '💵 هر هزینه'), callbackData: withCost('a') },
      { text: mark(current.cost === 'f', '🆓 رایگان'), callbackData: withCost('f') },
    ],
  ];
}

/**
 * The category row, built from the live catalogue.
 *
 * «همه» first and marked when nothing is chosen, so clearing a category is the
 * same gesture as choosing one. Three per row: category names are short and a
 * column of fourteen would bury the events the filters are for.
 */
export function discoverCategoryRows(
  current: DiscoverFilters,
  categories: readonly { id: string; label: string }[],
): FilterButton[][] {
  const buttons: FilterButton[] = [
    {
      text: mark(current.categoryId === null, 'همه'),
      callbackData: encodeDiscoverCallback({ ...current, categoryId: null, page: 0 }),
    },
    ...categories.map((category) => ({
      text: mark(current.categoryId === category.id, category.label),
      callbackData: encodeDiscoverCallback({ ...current, categoryId: category.id, page: 0 }),
    })),
  ];

  const rows: FilterButton[][] = [];
  for (let index = 0; index < buttons.length; index += 3) {
    rows.push(buttons.slice(index, index + 3));
  }
  return rows;
}

/**
 * The two controls a **list** carries: paging, and the way into the filters.
 *
 * ── Why the filters are not on the list ─────────────────────────────────────
 *
 * Six filter rows and five activities do not fit on a phone together, and the
 * list is what somebody came for — so the panel is one button away and opens *in
 * place*. `discoverPageRow` still produces the paging row; this stacks the
 * opener under it, and names how many filters are in force so the button is not
 * a mystery box.
 */
export function discoverListRows(
  current: DiscoverFilters,
  hasNext: boolean,
  activeFilters: number,
): FilterButton[][] {
  return [
    ...discoverPageRow(current, hasNext),
    [
      {
        text:
          activeFilters === 0
            ? '⚙️ فیلترها'
            : `⚙️ فیلترها (${toPersianDigits(String(activeFilters))})`,
        callbackData: encodeDiscoverCallback({ ...current, view: 'f' }),
      },
    ],
  ];
}

/**
 * The filter **panel**: every choice, and the way back to what it filters.
 *
 * The back button is not optional, and it is the same argument the command
 * menu's is: a screen you can open and not close is one whose only exit is
 * re-running the command that drew it, which loses the page the reader was on.
 *
 * Applying a filter stays in the panel — `withWhen` and the rest keep `view: 'f'`
 * — because narrowing a search is usually two or three taps, and being thrown
 * back to the list after each one would make the third tap a navigation problem.
 * The counts in the list button are what the reader checks against; «بازگشت» is
 * when they are done.
 */
export function discoverFilterPanelRows(
  current: DiscoverFilters,
  categories: readonly { id: string; label: string }[],
): FilterButton[][] {
  return [
    ...discoverFilterRows(current),
    ...discoverCategoryRows(current, categories),
    [
      {
        text: '‹ بازگشت به فهرست',
        callbackData: encodeDiscoverCallback({ ...current, view: 'l' }),
      },
    ],
  ];
}

/** How many of the three filters are narrowing the search, for the panel's label. */
export function activeFilterCount(current: DiscoverFilters): number {
  return (
    (current.when === 'a' ? 0 : 1) +
    (current.cost === 'a' ? 0 : 1) +
    (current.categoryId === null ? 0 : 1)
  );
}

/**
 * «قبلی · صفحهٔ ۲ · بعدی», or nothing when the whole list fits on one page.
 *
 * ── Why the page number is a button and not text ────────────────────────────
 *
 * It is not a button — it is a *label* rendered as one, and tapping it re-runs
 * the page it is already on. Telegram has no other way to put a word in the
 * middle of a keyboard row, and the alternative of putting «صفحهٔ ۲ از ۵» in the
 * body means the position moves as the digest grows and shrinks. Re-running the
 * current page is a harmless no-op, which is the property that makes a decorative
 * button acceptable at all.
 *
 * ── Why «بعدی» is decided by a peek rather than by a count ──────────────────
 *
 * The caller asks for one more row than it renders. A `COUNT(*)` over the whole
 * filtered set is a second query on every tap to produce a number nobody reads,
 * and it goes stale between the count and the page anyway. Whether one more row
 * exists is the only fact «بعدی» needs.
 */
export function discoverPageRow(current: DiscoverFilters, hasNext: boolean): FilterButton[][] {
  if (current.page === 0 && !hasNext) return [];

  const row: FilterButton[] = [];
  if (current.page > 0) {
    row.push({
      text: '‹ قبلی',
      callbackData: encodeDiscoverCallback({ ...current, page: current.page - 1 }),
    });
  }
  row.push({
    text: `صفحهٔ ${toPersianDigits(String(current.page + 1))}`,
    callbackData: encodeDiscoverCallback(current),
  });
  if (hasNext) {
    row.push({
      text: 'بعدی ›',
      callbackData: encodeDiscoverCallback({ ...current, page: current.page + 1 }),
    });
  }

  return [row];
}

/** What the digest says it is showing, so a filtered list never looks like an empty city. */
export function describeFilters(current: DiscoverFilters, categoryLabel: string | null): string {
  const parts: string[] = [];
  if (current.when === 't') parts.push('امروز');
  if (current.when === 'w') parts.push('این هفته');
  if (current.cost === 'f') parts.push('رایگان');
  if (categoryLabel !== null) parts.push(categoryLabel);
  if (current.page > 0) parts.push(`صفحهٔ ${toPersianDigits(String(current.page + 1))}`);

  return parts.length === 0 ? '' : `\n\n<i>فیلترها: ${parts.join(' · ')}</i>`;
}
