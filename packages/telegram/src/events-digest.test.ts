import { describe, expect, it } from 'vitest';
import { ENTRY_SEPARATOR } from './discover-digest';
import {
  formatMyEvents,
  formatOwnedEvent,
  myEventsPageRow,
  type MyEventLine,
  type OwnedEventLine,
} from './events-digest';
import { parseMyEventsCallback } from './callback-data';

const AT = new Date('2026-09-01T14:30:00.000Z');
const ID = '01a05d34-7820-7648-bc3d-240c16ee9285';

function line(over: Partial<MyEventLine> = {}): MyEventLine {
  return {
    title: 'کوهنوردی',
    startsAt: AT,
    status: 'PUBLISHED',
    acceptedCount: 3,
    capacity: 6,
    publicId: ID,
    ...over,
  };
}

describe('formatMyEvents', () => {
  it('points at the way to make the first one', () => {
    const text = formatMyEvents([]);

    expect(text).toContain('هنوز فعالیتی نساخته‌اید');
    expect(text).toContain('ساختن فعالیت');
  });

  /** Seats are the number a host checks; «۳ از ۶» is the answer to "do I need people?". */
  it('puts the seats and the stage on the line, in Persian digits', () => {
    const text = formatMyEvents([line()]);

    expect(text).toContain('۳ از ۶');
    expect(text).toContain('منتشرشده');
  });

  /**
   * The console is gone: the actions live under the activity they act on, where
   * there is one of each and no number to match. What the list carries instead
   * is the command that opens it.
   */
  it('gives every activity a command that opens it', () => {
    expect(formatMyEvents([line()])).toContain('/myevent_01a05d3478');
  });

  it('separates two activities with a rule', () => {
    const text = formatMyEvents([line({ title: 'یک' }), line({ title: 'دو' })]);

    expect(text).toContain('یک');
    expect(text).toContain('دو');
    expect(text.split(ENTRY_SEPARATOR)).toHaveLength(2);
  });

  it('numbers from where the page starts, not from how many it holds', () => {
    const text = formatMyEvents([line({ title: 'یک' }), line({ title: 'دو' })], 5);

    expect(text).toContain('۶. یک');
    expect(text).toContain('۷. دو');
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

describe('the host list paging row', () => {
  it('is empty when everything fits on one page', () => {
    expect(myEventsPageRow(0, false)).toEqual([]);
  });

  it('steps one page at a time', () => {
    const [row] = myEventsPageRow(2, true);
    const [previous, , next] = row ?? [];

    expect(parseMyEventsCallback(previous?.callbackData ?? '')).toBe(1);
    expect(parseMyEventsCallback(next?.callbackData ?? '')).toBe(3);
  });

  it('drops «بعدی» on the last page', () => {
    const [row] = myEventsPageRow(2, false);
    expect(row?.map((button) => button.text)).toEqual(['‹ قبلی', 'صفحهٔ ۳']);
  });

  it('refuses a tampered page', () => {
    expect(parseMyEventsCallback('mv:!:x')).toBeNull();
    expect(parseMyEventsCallback('mv:1')).toBeNull();
    expect(parseMyEventsCallback('dc:aa0l:all')).toBeNull();
  });
});

function owned(over: Partial<OwnedEventLine> = {}): OwnedEventLine {
  return {
    title: 'کوهنوردی',
    description: 'یک صبح دوستانه در درکه.',
    categoryName: 'ورزش',
    where: 'تهران — ونک',
    startsAt: AT,
    endsAt: new Date(AT.getTime() + 3 * 3_600_000),
    status: 'PUBLISHED',
    capacity: 6,
    acceptedCount: 3,
    pendingCount: 0,
    costType: 'FREE',
    costAmount: null,
    ...over,
  };
}

/**
 * The host's own screen, which is a different screen from the stranger's: what
 * a host needs is the stage the activity is at and how many people are waiting
 * on them, and neither may appear on a public detail.
 */
describe('formatOwnedEvent', () => {
  it('leads with the stage, because that is what a host is checking', () => {
    expect(formatOwnedEvent(owned({ status: 'PENDING_MODERATION' }))).toContain('در انتظار بررسی');
  });

  it('says how full it is, both ways round', () => {
    const text = formatOwnedEvent(owned());

    expect(text).toContain('۳ از ۶ جا پر شده');
    expect(text).toContain('۳ جای خالی');
  });

  it('says «ظرفیت تکمیل» rather than «۰ جای خالی»', () => {
    expect(formatOwnedEvent(owned({ acceptedCount: 6 }))).toContain('ظرفیت تکمیل');
  });

  /**
   * Named only when there are any: «۰ درخواست در انتظار» on every healthy
   * activity is what makes the one that is not healthy hard to spot.
   */
  it('names waiting requests only when there are some', () => {
    expect(formatOwnedEvent(owned({ pendingCount: 2 }))).toContain('۲ درخواست در انتظار');
    expect(formatOwnedEvent(owned())).not.toContain('درخواست در انتظار');
  });

  it('states a price when there is one, and «رایگان» when there is not', () => {
    expect(formatOwnedEvent(owned())).toContain('رایگان');
    expect(formatOwnedEvent(owned({ costType: 'FIXED', costAmount: 50_000 }))).toContain(
      '۵۰۰۰۰ تومان',
    );
  });

  it('escapes the host’s own words on their way into an HTML send', () => {
    const text = formatOwnedEvent(owned({ title: '<b>ب</b>', description: '<i>د</i>' }));

    expect(text).toContain('&lt;b&gt;ب&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;د&lt;/i&gt;');
  });
});
