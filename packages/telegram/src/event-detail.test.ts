import { describe, expect, it } from 'vitest';
import { formatEventDetail, type EventDetailLine } from './event-detail';

const line: EventDetailLine = {
  title: 'قهوه و بازی',
  description: 'یک شب دوستانه.',
  categoryName: 'بازی',
  where: 'تهران',
  startsAt: new Date('2026-09-20T15:30:00.000Z'),
  endsAt: new Date('2026-09-20T18:30:00.000Z'),
  capacity: 6,
  acceptedCount: 2,
  costType: 'FREE',
  costAmount: null,
  costNote: null,
  minAge: null,
  maxAge: null,
  hostDisplayName: 'مریم',
  hostTrustScore: 80,
};

/**
 * The page says where the reader stands (plan 12, review M7).
 *
 * A guest who had been accepted opened the page and saw «پایتم» again, which was
 * refused as a duplicate, and nothing on it said they had a seat.
 */
describe('the viewer’s own status on the activity page', () => {
  it('says an accepted guest has a seat', () => {
    expect(
      formatEventDetail({ ...line, viewer: { status: 'ACCEPTED', waitlistRank: null } }),
    ).toContain('وضعیت شما: پذیرفته شد');
  });

  it('gives a waiting guest their place in the queue', () => {
    const text = formatEventDetail({ ...line, viewer: { status: 'WAITLISTED', waitlistRank: 3 } });
    expect(text).toContain('نوبت انتظار');
    expect(text).toContain('نفر ۳');
  });

  it('says nothing about a reader with no request', () => {
    expect(formatEventDetail(line)).not.toContain('وضعیت شما');
  });
});
