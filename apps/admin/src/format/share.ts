import { toPersianDigits } from './fa';

/**
 * `۲۵٪` — a part as a whole-number share of its whole.
 *
 * «—» when the whole is zero. A share of nothing is not zero percent, and
 * printing «۰٪» there would say "none of them did" about a group with nobody
 * in it.
 */
export function share(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${toPersianDigits(Math.round((part / whole) * 100))}٪`;
}
