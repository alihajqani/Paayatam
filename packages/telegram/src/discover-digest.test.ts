import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { describe, expect, it } from 'vitest';
import { formatDiscovered, type DiscoverLine } from './discover-digest';

const AT = new Date('2026-09-01T14:30:00.000Z');

function line(over: Partial<DiscoverLine> = {}): DiscoverLine {
  return {
    title: 'کوهنوردی',
    categoryName: 'ورزش',
    where: 'تهران — ونک',
    startsAt: AT,
    remainingCapacity: 3,
    ...over,
  };
}

describe('formatDiscovered', () => {
  it('says so plainly when the city has nothing on', () => {
    expect(formatDiscovered([])).toContain('فعلاً فعالیتی در شهر شما ثبت نشده');
  });

  it('names the activity, its category and where it is', () => {
    const text = formatDiscovered([line()]);

    expect(text).toContain('کوهنوردی');
    expect(text).toContain('ورزش');
    expect(text).toContain('تهران — ونک');
  });

  it('puts the free seats on the line, in Persian digits', () => {
    expect(formatDiscovered([line({ remainingCapacity: 3 })])).toContain('۳ جای خالی');
  });

  /** A full event says so rather than rendering «۰ جای خالی». */
  it('names a full event as full', () => {
    expect(formatDiscovered([line({ remainingCapacity: 0 })])).toContain('ظرفیت تکمیل');
  });

  /**
   * A liability statement, not decoration: an event listed without it is one
   * this product is silently vouching for.
   */
  it('carries the disclaimer once, over the whole list', () => {
    const text = formatDiscovered([line(), line({ title: 'دو' })]);

    expect(text).toContain(EVENT_DISCLAIMER_SHORT_FA);
    expect(text.split(EVENT_DISCLAIMER_SHORT_FA)).toHaveLength(2);
  });

  /** Nothing to disclaim, and the sentence would read as a warning about the absence. */
  it('carries no disclaimer over an empty list', () => {
    expect(formatDiscovered([])).not.toContain(EVENT_DISCLAIMER_SHORT_FA);
  });

  /** A title is a stranger's words on their way into an HTML-parse-mode send. */
  it('escapes markup in a title and a category', () => {
    const text = formatDiscovered([line({ title: '<b>ب</b>', categoryName: '<i>د</i>' })]);

    expect(text).toContain('&lt;b&gt;ب&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;د&lt;/i&gt;');
    expect(text).not.toContain('<b>ب');
  });
});
