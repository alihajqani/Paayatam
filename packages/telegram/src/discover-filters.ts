import { encodeDiscoverCallback, type DiscoverFilters } from './callback-data';

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
  const withWhen = (when: DiscoverFilters['when']): string =>
    encodeDiscoverCallback({ ...current, when });
  const withCost = (cost: DiscoverFilters['cost']): string =>
    encodeDiscoverCallback({ ...current, cost });

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
      callbackData: encodeDiscoverCallback({ ...current, categoryId: null }),
    },
    ...categories.map((category) => ({
      text: mark(current.categoryId === category.id, category.label),
      callbackData: encodeDiscoverCallback({ ...current, categoryId: category.id }),
    })),
  ];

  const rows: FilterButton[][] = [];
  for (let index = 0; index < buttons.length; index += 3) {
    rows.push(buttons.slice(index, index + 3));
  }
  return rows;
}

/** What the digest says it is showing, so a filtered list never looks like an empty city. */
export function describeFilters(current: DiscoverFilters, categoryLabel: string | null): string {
  const parts: string[] = [];
  if (current.when === 't') parts.push('امروز');
  if (current.when === 'w') parts.push('این هفته');
  if (current.cost === 'f') parts.push('رایگان');
  if (categoryLabel !== null) parts.push(categoryLabel);

  return parts.length === 0 ? '' : `\n\n<i>فیلترها: ${parts.join(' · ')}</i>`;
}
