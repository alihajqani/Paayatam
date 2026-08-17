import { describe, expect, it } from 'vitest';
import {
  formatEventDate,
  formatEventTime,
  formatEventWhen,
  formatRelative,
  isoToLocalInput,
  localInputToIso,
} from './datetime';

/**
 * These assert the *round trip* and the Tehran offset rather than exact Persian
 * month spellings, which belong to the platform's CLDR data and would make the
 * suite fail on an ICU upgrade for no product reason.
 */
describe('Jalali rendering', () => {
  it('renders a date in Persian digits with a Persian month', () => {
    // 2026-08-17T16:00:00Z is 2026-08-17 19:30 in Tehran (+03:30).
    const label = formatEventDate('2026-08-17T16:00:00.000Z');
    expect(label).toMatch(/[۰-۹]/);
    // Latin digits would mean the locale fell back to Gregorian/en.
    expect(label).not.toMatch(/[0-9]/);
  });

  it('renders time as the Tehran wall clock, not UTC', () => {
    expect(formatEventTime('2026-08-17T16:00:00.000Z')).toBe('۱۹:۳۰');
  });

  it('collapses the end time when the event ends the same day', () => {
    const when = formatEventWhen('2026-08-17T16:00:00.000Z', '2026-08-17T18:00:00.000Z');
    expect(when).toContain('۱۹:۳۰');
    expect(when).toContain('۲۱:۳۰');
    expect(when).toContain('تا');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');

  it.each([
    ['2026-08-17T12:00:30.000Z', 'تا لحظه‌ای دیگر'],
    ['2026-08-17T12:45:00.000Z', '۴۵ دقیقه دیگر'],
    ['2026-08-17T15:00:00.000Z', '۳ ساعت دیگر'],
    ['2026-08-20T12:00:00.000Z', '۳ روز دیگر'],
    ['2026-10-16T12:00:00.000Z', '۲ ماه دیگر'],
  ])('%s → %s', (iso, expected) => {
    expect(formatRelative(iso, now)).toBe(expected);
  });

  it('says how long ago something was, for a past event', () => {
    expect(formatRelative('2026-08-17T10:00:00.000Z', now)).toBe('۲ ساعت پیش');
  });
});

describe('datetime-local ↔ ISO', () => {
  it('reads the input as Tehran time, not as the device timezone', () => {
    // 19:30 in Tehran is 16:00 UTC. A naive `new Date(value)` would yield
    // whatever the host machine's offset happens to be.
    expect(localInputToIso('2026-08-17T19:30')).toBe('2026-08-17T16:00:00.000Z');
  });

  it('round-trips', () => {
    const iso = '2026-08-17T16:00:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
  });

  it('shows a UTC instant as its Tehran wall clock', () => {
    expect(isoToLocalInput('2026-08-17T16:00:00.000Z')).toBe('2026-08-17T19:30');
  });

  it.each(['', 'nonsense', '2026-08-17', '2026-08-17 19:30', '2026-13-45T99:99'])(
    'refuses malformed input %j',
    (value) => {
      expect(localInputToIso(value)).toBeNull();
    },
  );
});
