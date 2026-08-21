/**
 * View-layer Persian formatting.
 *
 * Every internal value stays Latin — sorting, arithmetic and equality all depend
 * on it — and Persian digits are produced here, at the edge (glossary §5). The
 * Mini App has the same rule and its own copy for the same reason: the two
 * bundles share `@payetam/shared` for *contracts*, and a formatting helper is not
 * a contract.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

export function toPersianDigits(value: number | string): string {
  return String(value).replaceAll(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** `۱۲٬۳۴۵` — grouped, Persian, no unit. The caller adds «سکه» or «تومان». */
export function formatNumber(value: number): string {
  return toPersianDigits(value.toLocaleString('en-US')).replaceAll(',', '٬');
}

/** A signed amount, so a ledger row reads as a movement rather than as a total. */
export function formatSigned(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value);
}

/**
 * A Jalali date and time, computed with `Intl` and no date library (ADR-0008).
 *
 * The API speaks ISO-8601 UTC exclusively, and this is the only place that
 * becomes something a person reads. `Asia/Tehran` explicitly rather than the
 * browser's zone: a moderator working from anywhere must see the same clock the
 * policy engine used.
 */
const DATE_TIME = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Tehran',
});

const DATE_ONLY = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  dateStyle: 'medium',
  timeZone: 'Asia/Tehran',
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_TIME.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DATE_ONLY.format(date);
}

/** «۳ روز پیش». Relative, because a queue is read by how stale its top is. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const seconds = Math.round((Date.now() - then) / 1000);
  const future = seconds < 0;
  const magnitude = Math.abs(seconds);

  const [amount, unit] =
    magnitude < 60
      ? [magnitude, 'ثانیه']
      : magnitude < 3600
        ? [Math.round(magnitude / 60), 'دقیقه']
        : magnitude < 86_400
          ? [Math.round(magnitude / 3600), 'ساعت']
          : [Math.round(magnitude / 86_400), 'روز'];

  return future
    ? `${toPersianDigits(amount)} ${unit} دیگر`
    : `${toPersianDigits(amount)} ${unit} پیش`;
}

/**
 * A Trust Score, or «تازه‌وارد» when there is none.
 *
 * **Null is not zero** (ADR-0014): the row is written lazily by the first
 * movement, so an account that has done nothing has none — and 0 is the worst
 * possible reputation to show somebody who has earned no reputation at all.
 */
export function formatTrust(score: number | null): string {
  return score === null ? 'تازه‌وارد' : `${toPersianDigits(score)} از ۱۰۰`;
}
