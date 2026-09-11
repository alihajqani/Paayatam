import { describe, expect, it } from 'vitest';
import { reminderWaveFor } from './lifecycle.service';

/**
 * Which of the two pre-event reminders an activity is owed (migration 0050).
 *
 * The sweep has already bounded the set by the **first** window — everything
 * reaching this function starts inside `reminder.first_hours_before`. So the
 * only question left is which side of the second threshold it falls on, and both
 * edges of that are places a plausible reading gets it wrong.
 */
const HOUR = 3_600_000;
const SECOND_WINDOW = 3 * HOUR;
const NOW = new Date('2026-09-11T12:00:00.000Z');

function waveAt(msFromNow: number) {
  return reminderWaveFor({
    startsAt: new Date(NOW.getTime() + msFromNow),
    now: NOW,
    secondWindowMs: SECOND_WINDOW,
  });
}

describe('choosing the reminder wave', () => {
  it('sends the day-ahead reminder for an activity a day out', () => {
    expect(waveAt(24 * HOUR)).toBe('FIRST');
    expect(waveAt(12 * HOUR)).toBe('FIRST');
  });

  it('sends the last-call reminder inside the second window', () => {
    expect(waveAt(2 * HOUR)).toBe('SECOND');
    expect(waveAt(30 * 60_000)).toBe('SECOND');
  });

  /**
   * The boundary, and the direction it has to fall.
   *
   * Three hours out is the moment `cancellation.coins_lt_3h` is about to apply,
   * and the whole value of this reminder is arriving **before** cancelling gets
   * expensive. Exclusive here would push it to the next quarter-hourly pass,
   * which is fifteen minutes into the penalty it exists to warn about.
   */
  it('treats exactly the threshold as the last call, not the day-ahead one', () => {
    expect(waveAt(SECOND_WINDOW)).toBe('SECOND');
    expect(waveAt(SECOND_WINDOW + 1)).toBe('FIRST');
    expect(waveAt(SECOND_WINDOW - 1)).toBe('SECOND');
  });

  /**
   * An activity created inside the second window never gets the day-ahead one.
   *
   * The first wave is not "missed" — it was never sendable in advance. Without
   * this, somebody joining an activity two hours away would get «فردا» and «تا
   * چند ساعت دیگر» within one pass of each other, which is the product talking
   * to itself.
   */
  it('never offers the day-ahead wave to something starting sooner than that', () => {
    for (const minutes of [1, 30, 90, 179]) {
      expect(waveAt(minutes * 60_000)).toBe('SECOND');
    }
  });

  /**
   * A window of zero disables the second wave entirely rather than making
   * everything urgent — an operator who zeroes the setting has turned the last
   * call off, and an activity starting in a minute is still "not yet within
   * zero hours of starting".
   */
  it('turns the last call off when its window is zero', () => {
    expect(
      reminderWaveFor({
        startsAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
        secondWindowMs: 0,
      }),
    ).toBe('FIRST');
  });
});
