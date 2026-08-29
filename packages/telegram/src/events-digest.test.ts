import { describe, expect, it } from 'vitest';
import { formatMyEvents, type MyEventLine } from './events-digest';

const AT = new Date('2026-09-01T14:30:00.000Z');

function line(over: Partial<MyEventLine> = {}): MyEventLine {
  return {
    title: 'کوهنوردی',
    startsAt: AT,
    status: 'PUBLISHED',
    acceptedCount: 3,
    capacity: 6,
    ...over,
  };
}

describe('formatMyEvents', () => {
  it('says so plainly when nothing has been created', () => {
    expect(formatMyEvents([])).toContain('هنوز رویدادی نساخته‌اید');
  });

  /** Seats are the number a host checks; «۳ از ۶» is the answer to "do I need people?". */
  it('puts the seats on the line, in Persian digits', () => {
    const text = formatMyEvents([line()]);

    expect(text).toContain('۳ از ۶');
    expect(text).toContain('منتشرشده');
  });

  it('names each event', () => {
    const text = formatMyEvents([line({ title: 'یک' }), line({ title: 'دو' })]);

    expect(text).toContain('یک');
    expect(text).toContain('دو');
  });

  /** A title is the host's own words, but it still reaches an HTML-parse-mode send. */
  it('escapes markup in a title', () => {
    const text = formatMyEvents([line({ title: '<b>پررنگ</b>' })]);

    expect(text).toContain('&lt;b&gt;پررنگ&lt;/b&gt;');
    expect(text).not.toContain('<b>پررنگ');
  });

  it('renders a cancelled event with its own word', () => {
    expect(formatMyEvents([line({ status: 'CANCELLED_BY_HOST' })])).toContain('لغو شده');
  });
});
