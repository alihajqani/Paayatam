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
  takenCount: 2,
  costType: 'FREE',
  costAmount: null,
  costNote: null,
  minAge: null,
  maxAge: null,
  hostDisplayName: 'مریم',
  hostTrustScore: 80,
};

describe('the seats line (v0.16.0)', () => {
  it('counts the seats the channel counts, with the same colour', () => {
    expect(formatEventDetail({ ...line, capacity: 4, takenCount: 3 })).toContain(
      '🟠 ۱ جای خالی از ۴',
    );
  });
});

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

/**
 * What guests have said about the host, in numbers (plan 18 item 6) — the
 * texts are one tap further, behind «نظرها دربارهٔ میزبان».
 */
describe('the host’s reviews on the activity page', () => {
  it('gives the mean rating and how many reviews it is over', () => {
    const text = formatEventDetail({ ...line, hostReviews: { count: 12, average: 4.583 } });
    expect(text).toContain('۴٫۶ از ۵');
    expect(text).toContain('۱۲ نظر');
  });

  /** «۰ نظر» next to a new host reads as a verdict; «تازه‌وارد» already says it. */
  it('says nothing for a host nobody has reviewed yet', () => {
    expect(formatEventDetail({ ...line, hostReviews: { count: 0, average: null } })).not.toContain(
      'نظر',
    );
    expect(formatEventDetail(line)).not.toContain('از ۵');
  });
});
