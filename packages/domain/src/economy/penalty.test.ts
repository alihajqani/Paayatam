import { describe, expect, it } from 'vitest';
import type { CancellationBucket } from '@payetam/db';
import { bucketForLateness } from './penalty.service';

/**
 * The thresholds, as a table (plan §11, M10).
 *
 * Pure and therefore fast, which is what lets it be exhaustive around the two
 * boundaries rather than sampling them. The database tests then check that the
 * *prices* attached to these buckets are the ones charged; this file checks only
 * that the right bucket is chosen, which is the half that is easy to get wrong by
 * one minute in either direction.
 *
 * Both boundaries sit on the cheaper side: exactly 24 hours out is `H24_TO_H3`,
 * and exactly 3 hours out is `H24_TO_H3` as well. A threshold that bites at
 * exactly its own name surprises the person standing on it, so where the
 * comparison is arguable it rounds towards charging less.
 */

const START = new Date('2026-09-20T15:00:00.000Z');

/** `hours` before the event, expressed as a moment. */
function at(hours: number): Date {
  return new Date(START.getTime() - hours * 3_600_000);
}

/** The plan's own list: inside grace, 25 h, 23 h, 3 h 01 m, 2 h 59 m, no-show. */
const CASES: Array<[label: string, when: Date, expected: CancellationBucket]> = [
  ['a week out', at(168), 'GT_24H'],
  ['25 hours out', at(25), 'GT_24H'],
  ['24 hours and one minute out', at(24 + 1 / 60), 'GT_24H'],
  ['exactly 24 hours out', at(24), 'H24_TO_H3'],
  ['23 hours out', at(23), 'H24_TO_H3'],
  ['3 hours and one minute out', at(3 + 1 / 60), 'H24_TO_H3'],
  ['exactly 3 hours out', at(3), 'H24_TO_H3'],
  ['2 hours 59 minutes out', at(2 + 59 / 60), 'LT_3H'],
  ['one minute out', at(1 / 60), 'LT_3H'],
  ['exactly at the start', START, 'LT_3H'],
  // Cancelling after the start is still a cancellation, and the latest bucket is
  // the one it belongs in. Nothing cheaper can be argued for it.
  ['an hour after it began', at(-1), 'LT_3H'],
];

describe('cancellation thresholds (plan §11)', () => {
  it.each(CASES)('puts %s in %s', (_label, when, expected) => {
    expect(bucketForLateness(START, when)).toBe(expected);
  });

  /**
   * The boundaries, swept a minute at a time.
   *
   * A table of named cases proves the points somebody thought of; this proves
   * there is no third answer hiding between them, which is where an off-by-one in
   * a comparison actually lives.
   */
  it('changes bucket exactly once on each side of 24 hours', () => {
    const seen = new Set<CancellationBucket>();
    for (let minutes = 23 * 60; minutes <= 25 * 60; minutes += 1) {
      seen.add(bucketForLateness(START, at(minutes / 60)));
    }
    expect([...seen].sort()).toEqual(['GT_24H', 'H24_TO_H3']);
  });

  it('changes bucket exactly once on each side of 3 hours', () => {
    const seen = new Set<CancellationBucket>();
    for (let minutes = 2 * 60; minutes <= 4 * 60; minutes += 1) {
      seen.add(bucketForLateness(START, at(minutes / 60)));
    }
    expect([...seen].sort()).toEqual(['H24_TO_H3', 'LT_3H']);
  });

  /**
   * Every threshold is a difference between two instants, so it cannot depend on
   * a timezone at all — and that is the property worth pinning, because the
   * obvious wrong implementation (formatting both sides into Tehran local time
   * and subtracting) would break here.
   *
   * The Tehran boundary that *does* matter is `startOfDayIn`, which the quota and
   * the attendance cap use, and which has its own tests. This asserts that
   * cancellation is not one of them.
   */
  it('is a difference between instants, so no Tehran boundary can move it', () => {
    // 2026-03-21T00:15 Tehran is 2026-03-20T20:45Z: a moment on one side of
    // Tehran's midnight and the other side of UTC's.
    const startsAt = new Date('2026-03-21T00:15:00.000+03:30');
    const fourHoursBefore = new Date(startsAt.getTime() - 4 * 3_600_000);
    const twoHoursBefore = new Date(startsAt.getTime() - 2 * 3_600_000);

    expect(bucketForLateness(startsAt, fourHoursBefore)).toBe('H24_TO_H3');
    expect(bucketForLateness(startsAt, twoHoursBefore)).toBe('LT_3H');
  });
});
