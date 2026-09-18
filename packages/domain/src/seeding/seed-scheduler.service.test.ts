import { describe, expect, it } from 'vitest';
import { isDueForSeat } from './seed-scheduler.service';

describe('isDueForSeat', () => {
  const config = { fillMinutes: 5 };

  it('is not due immediately after creation', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const event = { createdAt: now, capacity: 4, acceptedCount: 0 };
    expect(isDueForSeat({ event, config, now })).toBe(false);
  });

  it('is due once enough of the window has elapsed for the next seat', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 3 * 60_000); // 3 of 5 minutes, capacity 4
    const event = { createdAt, capacity: 4, acceptedCount: 1 };
    expect(isDueForSeat({ event, config, now })).toBe(true);
  });

  it('is not due again immediately after reaching the expected pace', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 3 * 60_000);
    const event = { createdAt, capacity: 4, acceptedCount: 3 }; // already ahead of pace
    expect(isDueForSeat({ event, config, now })).toBe(false);
  });

  it('is due for the last seat once the window has fully elapsed', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 5 * 60_000);
    const event = { createdAt, capacity: 4, acceptedCount: 3 };
    expect(isDueForSeat({ event, config, now })).toBe(true);
  });

  it('is never due once the event is already full', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 10 * 60_000); // well past the window
    const event = { createdAt, capacity: 4, acceptedCount: 4 };
    expect(isDueForSeat({ event, config, now })).toBe(false);
  });
});
