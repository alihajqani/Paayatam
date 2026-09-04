import { toPersianDigits } from '../escape';
import type { InlineButton, InlineKeyboard } from '../keyboards';
import { encodeWizardCallback } from './callback';
import {
  PERSIAN_WEEKDAYS,
  addDays,
  isoDay,
  jalaliMonthDays,
  jalaliMonthName,
  persianWeekday,
  toJalali,
} from './jalali';

/** One selectable option: what the user reads, and what the button carries. */
export interface Choice {
  /** The value encoded into `callback_data`; must satisfy the codec's charset. */
  value: string;
  label: string;
}

/**
 * Telegram renders inline keyboards comfortably up to about a hundred buttons,
 * but a *reader* gives up long before that. Twenty-four is four pages of the
 * 1252 cities and one page of the thirty-one provinces.
 */
export const CHOICES_PER_PAGE = 24;

const COLUMNS = 3;

/**
 * A paged list of options, two or three to a row.
 *
 * ── Why paged rather than truncated ──────────────────────────────────────────
 *
 * Tehran province alone has more cities than fits in a message, and a list that
 * silently stops at twenty is a list that cannot express where somebody lives.
 * Paging keeps every option reachable; the alternative people reach for — asking
 * the user to type the city name — turns a bounded choice into free text that has
 * to be matched against 1252 names and rejected in Persian when it does not
 * match. Inline keyboards make the invalid state unrepresentable, which is worth
 * the paging code.
 *
 * The page number rides in a `page` control rather than in each option, so an
 * option's callback stays `wz:<step>:<value>` and inside 64 bytes.
 */
export function choiceKeyboard(
  step: string,
  choices: readonly Choice[],
  page: number,
  trailer: readonly InlineButton[] = [],
): InlineKeyboard {
  const pages = Math.max(Math.ceil(choices.length / CHOICES_PER_PAGE), 1);
  const current = Math.min(Math.max(page, 0), pages - 1);
  const slice = choices.slice(current * CHOICES_PER_PAGE, (current + 1) * CHOICES_PER_PAGE);

  const rows: InlineButton[][] = [];
  for (let i = 0; i < slice.length; i += COLUMNS) {
    rows.push(
      slice.slice(i, i + COLUMNS).map((choice) => ({
        text: choice.label,
        callbackData: encodeWizardCallback({ action: step, value: choice.value }),
      })),
    );
  }

  if (pages > 1) {
    /**
     * RTL: «بعدی» is on the left of the row as Telegram lays it out, because the
     * reader's "forward" is leftward. The counter sits between them so the row
     * reads as one control rather than two unrelated arrows.
     */
    const nav: InlineButton[] = [];
    if (current + 1 < pages) {
      nav.push({
        text: '» بعدی',
        callbackData: encodeWizardCallback({ action: 'page', value: String(current + 1) }),
      });
    }
    nav.push({
      text: `${toPersianDigits(String(current + 1))} از ${toPersianDigits(String(pages))}`,
      // A label, not a control. Telegram requires callback_data on every
      // non-URL button, so it answers with the page it is already on.
      callbackData: encodeWizardCallback({ action: 'page', value: String(current) }),
    });
    if (current > 0) {
      nav.push({
        text: 'قبلی «',
        callbackData: encodeWizardCallback({ action: 'page', value: String(current - 1) }),
      });
    }
    rows.push(nav);
  }

  if (trailer.length > 0) rows.push([...trailer]);
  return rows;
}

/**
 * A paged list of options where several can be chosen at once (v0.8.1).
 *
 * ── Why this could not be `choiceKeyboard` with a flag ──────────────────────
 *
 * Because the *interaction* differs, not the layout. A `choice` tap is an answer
 * and advances the wizard; a `multi` tap is a toggle and redraws the same step
 * with one more (or one fewer) tick on it. What is here is the drawing half of
 * that: a selected option carries a tick and an unselected one does not, so the
 * keyboard **is** the state — there is no separate list of what has been chosen
 * to read, and no way for the two to disagree.
 *
 * ── Why «تمام» is a row of its own ─────────────────────────────────────────
 *
 * A step whose answers do not advance it needs something that does, and it has to
 * be unmissable: a «تمام» tucked next to «انصراف» is a step people get stuck on.
 * It sits above the controls, alone, and says how many are chosen — which is the
 * one fact the ticks do not give you at a glance when the options run to a second
 * page.
 *
 * The tick is prefixed rather than appended because Persian is RTL and a leading
 * emoji lands on the *right*, where the eye starts.
 */
export function multiChoiceKeyboard(
  step: string,
  choices: readonly Choice[],
  selected: readonly string[],
  page: number,
  trailer: readonly InlineButton[] = [],
): InlineKeyboard {
  const chosen = new Set(selected);
  const ticked = choices.map((choice) => ({
    value: choice.value,
    label: chosen.has(choice.value) ? `✅ ${choice.label}` : choice.label,
  }));

  /**
   * The page row and the option grid come from `choiceKeyboard`, unchanged.
   *
   * Reused rather than reimplemented: paging is the part that took the argument
   * about Tehran's 1252 cities to get right, and a second copy of it would be a
   * second thing to get wrong. The trailer is appended here instead so «تمام» can
   * be slotted between the options and the controls.
   */
  const rows = [
    ...choiceKeyboard(step, ticked, page),
    [
      {
        text:
          chosen.size === 0
            ? '✔️ تمام'
            : `✔️ تمام (${toPersianDigits(String(chosen.size))} انتخاب)`,
        callbackData: encodeWizardCallback({ action: 'done', value: '' }),
      },
    ],
  ];

  if (trailer.length > 0) rows.push([...trailer]);
  return rows;
}

