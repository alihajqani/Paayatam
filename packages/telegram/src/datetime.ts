import { toPersianDigits } from './escape';

/**
 * A moment, in Tehran, in Persian digits.
 *
 * Formatted here rather than stored: the database holds UTC and the reader lives
 * in Tehran (D12, ADR-0008).
 *
 * **Gregorian rather than Jalali, deliberately.** `Intl` has no Persian calendar
 * formatter available in every Node build, and a wrong date in a public channel
 * is worse than a Gregorian one. The Mini App renders Jalali, where the
 * conversion is done properly and can be tested against a real calendar.
 *
 * Extracted from `channel.ts` and `invitation.ts`, which held byte-identical
 * copies. A third caller (`/requests` in the bot) is what made the duplication
 * worth removing: three copies of a date format is three chances for one of them
 * to drift into a different timezone.
 */
export function formatTehran(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return toPersianDigits(parts);
}
