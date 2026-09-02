import { describe, expect, it } from 'vitest';
import { formatPendingReviews, type PendingReviewLine } from './reviews-digest';

const DEADLINE = new Date('2026-09-05T20:00:00.000Z');

function line(over: Partial<PendingReviewLine> = {}): PendingReviewLine {
  return {
    revieweeDisplayName: 'سارا',
    eventTitle: 'کوهنوردی',
    deadlineAt: DEADLINE,
    opensAt: null,
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

  /**
   * The screen said «نظر منتظری ندارید» in three different situations — the
   * window has not opened, the settlement sweep has not run, and there is
   * genuinely nothing — and a host who had just held an activity read the first
   * as the third. An unopened pair is now listed with the date it becomes
   * writable.
   */
  describe('a window that has not opened yet', () => {
    const OPENS = new Date('2026-09-02T20:00:00.000Z');

    it('says when it opens instead of when it expires', () => {
      const text = formatPendingReviews([line({ opensAt: OPENS })]);

      expect(text).toContain('می‌توانید بنویسید');
      expect(text).toContain('سارا');
    });

    /**
     * The star rows are numbered against this list and only the open entries get
     * one, so an unopened entry between two open ones would shift every number
     * after it — and somebody would rate the wrong stranger.
     */
    it('sorts the writable ones first, so row n is entry n', () => {
      const text = formatPendingReviews([
        line({ revieweeDisplayName: 'قفل', opensAt: OPENS }),
        line({ revieweeDisplayName: 'باز' }),
      ]);

      expect(text.indexOf('۱. باز')).toBeGreaterThan(-1);
      expect(text.indexOf('۲. قفل')).toBeGreaterThan(text.indexOf('۱. باز'));
    });

    it('does not promise star rows when none of them is writable', () => {
      const text = formatPendingReviews([line({ opensAt: OPENS })]);

      expect(text).toContain('هنوز هیچ‌کدام باز نشده‌اند');
      expect(text).not.toContain('ردیف «۱»');
    });
  });

  /** And the empty screen says *why* it is empty rather than only that it is. */
  it('names the condition that opens a window', () => {
    expect(formatPendingReviews([])).toContain('پس از پایان هر فعالیتی');
  });

  it('escapes markup in a name and a title', () => {
    const text = formatPendingReviews([
      line({ revieweeDisplayName: '<b>س</b>', eventTitle: '<i>ک</i>' }),
    ]);

    expect(text).toContain('&lt;b&gt;س&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;ک&lt;/i&gt;');
  });
});
