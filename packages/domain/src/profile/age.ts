/**
 * The 18+ gate.
 *
 * Pure, and separate from `ProfileService`, for the same reason `InitDataValidator`
 * is: this is a legal rule, it is worth testing exhaustively around its boundary,
 * and doing that should not require a database.
 */

/**
 * Re-exported so the age rules read as one unit.
 *
 * The implementation lives in `../time` because event quotas and the M10
 * cancellation thresholds need the same timezone arithmetic, and two copies of
 * "what year/day is it in Tehran" would eventually disagree — which for a legal
 * question is the worst possible place for them to.
 */
import { gregorianYearIn } from '../time';

export { gregorianYearIn };

/**
 * Age in whole years, as far as a birth *year* can tell.
 *
 * Year granularity is a deliberate privacy choice (plan §4.1: `birth_year`, not a
 * birth date). The consequence is that this is the age the person reaches during
 * the current year, so someone whose birthday has not arrived yet is counted as
 * a year older than they are today.
 *
 * That is the right direction to be wrong in only if you would rather admit a
 * 17-year-old three months early than refuse an 18-year-old for three months —
 * and it is the reading the plan's "CHECK ≥18 years old" on a year column
 * implies. Collecting a full birth date is the only way to do better, and it is
 * more personal data than the question needs.
 */
export function ageFromBirthYear(birthYear: number, now: Date, timeZone: string): number {
  return gregorianYearIn(now, timeZone) - birthYear;
}

export function isOldEnough(
  birthYear: number,
  minAgeYears: number,
  now: Date,
  timeZone: string,
): boolean {
  return ageFromBirthYear(birthYear, now, timeZone) >= minAgeYears;
}
