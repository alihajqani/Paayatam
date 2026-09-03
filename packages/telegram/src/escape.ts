/**
 * HTML escaping for Telegram message bodies (T9).
 *
 * Telegram's `parse_mode: 'HTML'` gives bold, italics and links — and with them a
 * markup injection point on every user-authored value the product renders: an
 * event title, a display name, a review comment. A title of
 * `<a href="http://evil">click</a>` would otherwise arrive as a working link in a
 * message the platform appears to have written.
 *
 * Telegram's own documentation lists exactly three characters that must be
 * escaped inside an HTML message: `<`, `>` and `&`. Quotes matter only inside a
 * tag attribute, and nothing here builds one from user input — every `href` in
 * this package is a constant or a `t.me` link built from an internal id.
 *
 * Deliberately a plain function with its own test rather than a template helper:
 * every user value passes through it, and the plan asks for it to be unit-tested
 * precisely because "we remember to escape" is not a control.
 */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Latin digits → Persian, for numbers a user reads.
 *
 * Only at the point of rendering. Internal values stay Latin everywhere else
 * (ADR-0003), because a Persian-digit id is an id that does not round-trip.
 */
const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function toPersianDigits(value: number | string): string {
  return String(value).replaceAll(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/**
 * A price, grouped in threes, in Persian digits.
 *
 * «۲۵۰۰۰۰ تومان» is six digits somebody has to count. Toman figures in this
 * product run to seven and eight digits, and an ungrouped one is read wrong more
 * often than it is read slowly — which on a channel post is a reader deciding
 * whether they can afford an evening.
 *
 * The separator is a plain comma rather than the Arabic thousands separator
 * (U+066C): Telegram's client fonts render the latter inconsistently, and a
 * separator that sometimes disappears is worse than one that is merely not
 * local.
 */
export function toPersianAmount(value: number): string {
  return toPersianDigits(
    Math.trunc(value)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ','),
  );
}
