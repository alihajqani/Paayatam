import { describe, expect, it } from 'vitest';
import { formatMyRequests, type MyRequestLine } from './requests';

const AT = new Date('2026-09-01T14:30:00.000Z');

function line(over: Partial<MyRequestLine> = {}): MyRequestLine {
  return { title: 'کوهنوردی', startsAt: AT, status: 'PENDING', waitlistRank: null, ...over };
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

  it('renders every request it is given', () => {
    const text = formatMyRequests([line({ title: 'یک' }), line({ title: 'دو' })]);

    expect(text).toContain('یک');
    expect(text).toContain('دو');
  });
});
