import { describe, expect, it } from 'vitest';
import { formatTehran } from './datetime';

/**
 * The date the most public surfaces write — channel posts, paid invitations, the
 * moderation case digest — and the last one in the product still rendering
 * Gregorian.
 *
 * What it produced was «۰۷/۰۹/۲۰۲۶، ۱۲:۰۰»: a Gregorian date wearing Persian
 * digits, which is the worst of both. A Persian reader has to convert it, and
 * the digits stop them recognising that it needs converting. `events-digest.ts`
 * had already caught the same thing on its own surface and moved to
 * `formatJalali`; this is the rest of them.
 */
describe('a moment as a Persian reader writes it', () => {
  it('renders the Jalali date and the Tehran time', () => {
    // 2026-09-06T08:30Z is 12:00 in Tehran, 15 Shahrivar 1405.
    expect(formatTehran(new Date('2026-09-06T08:30:00.000Z'))).toBe('۱۵ شهریور ۱۴۰۵ — ۱۲:۰۰');
  });

  it('carries no Latin digits at all', () => {
    expect(formatTehran(new Date('2026-09-06T08:30:00.000Z'))).not.toMatch(/[0-9]/);
  });

  /**
   * Tehran, not the host's zone. A moderator working from anywhere must read the
   * same clock the policy engine used (ADR-0008).
   */
  it('is in Tehran regardless of where it is formatted', () => {
    // 20:30 UTC on the 6th is 00:00 on the 7th in Tehran — a different day, and
    // the case a UTC-rendered date gets wrong.
    expect(formatTehran(new Date('2026-09-06T20:30:00.000Z'))).toBe('۱۶ شهریور ۱۴۰۵ — ۰۰:۰۰');
  });

  /** Nowruz: the Jalali year rolls over inside March, not in January. */
  it('rolls the Jalali year at Nowruz rather than in January', () => {
    expect(formatTehran(new Date('2026-03-20T09:00:00.000Z'))).toContain('۱۴۰۴');
    expect(formatTehran(new Date('2026-03-21T09:00:00.000Z'))).toContain('۱۴۰۵');
  });
});
