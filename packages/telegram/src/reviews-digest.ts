import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { formatJalali } from './wizard/jalali';

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
 * ── The rating is here; the tags and the comment are not ────────────────────
 *
 * This said «No rating buttons» and sent people to a form, on the argument that
 * a review is a rating *and* tags *and* a comment. The argument held until there
 * was nowhere to send them: the form lived in the Mini App and v0.4.6 removed
 * the last button that opened it, so what this rendered was a list of things you
 * owed and could not pay.
 *
 * A row of five ratings per entry, in the digest's own order. The rating is the
 * part that moves the Trust Score and the part almost everybody fills in, and a
 * review that gets written is worth more than a richer one that does not. Tags
 * and the comment remain a gap and want a wizard; `review.edit_window_minutes`
 * is what will let it amend a rating already given.
 *
 * The entries are numbered because the rows are, and a keyboard has no labels —
 * row two belongs to entry two, and reviewing the wrong stranger is not a
 * mis-tap worth risking.
 */
export function formatPendingReviews(lines: readonly PendingReviewLine[]): string {
  const entries = lines.map(
    (line, index) =>
      `<b>${toPersianDigits(String(index + 1))}. ${escapeHtml(line.revieweeDisplayName)}</b>\n` +
      `  🎟 ${escapeHtml(line.eventTitle)}\n` +
      `  ⏳ تا ${formatJalali(line.deadlineAt)}`,
  );

  const digest = buildDigest({
    title: 'نظرهایی که هنوز ننوشته‌اید',
    empty: 'نظر منتظری ندارید. پس از هر فعالیت، فرصت نوشتن نظر باز می‌شود.',
    entries,
  });

  if (entries.length === 0) return digest;

  return (
    `${digest}\n\n` +
    `<i>ردیف‌های ستاره زیر با شمارهٔ همین فهرست مشخص شده‌اند: ردیف «۱» برای نفر ۱، ` +
    `ردیف «۲» برای نفر ۲ و همین‌طور تا آخر.</i>`
  );
}
