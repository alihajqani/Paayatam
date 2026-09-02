import { describe, expect, it } from 'vitest';
import { UNLIMITED_CAPACITY } from '@payetam/shared';
import { capacityLabel, seatsLine, seatsLineFromRemaining } from './seats';

/**
 * The one sentence four screens say about seats.
 *
 * The discovery list, the detail screen, the host's console and the channel post
 * each computed `capacity - acceptedCount` themselves. All four would have had to
 * learn about the unlimited sentinel separately, and the one that was missed
 * would have advertised «۹۹۷ جای خالی از ۱۰۰۰».
 */
describe('seatsLine', () => {
  it('counts what is left, with the total beside it', () => {
    expect(seatsLine(6, 2)).toBe('۴ جای خالی از ۶');
  });

  it('says «ظرفیت تکمیل» rather than «۰ جای خالی»', () => {
    expect(seatsLine(6, 6)).toBe('ظرفیت تکمیل');
  });

  /** Overbooking is a CHECK violation, but a renderer must not print a negative. */
  it('floors at full rather than going negative', () => {
    expect(seatsLine(6, 9)).toBe('ظرفیت تکمیل');
  });

  it('never counts down from the unlimited sentinel', () => {
    expect(seatsLine(UNLIMITED_CAPACITY, 0)).toBe('بدون محدودیت');
    expect(seatsLine(UNLIMITED_CAPACITY, 40)).toBe('بدون محدودیت');
  });

  /** A host who typed 999 asked for a limit, and is shown one. */
  it('treats a large number under the sentinel as an ordinary limit', () => {
    expect(seatsLine(999, 0)).toBe('۹۹۹ جای خالی از ۹۹۹');
  });
});

describe('seatsLineFromRemaining', () => {
  it('agrees with the counting form', () => {
    expect(seatsLineFromRemaining(6, 4)).toBe(seatsLine(6, 2));
    expect(seatsLineFromRemaining(UNLIMITED_CAPACITY, 0)).toBe('بدون محدودیت');
  });
});

describe('capacityLabel', () => {
  it('names a total, or says there is not one', () => {
    expect(capacityLabel(6)).toBe('۶ نفر');
    expect(capacityLabel(UNLIMITED_CAPACITY)).toBe('بدون محدودیت');
  });
});
