import { formatTehran } from './datetime';
import { buildDigest } from './digest';
import { escapeHtml } from './escape';

/** One line: who is owed a review, for what, and by when. */
export interface PendingReviewLine {
  revieweeDisplayName: string;
  eventTitle: string;
  deadlineAt: Date;
}

/**
 * `/reviews` — the reviews the sender still owes, soonest deadline first.
 *
 * ── Why pending rather than received ─────────────────────────────────────────
 *
 * A received review is a fact that keeps; a pending one **expires**, and what
 * happens then is not nothing — `settleExpired` closes the pair, and a review
 * never written is a review the counterpart never gets. The deadline is the
 * whole reason this belongs in a bot: it is the one thing a user needs to be
 * reminded of rather than to go and look up.
 *
 * Reading your own received reviews is `ReviewsView`'s job and stays there. It
 * is a page somebody visits deliberately, not an answer to "what do I owe?".
 *
 * ── What is not here ─────────────────────────────────────────────────────────
 *
 * No rating buttons. A review is a rating *and* tags *and* an optional comment,
 * and submitting one from a keyboard would either drop two of the three or need
 * a wizard to collect them — which is the persisted multi-step state that keeps
 * every form in the Mini App. The button opens the form; this says it is
 * waiting and when it stops being possible.
 */
export function formatPendingReviews(lines: readonly PendingReviewLine[]): string {
  const entries = lines.map(
    (line) =>
      `• <b>${escapeHtml(line.revieweeDisplayName)}</b>\n` +
      `  🎟 ${escapeHtml(line.eventTitle)}\n` +
      `  ⏳ تا ${formatTehran(line.deadlineAt)}`,
  );

  return buildDigest({
    title: 'نظرهایی که هنوز ننوشته‌اید',
    empty: 'نظر منتظری ندارید. پس از هر فعالیت، فرصت نوشتن نظر باز می‌شود.',
    entries,
  });
}
