import { describe, expect, it } from 'vitest';
import { cityQueueLine } from './bot.service';

/**
 * «شما نفر ۳۰ از شیراز هستید» (plan 17).
 *
 * The number is true and stays. What changed is the promise after it: reaching
 * the threshold does not open a city — an operator does, from the panel — so the
 * line may say the city becomes *ready* to open, never that it opens.
 */
describe('cityQueueLine', () => {
  const closed = { cityNameFa: 'شیراز', launched: false, waiting: 30, threshold: 100 };

  it('keeps the queue number, which is true', () => {
    expect(cityQueueLine(closed)).toContain('نفر ۳۰');
  });

  it('does not promise the city opens by itself at the threshold', () => {
    expect(cityQueueLine(closed)).not.toContain('باز می‌شود');
    expect(cityQueueLine(closed)).toContain('آمادهٔ باز شدن');
  });

  it('is empty for an open city', () => {
    expect(cityQueueLine({ ...closed, launched: true })).toBe('');
  });
});
