import { PARTICIPANT_STATUS_GUEST_FA, type ParticipantStatus } from '@payetam/shared';
import { formatTehran } from './datetime';
import { escapeHtml, toPersianDigits } from './escape';

/** One line of the digest: the event, when it is, and where the request stands. */
export interface MyRequestLine {
  title: string;
  startsAt: Date;
  status: ParticipantStatus;
  /** 1-based place in the queue, present only while WAITLISTED. */
  waitlistRank: number | null;
}

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
 */
export function formatMyRequests(lines: readonly MyRequestLine[]): string {
  if (lines.length === 0) {
    return `<b>درخواست‌های شما</b>\n\n` + `هنوز درخواستی نداده‌اید. از «دیدن رویدادها» شروع کنید.`;
  }

  const rendered = lines.map((line) => {
    const rank =
      line.status === 'WAITLISTED' && line.waitlistRank !== null
        ? ` (نفر ${toPersianDigits(String(line.waitlistRank))})`
        : '';

    return (
      `• <b>${escapeHtml(line.title)}</b>\n` +
      `  🗓 ${formatTehran(line.startsAt)}\n` +
      `  ${PARTICIPANT_STATUS_GUEST_FA[line.status]}${rank}`
    );
  });

  return `<b>درخواست‌های شما</b>\n\n${rendered.join('\n\n')}`;
}
