import { EVENT_STATUS_FA, type EventStatus } from '@payetam/shared';
import { encodeMyEventsCallback } from './callback-data';
import { ENTRY_SEPARATOR } from './discover-digest';
import { escapeHtml, toPersianDigits } from './escape';
import { myEventCommandFor } from './event-code';
import type { InlineButton } from './keyboards';
import { formatJalali, formatJalaliTime } from './wizard/jalali';

/**
 * A glyph per status, so a list of six is scannable without reading.
 *
 * Deliberately not a colour or a traffic light: «منقضی» is not a failure and
 * «منتشرشده» is not a success — they are stages, and the mark says which stage
 * rather than how the host should feel about it.
 */
const STATUS_MARK: Record<EventStatus, string> = {
  DRAFT: '📝',
  PENDING_MODERATION: '⏳',
  PUBLISHED: '✅',
  HIDDEN: '🙈',
  REJECTED: '⛔️',
  CANCELLED_BY_HOST: '✖️',
  ONGOING: '▶️',
  COMPLETED: '🏁',
  EXPIRED: '🕓',
  DELETED: '🗑',
};

/** One line of the host's list: the activity, its stage, and how to open it. */
export interface MyEventLine {
  title: string;
  startsAt: Date;
  status: EventStatus;
  acceptedCount: number;
  capacity: number;
  /** The activity's public id — the command that opens it is derived from this. */
  publicId: string;
}

/**
 * «فعالیت‌های من» — what the sender is hosting, newest first.
 *
 * ── Why this stopped being a console ────────────────────────────────────────
 *
 * It used to carry five buttons per activity: guests, cancel, republish,
 * invite, boost. Six activities is thirty buttons — a keyboard several screens
 * tall, in which every label is a number and an emoji, and two of the buttons
 * spend coins. «انتشار دوباره» on the wrong activity costs money, and the only
 * thing standing between a host and that was matching «۴» in a keyboard to «۴»
 * in a list they had scrolled past.
 *
 * So the list is a list: name, when, how full, what stage it is at, and the
 * command that opens it. The actions live under the activity they act on, where
 * there is exactly one of each and no number to match.
 *
 * ── Why the seats and the stage are still here ──────────────────────────────
 *
 * They are what a host checks *without* opening anything. «۳ از ۶» answers "do
 * I still need people?", and the stage mark answers "why is nobody joining" —
 * which for a held or expired activity is the whole answer. Making either of
 * those a tap away would make the list worth less than the command that opens
 * one.
 */
export function formatMyEvents(lines: readonly MyEventLine[], page = 0): string {
  if (lines.length === 0) {
    return (
      `<b>فعالیت‌های من</b>\n\n` +
      `هنوز فعالیتی نساخته‌اید. با دکمهٔ «➕ ساختن فعالیت» اولی را بسازید.`
    );
  }

  const entries = lines.map((line, index) => {
    const seats = `${toPersianDigits(String(line.acceptedCount))} از ${toPersianDigits(
      String(line.capacity),
    )}`;
    const number = toPersianDigits(String(page * lines.length + index + 1));
    const command = myEventCommandFor(line.publicId);

    /**
     * Jalali, and the stage on its own line.
     *
     * This read «🗓 ۰۷/۰۹/۲۰۲۶, ۱۲:۰۰» in production — a Gregorian date in
     * Persian digits, which is the worst of both: a Persian reader has to
     * convert it, and the digits stop them recognising it as Gregorian and doing
     * so quickly. «۱۶ شهریور ۱۴۰۵ — ۱۲:۰۰» is what the host wrote into the
     * wizard.
     *
     * The stage moves off the seats line because «۰ از ۶ · منقضی» reads as one
     * fact and is two, and the one that matters — that an activity has expired —
     * was the one being crowded out.
     */
    return (
      `<b>${number}. ${escapeHtml(line.title)}</b>\n` +
      `🗓 ${formatJalali(line.startsAt)} — ساعت ${formatJalaliTime(line.startsAt)}\n` +
      `👥 ${seats} جا · ${STATUS_MARK[line.status]} ${EVENT_STATUS_FA[line.status]}` +
      (command === null ? '' : `\n${command}`)
    );
  });

  return `<b>فعالیت‌های من</b>\n\n${entries.join(`\n${ENTRY_SEPARATOR}\n`)}`;
}

