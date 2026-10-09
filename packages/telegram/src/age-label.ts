import { toPersianDigits } from './escape';

/**
 * «، ۲۸ ساله» after a name, or nothing (v0.24.0, ADR-0021).
 *
 * One helper for the three places a counterpart is named (the activity page,
 * the host's guest list, the join-request notice), so the three cannot drift
 * into three spellings of the same fact.
 *
 * Nothing rather than a guess for a missing year (an anonymised profile) or a
 * value no birth year can produce. Zero and negatives come from a garbled
 * payload, and «۰ ساله» would read as a bug about a real person.
 */
export function ageSuffix(age: unknown): string {
  if (typeof age !== 'number' || !Number.isInteger(age) || age <= 0 || age > 120) return '';
  return `، ${toPersianDigits(String(age))} ساله`;
}
