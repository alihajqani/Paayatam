import { EVENT_STATUS_FA, type EventStatus } from '@payetam/shared';
import { formatTehran } from './datetime';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';

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

    return (
      `• <b>${escapeHtml(line.title)}</b>\n` +
      `  🗓 ${formatTehran(line.startsAt)}\n` +
      `  👥 ${seats} · ${EVENT_STATUS_FA[line.status]}`
    );
  });

  return buildDigest({
    title: 'رویدادهای شما',
    empty: 'هنوز رویدادی نساخته‌اید.',
    entries,
  });
}