/** A blank cell. Telegram needs `callback_data` on every non-URL button. */
function filler(): InlineButton {
  return { text: ' ', callbackData: encodeWizardCallback({ action: 'page', value: '0' }) };
}

/**
 * A month of days, as a Persian calendar.
 *
 * ── The grid ────────────────────────────────────────────────────────────────
 *
 * Seven columns beginning on **شنبه**, one row of weekday initials, then the
 * days of one Jalali month with the first day indented into its true column.
 * Cells are labelled with the Jalali day number and carry the *Gregorian* ISO
 * date, so nothing downstream has to convert back — the direction ICU is bad at
 * is never asked for.
 *
 * ── What is not offered ─────────────────────────────────────────────────────
 *
 * Days before `earliest` render as blanks rather than as buttons. An event
 * cannot start in the past, and a disabled-looking button that silently does
 * nothing is worse than an empty square: the user presses it twice before
 * concluding the bot is broken.
 */
export function calendarKeyboard(
  step: string,
  anchor: Date,
  earliest: Date,
  trailer: readonly InlineButton[] = [],
): InlineKeyboard {
  const days = jalaliMonthDays(anchor);
  const first = days[0] as Date;

  const rows: InlineButton[][] = [
    PERSIAN_WEEKDAYS.map((label) => ({
      text: label,
      callbackData: encodeWizardCallback({ action: 'page', value: '0' }),
    })),
  ];

  const weeks: InlineButton[][] = [];
  let row: InlineButton[] = [];
  for (let column = 0; column < persianWeekday(first); column += 1) row.push(filler());

  for (const day of days) {
    row.push(
      day.getTime() < earliest.getTime()
        ? filler()
        : {
            text: toPersianDigits(String(toJalali(day).day)),
            callbackData: encodeWizardCallback({ action: step, value: isoDay(day) }),
          },
    );
    if (row.length === 7) {
      weeks.push(row);
      row = [];
    }
  }
  if (row.length > 0) {
    while (row.length < 7) row.push(filler());
    weeks.push(row);
  }

  /**
   * Drop whole weeks that are entirely in the past.
   *
   * Looking at the current month on the 7th, the first row is seven blanks — a
   * row of dead squares above the days somebody can actually pick. It is not
   * merely ugly: an inline keyboard is a tap target, and a row that answers
   * nothing teaches the reader that this keyboard has parts that do not work.
   *
   * Only *leading* weeks are dropped, and only when nothing in them is
   * selectable. A gap in the middle of a month cannot happen — `earliest` moves
   * forward, never in and out.
   */
  const hasDay = (week: readonly InlineButton[]): boolean =>
    week.some((button) => button.callbackData?.startsWith(`wz:${step}:`) === true);
  while (weeks.length > 0 && !hasDay(weeks[0] as InlineButton[])) weeks.shift();
  rows.push(...weeks);

  /**
   * The heading row is last so the month name sits directly above the trailer
   * rather than scrolling away above six rows of numbers — and it is a row of
   * controls, so «ماه بعد» is where a thumb already is.
   */
  const previousAnchor = addDays(first, -1);
  const nav: InlineButton[] = [
    {
      text: '» ماه بعد',
      callbackData: encodeWizardCallback({
        action: 'goto',
        value: isoDay(addDays(days[days.length - 1] as Date, 1)),
      }),
    },
    {
      text: jalaliMonthName(first),
      callbackData: encodeWizardCallback({ action: 'page', value: '0' }),
    },
  ];
  // Offered only when there is a reachable day behind it.
  if (previousAnchor.getTime() >= earliest.getTime()) {
    nav.push({
      text: 'ماه قبل «',
      callbackData: encodeWizardCallback({ action: 'goto', value: isoDay(previousAnchor) }),
    });
  }
  rows.push(nav);

  if (trailer.length > 0) rows.push([...trailer]);
  return rows;
}

/** «بازگشت», «رد کردن», «انصراف» — the controls a step offers beneath its options. */
export function controlRow(options: {
  back?: boolean;
  skip?: boolean;
  cancel?: boolean;
}): InlineButton[] {
  const row: InlineButton[] = [];
  if (options.cancel === true) {
    row.push({
      text: '✖️ انصراف',
      callbackData: encodeWizardCallback({ action: 'cancel', value: '' }),
    });
  }
  if (options.skip === true) {
    row.push({
      text: 'رد کردن',
      callbackData: encodeWizardCallback({ action: 'skip', value: '' }),
    });
  }
  if (options.back === true) {
    row.push({
      text: '« بازگشت',
      callbackData: encodeWizardCallback({ action: 'back', value: '' }),
    });
  }
  return row;
}
