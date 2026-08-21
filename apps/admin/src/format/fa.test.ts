import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatSigned,
  formatTrust,
  toPersianDigits,
} from './fa';

/**
 * The view layer's Persian.
 *
 * Every internal value stays Latin — sorting, arithmetic and equality all depend
 * on it — and this is the edge where digits become something a person reads
 * (glossary §5). The case that matters most is `formatTrust`: **null is not
 * zero**, and getting it wrong shows the worst possible reputation to somebody
 * who has earned none at all.
 */

describe('digits', () => {
  it('renders Persian digits', () => {
    expect(toPersianDigits(1405)).toBe('۱۴۰۵');
  });

  it('leaves anything that is not a digit alone', () => {
    expect(toPersianDigits('NOWRUZ-1405')).toBe('NOWRUZ-۱۴۰۵');
  });

  it('groups thousands with the Persian separator', () => {
    expect(formatNumber(1_234_567)).toBe('۱٬۲۳۴٬۵۶۷');
  });
});

describe('a ledger amount', () => {
  it('shows a credit as a movement rather than a total', () => {
    expect(formatSigned(50)).toBe('+۵۰');
  });

  it('keeps the minus on a debit', () => {
    expect(formatSigned(-40)).toBe('-۴۰');
  });

  it('leaves zero unsigned', () => {
    expect(formatSigned(0)).toBe('۰');
  });
});

describe('a Trust Score', () => {
  it('reads as a score out of a hundred', () => {
    expect(formatTrust(72)).toBe('۷۲ از ۱۰۰');
  });

  /**
   * ADR-0014, and the reason it is a function rather than a template: the row is
   * written lazily by the first movement, so a brand-new account genuinely has
   * none — and «۰ از ۱۰۰» is a judgement it never earned.
   */
  it('says «تازه‌وارد» when the account has never been judged', () => {
    expect(formatTrust(null)).toBe('تازه‌وارد');
  });

  it('does not confuse a genuine zero with an absent score', () => {
    expect(formatTrust(0)).toBe('۰ از ۱۰۰');
  });
});

describe('dates', () => {
  /**
   * ADR-0008: the API speaks ISO-8601 UTC exclusively, and this is the only place
   * it becomes Jalali. `Asia/Tehran` explicitly rather than the browser's zone —
   * a moderator working from anywhere must read the clock the policy engine used.
   */
  it('renders an instant in the Jalali calendar', () => {
    const rendered = formatDate('2026-08-21T09:00:00.000Z');
    // The year, in Persian digits, without asserting a whole locale string.
    expect(rendered).toContain('۱۴۰۵');
  });

  it('renders a time alongside the date', () => {
    expect(formatDateTime('2026-08-21T09:00:00.000Z')).toMatch(/[۰-۹]/);
  });

  it('renders an em dash for an absent timestamp', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatRelative(null)).toBe('—');
  });

  it('refuses to render a malformed one as «Invalid Date»', () => {
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('relative time', () => {
  it('counts backwards for the past', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatRelative(threeHoursAgo)).toBe('۳ ساعت پیش');
  });

  it('counts forwards for the future', () => {
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(formatRelative(inTwoDays)).toBe('۲ روز دیگر');
  });

  it('uses the largest unit that still reads', () => {
    expect(formatRelative(new Date(Date.now() - 45_000).toISOString())).toContain('ثانیه');
    expect(formatRelative(new Date(Date.now() - 5 * 60_000).toISOString())).toContain('دقیقه');
  });
});
