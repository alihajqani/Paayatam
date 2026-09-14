import { describe, expect, it } from 'vitest';
import { formatHostReviews } from './received-reviews';

const REVIEW = {
  rating: 4,
  tags: ['FRIENDLY'],
  comment: 'خوش‌برخورد و سر وقت',
  submittedAt: new Date('2026-09-01T10:00:00.000Z'),
  withoutCounterpart: false,
};

const tagLabel = (tag: string): string => (tag === 'FRIENDLY' ? 'خوش‌برخورد' : tag);

/** «⭐️ نظرها دربارهٔ میزبان» (plan 18 item 6): the latest few, never who wrote them. */
describe('formatHostReviews', () => {
  it('names the host, the summary, and each review’s stars, tags and words', () => {
    const text = formatHostReviews('مریم', { count: 7, average: 4.2 }, [REVIEW], tagLabel);

    expect(text).toContain('مریم');
    expect(text).toContain('۴٫۲ از ۵');
    expect(text).toContain('۷ نظر');
    expect(text).toContain('⭐️⭐️⭐️⭐️☆');
    expect(text).toContain('خوش‌برخورد');
    expect(text).toContain('«خوش‌برخورد و سر وقت»');
  });

  it('says there are more than it shows', () => {
    expect(formatHostReviews('مریم', { count: 7, average: 4.2 }, [REVIEW], tagLabel)).toContain(
      '۱ نظر آخر',
    );
  });

  it('escapes a comment', () => {
    const text = formatHostReviews(
      '<b>م</b>',
      { count: 1, average: 5 },
      [{ ...REVIEW, comment: '<i>x</i>' }],
      tagLabel,
    );
    expect(text).toContain('&lt;b&gt;م&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;x&lt;/i&gt;');
  });

  it('says so when nothing is published yet', () => {
    expect(formatHostReviews('مریم', { count: 0, average: null }, [], tagLabel)).toContain(
      'هنوز نظری',
    );
  });
});
