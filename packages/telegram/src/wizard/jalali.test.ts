import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatJalali,
  isoDay,
  jalaliMonthDays,
  nextJalaliMonth,
  parseIsoDay,
  persianWeekday,
  previousJalaliMonth,
  tehranToday,
  toJalali,
} from './jalali';

/** Noon UTC, so nothing here sits near a Tehran midnight boundary. */
function at(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

describe('toJalali', () => {
  /** Nowruz. If the epoch is wrong, this is the assertion that says so. */
  it('places Nowruz 1405 on 21 March 2026', () => {
    expect(toJalali(at('2026-03-21'))).toEqual({ year: 1405, month: 1, day: 1 });
  });

  it('converts an ordinary date', () => {
    expect(toJalali(at('2026-08-28'))).toEqual({ year: 1405, month: 6, day: 6 });
  });

  /** The day before Nowruz is the last of Esfand, which is where leap years show. */
  it('places the last day of 1404 on 20 March 2026', () => {
    const previous = toJalali(at('2026-03-20'));

    expect(previous.year).toBe(1404);
    expect(previous.month).toBe(12);
  });
});

describe('formatJalali', () => {
  it('reads as a Persian reader writes it', () => {
    expect(formatJalali(at('2026-08-28'))).toBe('۶ شهریور ۱۴۰۵');
  });
});

describe('jalaliMonthDays', () => {
  /** The first six Jalali months have 31 days; the next five have 30. */
  it('gives Shahrivar 31 days and Mehr 30', () => {
    expect(jalaliMonthDays(at('2026-08-28'))).toHaveLength(31);
    expect(jalaliMonthDays(at('2026-10-01'))).toHaveLength(30);
  });

  it('starts on the first of the month and stays inside it', () => {
    const days = jalaliMonthDays(at('2026-08-28'));

    expect(toJalali(days[0]!).day).toBe(1);
    expect(days.every((day) => toJalali(day).month === 6)).toBe(true);
  });

  it('is contiguous', () => {
    const days = jalaliMonthDays(at('2026-08-28'));

    for (let i = 1; i < days.length; i += 1) {
      expect(days[i]!.getTime() - days[i - 1]!.getTime()).toBe(86_400_000);
    }
  });
});

describe('month navigation', () => {
  it('steps forward into the next Jalali month', () => {
    expect(toJalali(nextJalaliMonth(at('2026-08-28'))).month).toBe(7);
  });

  it('steps back into the previous one', () => {
    expect(toJalali(previousJalaliMonth(at('2026-08-28'))).month).toBe(5);
  });

  /** Across Nowruz, the year has to move too. */
  it('crosses the year boundary at Nowruz', () => {
    const back = toJalali(previousJalaliMonth(at('2026-03-25')));

    expect(back).toMatchObject({ year: 1404, month: 12 });
  });
});

describe('persianWeekday', () => {
  /**
   * The Persian week begins on شنبه. A grid that starts on Monday puts every
   * date under the wrong heading — a wrong date wearing a styling bug's clothes.
   */
  it('puts Saturday in the first column', () => {
    // 2026-08-22 is a Saturday.
    expect(persianWeekday(at('2026-08-22'))).toBe(0);
    expect(persianWeekday(at('2026-08-23'))).toBe(1);
    expect(persianWeekday(at('2026-08-28'))).toBe(6);
  });
});

describe('isoDay / parseIsoDay', () => {
  it('round-trips a day', () => {
    const day = at('2026-09-06');

    expect(isoDay(day)).toBe('2026-09-06');
    expect(isoDay(parseIsoDay('2026-09-06')!)).toBe('2026-09-06');
  });

  /** Callback values are untrusted: anything not a day is null, never a guess. */
  it('refuses anything that is not a day', () => {
    expect(parseIsoDay('2026-9-6')).toBeNull();
    expect(parseIsoDay('yesterday')).toBeNull();
    expect(parseIsoDay('')).toBeNull();
  });
});

describe('tehranToday', () => {
  /**
   * 20:00 UTC is already the next day in Tehran (+03:30). Getting this wrong
   * would offer somebody a date that has passed for them.
   */
  it('rolls over before UTC midnight, as Tehran does', () => {
    expect(isoDay(tehranToday(new Date('2026-08-28T21:00:00Z')))).toBe('2026-08-29');
    expect(isoDay(tehranToday(new Date('2026-08-28T19:00:00Z')))).toBe('2026-08-28');
  });
});

describe('addDays', () => {
  it('moves whole days', () => {
    expect(isoDay(addDays(at('2026-08-28'), 4))).toBe('2026-09-01');
  });
});