/**
 * «قبلی · صفحهٔ ۲ · بعدی» for the host's own list, or nothing when it fits.
 *
 * The same shape and the same argument as `discoverPageRow` — the page number is
 * a label rendered as a button because Telegram has no other way to put a word
 * in the middle of a row, and re-running the current page is a harmless no-op.
 * A separate function rather than a shared one because the payloads differ: this
 * list has no filters to carry, and a shared helper would have to be told which
 * codec to use, which is the whole of what it does.
 */
export function myEventsPageRow(page: number, hasNext: boolean): InlineButton[][] {
  if (page === 0 && !hasNext) return [];

  const row: InlineButton[] = [];
  if (page > 0) {
    row.push({ text: '‹ قبلی', callbackData: encodeMyEventsCallback(page - 1) });
  }
  row.push({
    text: `صفحهٔ ${toPersianDigits(String(page + 1))}`,
    callbackData: encodeMyEventsCallback(page),
  });
  if (hasNext) {
    row.push({ text: 'بعدی ›', callbackData: encodeMyEventsCallback(page + 1) });
  }

  return [row];
}

/** Everything a host's own activity says, for the screen a `/myevent_…` opens. */
export interface OwnedEventLine {
  title: string;
  description: string;
  categoryName: string;
  /** City, or «city — district» when the activity names one. */
  where: string;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
  capacity: number;
  acceptedCount: number;
  pendingCount: number;
  costType: string;
  costAmount: number | null;
}

const COST_TYPE_FA: Record<string, string> = {
  FREE: 'رایگان',
  APPROX: 'تقریبی',
  FIXED: 'مبلغ ثابت',
  SPLIT: 'دنگی',
};

/**
 * One of the host's own activities, in full.
 *
 * ── Why this is not `formatEventDetail` ─────────────────────────────────────
 *
 * That renders what a **stranger** may see, and its argument for what it leaves
 * out — no exact address, no contact details — is about somebody who has not
 * been accepted yet. A host is not that reader: they are looking at their own
 * activity to decide what to do with it, and the two facts they need are the
 * ones a public screen must never carry a hint of — what stage it is at, and how
 * many people are waiting on them.
 *
 * The disclaimer is absent for the same reason. It is a liability statement
 * addressed to somebody deciding whether to meet strangers; the host wrote the
 * activity.
 */
export function formatOwnedEvent(line: OwnedEventLine): string {
  const remaining = Math.max(line.capacity - line.acceptedCount, 0);
  const cost =
    line.costType === 'FREE'
      ? 'رایگان'
      : `${COST_TYPE_FA[line.costType] ?? line.costType}` +
        (line.costAmount === null ? '' : ` — ${toPersianDigits(String(line.costAmount))} تومان`);

  /**
   * Requests waiting on a decision, named only when there are any.
   *
   * A host who has nothing to answer should not read a line telling them so —
   * «۰ درخواست در انتظار» is a row of noise on every activity that is going
   * fine, and it makes the one that is not indistinguishable at a glance.
   */
  const pending =
    line.pendingCount > 0
      ? `\n⏳ ${toPersianDigits(String(line.pendingCount))} درخواست در انتظار پاسخ شما`
      : '';

  return (
    `<b>${escapeHtml(line.title)}</b>\n` +
    `${STATUS_MARK[line.status]} ${EVENT_STATUS_FA[line.status]}\n\n` +
    `${escapeHtml(line.description)}\n\n` +
    `🗂 ${escapeHtml(line.categoryName)}\n` +
    `📍 ${escapeHtml(line.where)}\n` +
    `🗓 ${formatJalali(line.startsAt)} — ${formatJalaliTime(line.startsAt)} تا ` +
    `${formatJalaliTime(line.endsAt)}\n` +
    `👥 ${toPersianDigits(String(line.acceptedCount))} از ` +
    `${toPersianDigits(String(line.capacity))} جا پر شده` +
    (remaining > 0 ? ` · ${toPersianDigits(String(remaining))} جای خالی` : ' · ظرفیت تکمیل') +
    `${pending}\n` +
    `💵 ${escapeHtml(cost)}`
  );
}
