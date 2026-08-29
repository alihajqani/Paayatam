import { toPersianDigits } from '../escape';

/**
 * The Persian calendar, via ICU rather than by hand.
 *
 * ── Why this exists now ──────────────────────────────────────────────────────
 *
 * `formatTehran` renders Gregorian and says why: *"`Intl` has no Persian calendar
 * formatter available in every Node build, and a wrong date in a public channel
 * is worse than a Gregorian one. The Mini App renders Jalali."* Both halves of
 * that have changed. The Mini App is being retired (ADR-0017), so it is no longer
 * the surface where a Persian user sees a Persian date — and `node:22-alpine`,
 * which is what this repository actually builds and ships, carries full ICU:
 * `fa-IR-u-ca-persian` formats «۱۵ شهریور ۱۴۰۵` in the production image. Verified
 * in the image, not assumed from the host.
 *
 * A date picker is the one place the calendar cannot be fudged. Asking somebody
 * to choose «6 September» for an event they think of as «۱۵ شهریور» is asking
 * them to do the conversion the software refused to.
 *
 * ── Why no reverse conversion ────────────────────────────────────────────────
 *
 * Jalali→Gregorian is where hand-written implementations get leap years wrong.
 * Nothing here needs it: the grid is *walked* in Gregorian and *labelled* in
 * Jalali, so every cell already knows the Gregorian date it stands for and the
 * button carries that. ICU is only ever asked the direction it is good at.
 */

/** Tehran has had no DST since 2022, but noon is used as the probe regardless. */
const PROBE_HOUR_UTC = 8;

const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const monthName = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  month: 'long',
});

export interface JalaliDate {
  year: number;
  month: number;
  day: number;
}

/** The Jalali year, month and day a Gregorian instant falls on, in Tehran. */
export function toJalali(date: Date): JalaliDate {
  const found = parts.formatToParts(date);
  const read = (type: string): number => {
    const value = found.find((part) => part.type === type)?.value ?? '';
    // The Persian calendar's era can render the year as "1405 AP"; take digits.
    return Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
  };

  return { year: read('year'), month: read('month'), day: read('day') };
}

/** «شهریور», for a heading. */
export function jalaliMonthName(date: Date): string {
  return monthName.format(date);
}

/** «۱۵ شهریور ۱۴۰۵» — a whole date, as a Persian reader writes it. */
export function formatJalali(date: Date): string {
  const { year, day } = toJalali(date);
  return `${toPersianDigits(String(day))} ${jalaliMonthName(date)} ${toPersianDigits(String(year))}`;
}

/** Midnight Tehran, as the UTC instant the day is anchored on. */
function dayAt(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, PROBE_HOUR_UTC, 0, 0, 0));
}

/** The same instant, `days` later. Arithmetic on the probe, never on a local wall clock. */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Today in Tehran, anchored at the probe hour. */
export function tehranToday(now: Date): Date {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = iso.split('-').map((part) => Number.parseInt(part, 10)) as [
    number,
    number,
    number,
  ];
  return dayAt(y, m - 1, d);
}

/**
 * Every Gregorian day belonging to the Jalali month that `anchor` falls in.
 *
 * Found by walking rather than by converting: step back while the Jalali day
 * number decreases to reach the first, then forward while the Jalali month stays
 * the same. Thirty-odd `Intl` calls per render, which is nothing beside the
 * network round-trip that follows, and it cannot get a leap year wrong because it
 * never computes one.
 */
export function jalaliMonthDays(anchor: Date): Date[] {
  let first = anchor;
  while (toJalali(first).day > 1) first = addDays(first, -1);

  const month = toJalali(first).month;
  const days: Date[] = [];
  let cursor = first;
  while (toJalali(cursor).month === month) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    // A Jalali month is 29–31 days; the guard is against a formatter that
    // stopped agreeing with itself rather than against a real calendar.
    if (days.length > 31) break;
  }
  return days;
}

/** A day in the Jalali month after the one `anchor` is in, for «ماه بعد». */
export function nextJalaliMonth(anchor: Date): Date {
  const days = jalaliMonthDays(anchor);
  return addDays(days[days.length - 1] as Date, 1);
}

/** A day in the Jalali month before it, for «ماه قبل». */
export function previousJalaliMonth(anchor: Date): Date {
  const days = jalaliMonthDays(anchor);
  return addDays(days[0] as Date, -1);
}

/**
 * Which column a date sits in, with **Saturday as 0**.
 *
 * The Persian week begins on شنبه. Rendering a grid that starts on Monday would
 * put every date under the wrong heading — the kind of error that looks like a
 * styling detail and is actually a wrong date.
 */
export function persianWeekday(date: Date): number {
  return (date.getUTCDay() + 1) % 7;
}

/** شنبه … جمعه, in grid order. */
export const PERSIAN_WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'] as const;

/** `2026-09-06` — what a day button carries, and what the step parses back. */
export function isoDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** The instant a picked `YYYY-MM-DD` stands for, or null if it is not one. */
export function parseIsoDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const [, y, m, d] = match as unknown as [string, string, string, string];
  const date = dayAt(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}
