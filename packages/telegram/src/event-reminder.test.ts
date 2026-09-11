import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

/**
 * The two reminders before an activity starts (migration 0050).
 *
 * What is worth testing here is not the wording but the **time**: a reminder
 * naming the wrong day is worse than no reminder at all, and ADR-0008's whole
 * position is that UTC is stored and converted exactly once, at the edge. This
 * file is that edge.
 */
const STARTS_AT = '2026-09-12T15:30:00.000Z';

function guest(overrides: Record<string, unknown> = {}) {
  return render(TEMPLATES.EVENT_REMINDER_GUEST, {
    eventTitle: 'کوه‌پیمایی درکه',
    startsAt: STARTS_AT,
    wave: 'FIRST',
    ...overrides,
  });
}

describe('the guest reminder', () => {
  /**
   * Jalali, in Tehran. A Gregorian date here is the visible symptom of a
   * conversion skipped upstream, which is exactly what ADR-0008 exists to make
   * impossible to do quietly.
   */
  it('states the time in Jalali, converted to Tehran', () => {
    const text = guest()?.text ?? '';

    // 15:30 UTC is 19:00 Tehran on 21 Shahrivar 1405.
    expect(text).toContain('۲۱ شهریور ۱۴۰۵');
    expect(text).toContain('۱۹:۰۰');
    expect(text).not.toMatch(/20\d\d|Sep/);
  });

  it('names the activity', () => {
    expect(guest()?.text).toContain('کوه‌پیمایی درکه');
  });

  /**
   * The first wave is a plan; the second is a decision. Three hours is the hour
   * `participation.min_hours_before_event` and the `coins_lt_3h` step stand on,
   * so the second reminder's job is to say that cancelling is still the cheap
   * option — not merely that the evening is close.
   */
  it('tells the second wave that cancelling is still the cheaper choice', () => {
    const text = guest({ wave: 'SECOND' })?.text ?? '';

    expect(text).toContain('همین حالا لغو کنید');
    expect(text).toContain('چند ساعت دیگر');
  });

  it('says «فردا» in the first wave, not «چند ساعت دیگر»', () => {
    const text = guest({ wave: 'FIRST' })?.text ?? '';

    expect(text).toContain('فردا');
    expect(text).not.toContain('همین حالا لغو کنید');
  });

  /**
   * An unknown wave reads as the first one. That is the safe half to be wrong
   * about: «فردا» on an activity three hours away is merely early, while «تا چند
   * ساعت دیگر» on one a day away tells somebody to leave the house.
   */
  it('falls back to the calmer message when the wave is missing', () => {
    expect(guest({ wave: undefined })?.text).toContain('فردا');
  });

  /**
   * `new Date('')` is Invalid Date and `new Date(0)` is 1970, and both render
   * into Jalali as something a reader could act on.
   */
  it('omits the time rather than inventing one', () => {
    const missing = guest({ startsAt: undefined })?.text ?? '';
    const garbled = guest({ startsAt: 'not-a-date' })?.text ?? '';

    for (const text of [missing, garbled]) {
      expect(text).toContain('کوه‌پیمایی درکه');
      expect(text).not.toContain('۱۳۴۸');
      expect(text).not.toContain('Invalid');
      expect(text).not.toContain('NaN');
    }
  });

  /** Every reminder is about something the reader can open. */
  it('opens «فعالیت‌های من»', () => {
    expect(guest()?.deepLink).toBe('my-events');
  });
});

describe('the host reminder', () => {
  function host(overrides: Record<string, unknown> = {}) {
    return render(TEMPLATES.EVENT_REMINDER_HOST, {
      eventTitle: 'شب شعر',
      startsAt: STARTS_AT,
      acceptedCount: 4,
      ...overrides,
    });
  }

  it('carries the head count, in Persian digits', () => {
    const text = host()?.text ?? '';

    expect(text).toContain('۴ نفر پذیرفته‌شده');
    expect(text).toContain('۲۱ شهریور ۱۴۰۵');
  });

  /**
   * Nobody accepted is still worth sending. A host who has to shop or book a
   * table would rather learn it the day before than on the evening.
   */
  it('is still sent with nobody accepted', () => {
    expect(host({ acceptedCount: 0 })?.text).toContain('۰ نفر پذیرفته‌شده');
  });

  it('says the host is hosting, not attending', () => {
    expect(host()?.text).toContain('میزبانید');
  });
});
