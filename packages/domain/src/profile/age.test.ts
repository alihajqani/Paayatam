import { describe, expect, it } from 'vitest';
import { ageFromBirthYear, gregorianYearIn, isOldEnough } from './age';

const TEHRAN = 'Asia/Tehran';

describe('gregorianYearIn', () => {
  it('reads the year in the requested zone, not the process zone', () => {
    // 22:00 UTC on 31 December is already 01:30 on 1 January in Tehran (+03:30).
    // A server running in UTC would answer 2026; the user's calendar says 2027,
    // and the user's calendar is the one the law cares about.
    const newYearEveUtc = new Date('2026-12-31T22:00:00.000Z');

    expect(gregorianYearIn(newYearEveUtc, 'UTC')).toBe(2026);
    expect(gregorianYearIn(newYearEveUtc, TEHRAN)).toBe(2027);
  });

  it('returns Gregorian years even though the audience uses the Jalali calendar', () => {
    // fa-IR resolves to the Persian calendar by default, which would answer 1405.
    // Storage and policy are Gregorian throughout (ADR-0008).
    expect(gregorianYearIn(new Date('2026-08-15T09:00:00.000Z'), TEHRAN)).toBe(2026);
  });
});

describe('ageFromBirthYear', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');

  it.each([
    [2008, 18],
    [2009, 17],
    [2000, 26],
    [1970, 56],
  ])('birth year %i is age %i in 2026', (birthYear, expected) => {
    expect(ageFromBirthYear(birthYear, now, TEHRAN)).toBe(expected);
  });
});

describe('isOldEnough', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');

  it.each([
    // The boundary, from both sides. 2008 is the first year that passes in 2026.
    [2009, false],
    [2008, true],
    [2007, true],
  ])('birth year %i passes an 18+ gate: %s', (birthYear, expected) => {
    expect(isOldEnough(birthYear, 18, now, TEHRAN)).toBe(expected);
  });

  it('moves the boundary with the calendar, not with a deploy', () => {
    // Someone born in 2009 is refused in 2026 and admitted in 2027, with no code
    // change in between. This is the property that makes the gate depend on the
    // server clock rather than on when the service last restarted.
    expect(isOldEnough(2009, 18, new Date('2026-12-31T20:00:00.000Z'), TEHRAN)).toBe(false);
    expect(isOldEnough(2009, 18, new Date('2026-12-31T21:00:00.000Z'), TEHRAN)).toBe(true);
  });

  it('honours a minimum age other than 18, because the number lives in app_setting', () => {
    expect(isOldEnough(2005, 21, now, TEHRAN)).toBe(true);
    expect(isOldEnough(2006, 21, now, TEHRAN)).toBe(false);
  });
});
