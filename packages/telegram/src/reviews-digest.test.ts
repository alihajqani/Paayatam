import { describe, expect, it } from 'vitest';
import { formatPendingReviews, type PendingReviewLine } from './reviews-digest';

const DEADLINE = new Date('2026-09-05T20:00:00.000Z');

function line(over: Partial<PendingReviewLine> = {}): PendingReviewLine {
  return {
    revieweeDisplayName: 'سارا',
    eventTitle: 'کوهنوردی',
    deadlineAt: DEADLINE,
    ...over,
  };
}

describe('formatPendingReviews', () => {
  it('says so plainly when nothing is owed', () => {
    expect(formatPendingReviews([])).toContain('نظر منتظری ندارید');
  });

  it('names who is owed a review and for what', () => {
    const text = formatPendingReviews([line()]);

    expect(text).toContain('سارا');
    expect(text).toContain('کوهنوردی');
  });

  /** The deadline is the reason the command exists: a pending review expires. */
  it('shows the deadline', () => {
    expect(formatPendingReviews([line()])).toContain('تا ');
  });

  it('escapes markup in a name and a title', () => {
    const text = formatPendingReviews([
      line({ revieweeDisplayName: '<b>س</b>', eventTitle: '<i>ک</i>' }),
    ]);

    expect(text).toContain('&lt;b&gt;س&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;ک&lt;/i&gt;');
  });
});
