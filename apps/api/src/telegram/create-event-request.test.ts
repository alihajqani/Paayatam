import { describe, expect, it } from 'vitest';
import { toCreateEventRequest } from './bot.service';

const FORM = {
  title: 'اکران فیلم در هویزه',
  description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
  categoryId: '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f',
  cityId: '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e71',
  day: '2026-10-09',
  hour: 19,
  durationHours: 2,
  capacity: 4,
  costType: 'FREE' as const,
};

/**
 * The wizard's answers, as the instant `EventService.create` stores (ADR-0008).
 *
 * A suggestion pre-fills a minute the hour buttons cannot say (migration 0064):
 * a 19:30 screening has to stay 19:30 in Tehran — 16:00 UTC — and not quietly
 * become 19:00, which is half an hour before the film.
 */
describe('toCreateEventRequest', () => {
  it('reads a whole hour in Tehran', () => {
    expect(toCreateEventRequest(FORM)?.startsAt.toISOString()).toBe('2026-10-09T15:30:00.000Z');
  });

  it('keeps a suggestion’s minute', () => {
    const request = toCreateEventRequest({ ...FORM, startMinute: 30 });

    expect(request?.startsAt.toISOString()).toBe('2026-10-09T16:00:00.000Z');
    expect(request?.endsAt.toISOString()).toBe('2026-10-09T18:00:00.000Z');
  });
});
