/**
 * Persian presentation helpers.
 *
 * The rule from glossary §5: Persian digits are produced *at the view layer*
 * while every internal value stays Latin. Nothing here is ever fed back into a
 * request — sorting and arithmetic must never touch a Persian numeral.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

export function toPersianDigits(value: number | string): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]!);
}

/** «۱۲۰٬۰۰۰ تومان» — Persian digits, Persian thousands separator (glossary §5). */
export function formatToman(amount: number): string {
  return `${toPersianDigits(amount.toLocaleString('en-US')).replaceAll(',', '٬').toString()} تومان`;
}

export function formatCoins(amount: number): string {
  return `${toPersianDigits(amount)} سکه`;
}

export interface BirthYearOption {
  /** What is sent to the API. Gregorian, always (ADR-0008). */
  gregorian: number;
  /** What the user reads. */
  labelFa: string;
}

/**
 * Birth-year options, youngest first.
 *
 * Generated from an age range rather than from a fixed span of years, so the
 * first option is always the youngest age the platform admits and the list needs
 * no maintenance as years pass.
 *
 * The Jalali label is `gregorian − 621`, which is the Jalali year covering March
 * to December of that Gregorian year — about ten months of it. Someone born in
 * the remaining two (Dey to Esfand, i.e. January to March) will see their birth
 * year labelled one lower than they would write it.
 *
 * That imprecision is inherent to storing a year rather than a date, and it is
 * why the API takes the Gregorian value from this list rather than a Jalali year
 * the server would have to guess at. The direction of the error also matches the
 * server's own rounding (see `age.ts` in the domain): both lean toward treating
 * a person as slightly older, never younger, so the two never disagree about the
 * 18+ boundary.
 */
export function birthYearOptions(
  currentGregorianYear: number,
  minAge = 18,
  maxAge = 90,
): BirthYearOption[] {
  const options: BirthYearOption[] = [];
  for (let age = minAge; age <= maxAge; age += 1) {
    const gregorian = currentGregorianYear - age;
    options.push({ gregorian, labelFa: toPersianDigits(gregorian - 621) });
  }
  return options;
}
