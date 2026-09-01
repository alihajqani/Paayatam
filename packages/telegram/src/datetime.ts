import { formatJalali, formatJalaliTime } from './wizard/jalali';

/**
 * A moment, in Tehran, in the Persian calendar and in Persian digits.
 *
 * Formatted here rather than stored: the database holds UTC and the reader lives
 * in Tehran (D12, ADR-0008).
 *
 * ── Why this is Jalali now, when it was Gregorian ───────────────────────────
 *
 * The old note said: *"`Intl` has no Persian calendar formatter available in
 * every Node build, and a wrong date in a public channel is worse than a
 * Gregorian one. The Mini App renders Jalali."* Both halves of that have since
 * expired, and `wizard/jalali.ts` retired them one at a time — `node:22-alpine`,
 * which is what this repository builds and ships, carries full ICU and formats
 * `fa-IR-u-ca-persian` correctly, and the Mini App is being retired (ADR-0017)
 * so it is no longer the surface where a Persian reader sees a Persian date.
 *
 * What the old behaviour actually produced was the worst of both calendars, and
 * `events-digest.ts` had already caught it once: «۰۷/۰۹/۲۰۲۶، ۱۲:۰۰» is a
 * Gregorian date wearing Persian digits, so a Persian reader has to convert it
 * *and* the digits stop them recognising that it needs converting. Every surface
 * that formats a date for a user had migrated to `formatJalali` except the three
 * that come through here — channel posts, paid invitations, and the moderation
 * case digest — which are, between them, the most public dates the product
 * writes.
 *
 * ── Why it stays one function ───────────────────────────────────────────────
 *
 * It is `formatJalali` and `formatJalaliTime` joined by an em dash, which is the
 * shape every other digest already writes by hand. Keeping the composition here
 * rather than expanding it at three call sites is what stopped the three
 * byte-identical copies this function was extracted from coming back.
 */
export function formatTehran(date: Date): string {
  return `${formatJalali(date)} — ${formatJalaliTime(date)}`;
}
