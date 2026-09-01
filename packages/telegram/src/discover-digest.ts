import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { escapeHtml, toPersianDigits } from './escape';
import { eventCommandFor } from './event-code';
import { formatJalali, formatJalaliTime } from './wizard/jalali';

/** One line of the discovery list: what it is, when, room, and how to open it. */
export interface DiscoverLine {
  title: string;
  startsAt: Date;
  capacity: number;
  remainingCapacity: number;
  /** The activity's public id — the command that opens it is derived from this. */
  publicId: string;
}

/**
 * The separator between two activities.
 *
 * Ten of them, which is about the width of a phone in this font. A list whose
 * entries are separated by a blank line reads as one wall of text the moment any
 * entry wraps — and every entry here wraps, because a title plus a date plus a
 * command is three lines. The rule makes each activity a card.
 */
export const ENTRY_SEPARATOR = '〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️';

/**
 * `/discover` — activities in the sender's own city, soonest first.
 *
 * ── Why it is a list of commands and not a keyboard ─────────────────────────
 *
 * It used to carry two inline buttons per activity — «۱ جزئیات», «۱ پیوستن» —
 * which is a keyboard taller than the list it sits under, and every label is a
 * number the reader has to match back to a line. Ten tap targets, none of them
 * next to the thing they act on.
 *
 * Now each activity ends with `/event_…`, which Telegram renders as a tap target
 * **on the line it belongs to**. The keyboard is freed for the two controls that
 * are about the list rather than about one activity: paging, and the filters.
 *
 * ── What each entry says ────────────────────────────────────────────────────
 *
 * Name, date, time, room. Four facts, which is what somebody scanning a list
 * decides on — the category and the neighbourhood moved to the detail screen,
 * because they are what you read *after* something has caught your eye, and
 * seven lines per activity is a list nobody reaches the bottom of.
 *
 * ── The disclaimer ───────────────────────────────────────────────────────────
 *
 * Once, at the top, covering every activity below it, exactly as a channel post
 * carries it above the one activity it is about. It is a liability statement and
 * it is not optional: an activity listed without it is one this product is
 * silently vouching for. Escaped like everything else, even though it is our own
 * constant — the day somebody puts an angle bracket in it, the message should
 * not break.
 */
export function formatDiscovered(
  lines: readonly DiscoverLine[],
  /**
   * How many activities precede this page — **not** the page number.
   *
   * Derived from the page and the page *size*, which the caller knows and this
   * does not: computing it from `lines.length` was wrong on the last page, where
   * two results on page two numbered themselves ۳ and ۴ rather than ۶ and ۷.
   */
  offset = 0,
): string {
  if (lines.length === 0) {
    return (
      `<b>فعالیت‌های نزدیک شما</b>\n\n` +
      `با این فیلترها فعالیتی پیدا نشد. فیلترها را باز کنید و بازه یا دسته را عوض کنید.`
    );
  }

  const entries = lines.map((line, index) => {
    /**
     * «۳ جای خالی از ۶» — the number somebody scanning a list actually decides
     * on, and the total beside it so «۳ جای خالی» on a party of thirty reads
     * differently from «۳ جای خالی» on a hike of four. A full activity is not
     * silently rendered as zero: `hasCapacity` filters those out upstream, and
     * if one slips through, saying so beats an empty count.
     */
    const seats =
      line.remainingCapacity > 0
        ? `${toPersianDigits(String(line.remainingCapacity))} جای خالی از ` +
          `${toPersianDigits(String(line.capacity))}`
        : 'ظرفیت تکمیل';

    // Numbered from the top of the *page*, so the reader's «۳» is the third
    // thing they can see rather than the third of a set they cannot.
    const number = toPersianDigits(String(offset + index + 1));
    const command = eventCommandFor(line.publicId);

    return (
      `<b>${number}. ${escapeHtml(line.title)}</b>\n` +
      `🗓 ${formatJalali(line.startsAt)} — ساعت ${formatJalaliTime(line.startsAt)}\n` +
      `👥 ${seats}` +
      // An activity whose public id is malformed gets no command rather than a
      // broken one: the line is still readable, and nothing renders `/event_null`.
      (command === null ? '' : `\n${command}`)
    );
  });

  return (
    `<b>فعالیت‌های نزدیک شما</b>\n\n` +
    `${entries.join(`\n${ENTRY_SEPARATOR}\n`)}\n\n` +
    `<i>${escapeHtml(EVENT_DISCLAIMER_SHORT_FA)}</i>`
  );
}
