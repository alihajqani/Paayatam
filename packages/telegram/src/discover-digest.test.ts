import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { describe, expect, it } from 'vitest';
import { ENTRY_SEPARATOR, formatDiscovered, type DiscoverLine } from './discover-digest';

const AT = new Date('2026-09-01T14:30:00.000Z');
const ID = '01a05d34-7820-7648-bc3d-240c16ee9285';

function line(over: Partial<DiscoverLine> = {}): DiscoverLine {
  return {
    title: 'کوهنوردی',
    startsAt: AT,
    capacity: 6,
    remainingCapacity: 3,
    publicId: ID,
    ...over,
  };
}

describe('formatDiscovered', () => {
  /**
   * «فعلاً فعالیتی در شهر شما ثبت نشده» was a false answer under an active
   * filter — it reads as "your city is empty", which is a much more discouraging
   * claim than "nothing free today". The filters are where to go next, and the
   * empty message says so.
   */
  it('sends the reader to the filters rather than blaming the city', () => {
    const text = formatDiscovered([]);

    expect(text).toContain('فیلترها');
    expect(text).not.toContain('شهر شما ثبت نشده');
  });

  it('names the activity, when it is, and how much room is left', () => {
    const text = formatDiscovered([line()]);

    expect(text).toContain('کوهنوردی');
    expect(text).toContain('۳ جای خالی از ۶');
    expect(text).toContain('ساعت');
  });

  /**
   * The whole point of the rewrite: each activity carries the command that opens
   * it, on its own line, so the list needs no keyboard of its own.
   */
  it('gives every activity a command that opens it', () => {
    const text = formatDiscovered([line()]);

    expect(text).toContain('/event_01a05d3478');
  });

  it('drops the command rather than rendering a broken one', () => {
    const text = formatDiscovered([line({ publicId: 'not-an-id' })]);

    expect(text).toContain('کوهنوردی');
    expect(text).not.toContain('/event_');
  });

  it('separates two activities with a rule', () => {
    const text = formatDiscovered([line(), line({ title: 'دو' })]);

    expect(text).toContain(ENTRY_SEPARATOR);
    expect(text.split(ENTRY_SEPARATOR)).toHaveLength(2);
  });

  /** A full event says so rather than rendering «۰ جای خالی». */
  it('names a full event as full', () => {
    expect(formatDiscovered([line({ remainingCapacity: 0 })])).toContain('ظرفیت تکمیل');
  });

  /**
   * The reader's «۳» has to be the third thing they can see. Numbering every
   * page from one would put three «۱»s in a chat and make «فعالیت شمارهٔ ۲»
   * ambiguous the moment somebody mentions it.
   */
  it('numbers from the top of the page, not of the list', () => {
    const text = formatDiscovered([line(), line({ title: 'دو' })], 2);

    expect(text).toContain('۵. کوهنوردی');
    expect(text).toContain('۶. دو');
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
  it('escapes markup in a title', () => {
    const text = formatDiscovered([line({ title: '<b>ب</b>' })]);

    expect(text).toContain('&lt;b&gt;ب&lt;/b&gt;');
    expect(text).not.toContain('<b>ب');
  });
});
