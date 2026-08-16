import { describe, expect, it } from 'vitest';
import { gregorianYearIn, startOfDayIn } from './time';

const TEHRAN = 'Asia/Tehran';

/**
 * Tehran is UTC+03:30 year-round — Iran abolished DST in 2022 — so local
 * midnight is 20:30 UTC the previous day. Every expectation below is that offset
 * applied by hand, which is the point: if the arithmetic ever drifts, these fail
 * rather than the M4 quota silently counting the wrong day.
 */
describe('startOfDayIn', () => {
  it.each([
    ['midday', '2026-08-15T09:00:00.000Z', '2026-08-14T20:30:00.000Z'],
    ['just after local midnight', '2026-08-14T20:31:00.000Z', '2026-08-14T20:30:00.000Z'],
    ['exactly local midnight', '2026-08-14T20:30:00.000Z', '2026-08-14T20:30:00.000Z'],
    ['one minute before local midnight', '2026-08-14T20:29:00.000Z', '2026-08-13T20:30:00.000Z'],
    ['late local evening', '2026-08-15T19:00:00.000Z', '2026-08-14T20:30:00.000Z'],
  ])('%s', (_label, instant, expected) => {
    expect(startOfDayIn(new Date(instant), TEHRAN).toISOString()).toBe(expected);
  });

  it('disagrees with UTC, which is the entire reason it exists', () => {
    // 21:00 UTC on the 14th is already 00:30 on the 15th in Tehran. A quota
    // computed in UTC would put these two events on the same day; a user would
    // say they were on different ones.
    const instant = new Date('2026-08-14T21:00:00.000Z');
    expect(startOfDayIn(instant, TEHRAN).toISOString()).toBe('2026-08-14T20:30:00.000Z');
    expect(startOfDayIn(instant, 'UTC').toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('handles a zone that still observes DST', () => {
    // Europe/London in August is UTC+1, so local midnight is 23:00 UTC the day
    // before. This is the case the two-pass offset correction exists for.
    expect(startOfDayIn(new Date('2026-08-15T12:00:00.000Z'), 'Europe/London').toISOString()).toBe(
      '2026-08-14T23:00:00.000Z',
    );
    // In January the same zone is UTC+0 and local midnight is midnight UTC.
    expect(startOfDayIn(new Date('2026-01-15T12:00:00.000Z'), 'Europe/London').toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
  });

  it('lands on a day boundary that is stable under repetition', () => {
    const first = startOfDayIn(new Date('2026-08-15T09:00:00.000Z'), TEHRAN);
    expect(startOfDayIn(first, TEHRAN).toISOString()).toBe(first.toISOString());
  });
});

describe('gregorianYearIn', () => {
  it('reads the year in the requested zone', () => {
    const instant = new Date('2026-12-31T21:00:00.000Z');
    expect(gregorianYearIn(instant, 'UTC')).toBe(2026);
    expect(gregorianYearIn(instant, TEHRAN)).toBe(2027);
  });
});
