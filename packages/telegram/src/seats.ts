import { isUnlimitedCapacity } from '@payetam/shared';
import { toPersianDigits } from './escape';

/**
 * «چند جا مانده» — in one place, because four screens say it.
 *
 * The discovery list, the detail screen, the host's own console and the channel
 * post all rendered `capacity - acceptedCount` themselves, and all four would
 * have had to learn about `UNLIMITED_CAPACITY` separately. The one that was
 * missed would have advertised «۹۹۸ جای خالی از ۱۰۰۰».
 *
 * Three readings, and they are genuinely different sentences rather than one
 * with a number in it:
 *
 *  * **Unlimited** — the host said there is no limit, so there is no shortage to
 *    report and no total to divide by. It stays true as people join.
 *  * **Full** — «ظرفیت تکمیل», which since v0.6.5 is a real state a reader can
 *    still act on: a full activity is joinable, into the waiting list.
 *  * **Anything else** — the number left, and the total beside it, because «۳
 *    جای خالی» on a party of thirty reads differently from «۳ جای خالی» on a
 *    hike of four.
 */
export function seatsLine(capacity: number, acceptedCount: number): string {
  if (isUnlimitedCapacity(capacity)) return 'بدون محدودیت';

  const remaining = Math.max(capacity - acceptedCount, 0);
  if (remaining === 0) return 'ظرفیت تکمیل';

  return `${toPersianDigits(String(remaining))} جای خالی از ${toPersianDigits(String(capacity))}`;
}

/** The same fact for a screen that has already computed what is left. */
export function seatsLineFromRemaining(capacity: number, remainingCapacity: number): string {
  return seatsLine(capacity, capacity - remainingCapacity);
}

/**
 * How full an activity is, as one of four colours: 🟢 empty → 🟡 → 🟠 → 🔴 full.
 *
 * A scale with one end each, as the operator asked for it: green is room, red
 * is none, and the two between say "going" and "nearly gone". The thresholds
 * are on the share of seats taken, with one exception that matters on the small
 * activities this product mostly carries — **the last seat is always orange**.
 * By ratio alone the last of three is 67% and would read yellow, and «یک جا
 * مانده» is exactly the moment a reader should feel the hurry.
 *
 *  * 🔴 nothing left
 *  * 🟠 somebody is in and one seat is left, or three quarters are taken
 *  * 🟡 half or more taken
 *  * 🟢 anything less, and every unlimited activity
 *
 * "Somebody is in" keeps a capacity-one activity nobody has asked about green:
 * its one seat is also its last, and an empty activity is not nearly full.
 */
export function seatsFillEmoji(capacity: number, takenCount: number): string {
  if (isUnlimitedCapacity(capacity) || capacity <= 0) return '🟢';

  const taken = Math.min(Math.max(takenCount, 0), capacity);
  const remaining = capacity - taken;
  if (remaining === 0) return '🔴';

  const share = taken / capacity;
  if (taken > 0 && (remaining === 1 || share >= 0.75)) return '🟠';
  if (share >= 0.5) return '🟡';
  return '🟢';
}

/** «ظرفیت ۶ نفر» / «ظرفیت بدون محدودیت», for a screen that states the total. */
export function capacityLabel(capacity: number): string {
  return isUnlimitedCapacity(capacity)
    ? 'بدون محدودیت'
    : `${toPersianDigits(String(capacity))} نفر`;
}
