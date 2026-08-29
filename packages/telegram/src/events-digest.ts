import { EVENT_STATUS_FA, type EventStatus } from '@payetam/shared';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
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

/** One line of the host's digest: the event, when it is, and how full it is. */
export interface MyEventLine {
  title: string;
  startsAt: Date;
  status: EventStatus;
  acceptedCount: number;
  capacity: number;
}

/**
 * `/myevents` — what the sender is hosting, newest first.
 *
 * Seats are the number a host actually checks, so they are on the line rather
 * than behind a tap: «۳ از ۶» answers "do I still need people?" without opening
 * anything, which is the whole point of the command existing.
 *
 * Rendered here for the reason `formatMyRequests` is — Persian presentation
 * belongs with every other message body — and passed on as one `text` scalar
 * because a notification payload holds scalars.
 */
export function formatMyEvents(lines: readonly MyEventLine[]): string {
  const entries = lines.map((line) => {
    const seats = `${toPersianDigits(String(line.acceptedCount))} از ${toPersianDigits(
      String(line.capacity),
    )}`;

    /**
     * Jalali, and the status on its own line.
     *
     * This read «🗓 ۰۷/۰۹/۲۰۲۶, ۱۲:۰۰» in production — a Gregorian date in
     * Persian digits, which is the worst of both: a Persian reader has to
     * convert it, and the digits stop them recognising it as Gregorian and doing
     * so quickly. `formatTehran` renders that way for a reason that has expired
     * (see `jalali.ts`), and «۱۶ شهریور ۱۴۰۵ — ۱۲:۰۰» is what the host wrote
     * into the wizard.
     *
     * The status moves off the seats line because «۰ از ۶ · منقضی» reads as one
     * fact and is two, and the one that matters — that an event has expired — was
     * the one being crowded out.
     */
    return (
      `<b>${escapeHtml(line.title)}</b>\n` +
      `🗓 ${formatJalali(line.startsAt)} — ${formatJalaliTime(line.startsAt)}\n` +
      `👥 ${seats} جا\n` +
      `${STATUS_MARK[line.status]} ${EVENT_STATUS_FA[line.status]}`
    );
  });

  return buildDigest({
    title: 'رویدادهای شما',
    empty: 'هنوز رویدادی نساخته‌اید.',
    entries,
  });
}
