import { PARTICIPANT_STATUS_GUEST_FA, type ParticipantStatus } from '@payetam/shared';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { eventCommandFor } from './event-code';
import { formatJalali, formatJalaliTime } from './wizard/jalali';
import { MAIN_MENU_LABEL, menuPathFor } from './keyboards';

/** One line of the digest: the event, when it is, and where the request stands. */
export interface MyRequestLine {
  title: string;
  startsAt: Date;
  status: ParticipantStatus;
  /** 1-based place in the queue, present only while WAITLISTED. */
  waitlistRank: number | null;
  /** The activity's public id, for the `/event_…` line that opens it. */
  eventPublicId: string;
}

/**
 * The statuses whose activity is still worth opening. A settled request's page
 * answers «not found» once the activity is over, and a link that exists to be
 * refused is worse than none — the same set `/requests` offers «لغو» on.
 */
const LINKED: ReadonlySet<ParticipantStatus> = new Set(['PENDING', 'WAITLISTED', 'ACCEPTED']);

/**
 * `/requests` — what the sender has asked to join, newest first.
 *
 * **Rendered here rather than in the service**, for the reason `channel.ts` and
 * `invitation.ts` render there: Persian presentation lives in this package, and a
 * service that builds message bodies is a service that has to be read to find out
 * what a user sees.
 *
 * The result is passed to `BOT_REQUESTS` as one `text` scalar rather than as an
 * array, because a notification payload holds scalars (invariant 7 — public ids
 * and numbers, never an object somebody spread) and this is a snapshot answer to
 * a question asked at a moment, not a live view.
 *
 * `escapeHtml` on the title because it is a stranger's words rendered into an
 * HTML-parse-mode message.
 *
 * Numbered because the live ones carry a «لغو» button, and a button cannot hold
 * an event title — «۲ لغو» next to a numbered list is unambiguous where five
 * identical labels would not be. Standing down from the wrong activity is not a
 * mis-tap anybody wants to make.
 */
export function formatMyRequests(lines: readonly MyRequestLine[]): string {
  const entries = lines.map((line, index) => {
    const rank =
      line.status === 'WAITLISTED' && line.waitlistRank !== null
        ? ` (نفر ${toPersianDigits(String(line.waitlistRank))})`
        : '';

    // The way back to the activity, and to the host through it (review H2): an
    // accepted guest had no tap anywhere that opened the page.
    const command = LINKED.has(line.status) ? eventCommandFor(line.eventPublicId) : null;

    return (
      `<b>${toPersianDigits(String(index + 1))}. ${escapeHtml(line.title)}</b>\n` +
      `  🗓 ${formatJalali(line.startsAt)} — ${formatJalaliTime(line.startsAt)}\n` +
      `  ${PARTICIPANT_STATUS_GUEST_FA[line.status]}${rank}` +
      (command === null ? '' : `\n  ${command}`)
    );
  });

  return buildDigest({
    title: 'درخواست‌های شما',
    empty: `هنوز درخواستی نداده‌اید. از «${MAIN_MENU_LABEL}» ← «${menuPathFor('discover') ?? 'فعالیت‌ها'}» شروع کنید.`,
    entries,
  });
}
