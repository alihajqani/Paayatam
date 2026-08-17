import { toPersianDigits } from './fa';

/**
 * Jalali date and time rendering for the Mini App (ADR-0008).
 *
 * The API speaks ISO-8601 UTC and nothing else; Jalali exists on this side of the
 * wire only. Every function here takes an ISO string and returns Persian text.
 *
 * **No date library.** `Intl.DateTimeFormat` with the `persian` calendar is in every
 * engine a Telegram WebView runs on, and it does the calendar conversion and the
 * Tehran offset in one step. Adding a 20 kB library to reformat a timestamp would
 * come straight off the bundle budget ADR-0003 keeps for Iranian mobile networks.
 */

/** Storage is UTC everywhere; the product is Tehran-local at the display layer. */
const TEHRAN = 'Asia/Tehran';
const LOCALE = 'fa-IR-u-ca-persian';

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TEHRAN,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const dateWithYearFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TEHRAN,
  year: 'numeric',
  day: 'numeric',
  month: 'long',
});

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TEHRAN,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** «۵ شهریور» with its weekday — what a listing shows. */
export function formatEventDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** The same with the year, for anything more than a few months out. */
export function formatEventDateWithYear(iso: string): string {
  return dateWithYearFormatter.format(new Date(iso));
}

/** «۱۹:۳۰», Tehran time, 24-hour — Persian convention. */
export function formatEventTime(iso: string): string {
  return timeFormatter.format(new Date(iso));
}

/** Start and end on one line, collapsing the end when it is the same day. */
export function formatEventWhen(startsAt: string, endsAt: string): string {
  const start = `${formatEventDate(startsAt)}، ${formatEventTime(startsAt)}`;
  const sameDay = formatEventDate(startsAt) === formatEventDate(endsAt);
  return sameDay
    ? `${start} تا ${formatEventTime(endsAt)}`
    : `${start} تا ${formatEventDate(endsAt)}`;
}

/**
 * How far away it is, in words.
 *
 * Deliberately coarse. A countdown to the minute invites a user to treat it as
 * authoritative, and the only clock that decides anything in this product is the
 * server's (invariant 9) — this is orientation, not policy.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const deltaMs = new Date(iso).getTime() - now.getTime();
  const past = deltaMs < 0;
  const minutes = Math.floor(Math.abs(deltaMs) / 60_000);

  if (minutes < 1) return past ? 'همین حالا' : 'تا لحظه‌ای دیگر';
  if (minutes < 60) return withDirection(`${toPersianDigits(minutes)} دقیقه`, past);

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return withDirection(`${toPersianDigits(hours)} ساعت`, past);

  const days = Math.floor(hours / 24);
  if (days < 30) return withDirection(`${toPersianDigits(days)} روز`, past);

  const months = Math.floor(days / 30);
  return withDirection(`${toPersianDigits(months)} ماه`, past);
}

function withDirection(amount: string, past: boolean): string {
  return past ? `${amount} پیش` : `${amount} دیگر`;
}

/**
 * `datetime-local` input value → ISO-8601 UTC, reading the input as Tehran time.
 *
 * The input gives `YYYY-MM-DDTHH:mm` with no zone, and `new Date(value)` would read
 * it in *the device's* timezone — so a host travelling, or a phone set to UTC, would
 * file an event hours away from when they meant. The offset is derived from the date
 * itself rather than hardcoded, because Iran has used +03:30 and +04:30 historically
 * and a fixed constant silently rots.
 */
export function localInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;

  // Read the wall-clock fields as if they were UTC, then subtract Tehran's offset
  // at that instant to recover the true UTC time.
  const asUtc = new Date(`${value}:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return null;

  const offsetMinutes = tehranOffsetMinutes(asUtc);
  return new Date(asUtc.getTime() - offsetMinutes * 60_000).toISOString();
}

/** ISO-8601 UTC → the `datetime-local` value that shows the same Tehran wall clock. */
export function isoToLocalInput(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';

  const shifted = new Date(instant.getTime() + tehranOffsetMinutes(instant) * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/**
 * Tehran's offset from UTC at a given instant, in minutes.
 *
 * Asks `Intl` what the wall clock reads there and differences it, which is the only
 * way to get this right across a rule change without shipping a tz database.
 */
function tehranOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TEHRAN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24,
    field('minute'),
    field('second'),
  );

  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** The soonest a host may file something, as a `datetime-local` value. */
export function nowAsLocalInput(offsetMinutes = 0): string {
  return isoToLocalInput(new Date(Date.now() + offsetMinutes * 60_000).toISOString());
}
