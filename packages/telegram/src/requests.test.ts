import { describe, expect, it } from 'vitest';
import { formatMyRequests, type MyRequestLine } from './requests';

const AT = new Date('2026-09-01T14:30:00.000Z');

const EVENT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

function line(over: Partial<MyRequestLine> = {}): MyRequestLine {
  return {
    title: 'کوهنوردی',
    startsAt: AT,
    status: 'PENDING',
    waitlistRank: null,
    eventPublicId: EVENT,
    ...over,
  };
}

describe('formatMyRequests', () => {
  it('says so plainly when nothing has been asked for', () => {
    expect(formatMyRequests([])).toContain('هنوز درخواستی نداده‌اید');
  });

  it('names the event and where the request stands', () => {
    const text = formatMyRequests([line()]);

    expect(text).toContain('کوهنوردی');
    expect(text).toContain('در انتظار پاسخ میزبان');
  });

  /** The rank is the answer to "how far off am I", and only means anything queued. */
  it('shows the queue position only while waitlisted', () => {
    expect(formatMyRequests([line({ status: 'WAITLISTED', waitlistRank: 3 })])).toContain('نفر ۳');
    // A stale rank on an accepted row would claim a queue that no longer applies.
    expect(formatMyRequests([line({ status: 'ACCEPTED', waitlistRank: 3 })])).not.toContain(
      'نفر ۳',
    );
  });

  /**
   * A title is a stranger's words rendered into an HTML-parse-mode message. An
   * unescaped `<b>` would be the least of it — a malformed tag makes Telegram
   * reject the whole send, which turns somebody's event title into an outage for
   * the person reading the digest.
   */
  it('escapes a title that contains markup', () => {
    const text = formatMyRequests([line({ title: '<b>پررنگ</b> & <i>کج</i>' })]);

    expect(text).toContain('&lt;b&gt;پررنگ&lt;/b&gt; &amp; &lt;i&gt;کج&lt;/i&gt;');
    expect(text).not.toContain('<b>پررنگ');
  });

  /**
   * The way back to the activity (review H2). A guest who was accepted had no
   * tap anywhere that opened the page carrying «پیام مستقیم به میزبان».
   */
  it('links each live request to its activity', () => {
    for (const status of ['PENDING', 'WAITLISTED', 'ACCEPTED'] as const) {
      expect(formatMyRequests([line({ status })]), status).toContain('/event_0190a1b2c3');
    }
  });

  /** The page answers «not found» once the activity is over — no dead link. */
  it('does not link a request that is settled', () => {
    for (const status of ['COMPLETED', 'REJECTED', 'CANCELLED_BY_PARTICIPANT'] as const) {
      expect(formatMyRequests([line({ status })]), status).not.toContain('/event_');
    }
  });

  it('renders every request it is given', () => {
    const text = formatMyRequests([line({ title: 'یک' }), line({ title: 'دو' })]);

    expect(text).toContain('یک');
    expect(text).toContain('دو');
  });
});
