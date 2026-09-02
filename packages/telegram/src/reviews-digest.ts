import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { formatJalali } from './wizard/jalali';

/** One line: who is owed a review, for what, and by when. */
export interface PendingReviewLine {
  revieweeDisplayName: string;
  eventTitle: string;
  deadlineAt: Date;
  /**
   * When this one becomes writable, if it is not yet (v0.7.0).
   *
   * Null for a window that is open. Present for one that is not, and the whole
   * reason the field exists: «نظر منتظری ندارید» was the answer to three
   * different states — the window has not opened, the settlement sweep has not
   * run, and there is genuinely nothing — and a host who had just held an
   * activity read the first as the third.
   */
  opensAt: Date | null;
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
  /**
   * The writable ones first, and the waiting ones after them.
   *
   * The star rows below the message are numbered against this order and only the
   * writable entries get one, so a not-yet-open entry must never sit *between*
   * two that have buttons — the numbering would stop matching and somebody would
   * rate the wrong stranger. Keeping them at the tail means row `n` is entry `n`
   * for every row drawn.
   */
  const open = lines.filter((line) => line.opensAt === null);
  const waiting = lines.filter((line) => line.opensAt !== null);

  const entries = [...open, ...waiting].map((line, index) => {
    const when =
      line.opensAt === null
        ? `  ⏳ تا ${formatJalali(line.deadlineAt)}`
        : `  🔒 از ${formatJalali(line.opensAt)} می‌توانید بنویسید`;

    return (
      `<b>${toPersianDigits(String(index + 1))}. ${escapeHtml(line.revieweeDisplayName)}</b>\n` +
      `  🎟 ${escapeHtml(line.eventTitle)}\n` +
      `${when}`
    );
  });

  const digest = buildDigest({
    title: 'نظرهایی که هنوز ننوشته‌اید',
    /**
     * Why there is nothing, rather than only that there is nothing.
     *
     * The window opens once the activity is over *and* the host has had time to
     * report a no-show, so «هنوز چیزی نیست» in the hours after an evening is the
     * correct state and reads exactly like a broken feature. The sentence names
     * the condition instead.
     */
    empty:
      'نظر منتظری ندارید. پس از پایان هر فعالیتی که در آن شرکت کرده‌اید و ' +
      'گذشتن چند ساعت، فرصت نوشتن نظر باز می‌شود و همین‌جا نشان داده می‌شود.',
    entries,
  });

  if (entries.length === 0) return digest;
  if (open.length === 0) {
    return `${digest}\n\n<i>هنوز هیچ‌کدام باز نشده‌اند؛ کمی بعد دوباره سر بزنید.</i>`;
  }

  return (
    `${digest}\n\n` +
    `<i>ردیف‌های ستاره زیر با شمارهٔ همین فهرست مشخص شده‌اند: ردیف «۱» برای نفر ۱، ` +
    `ردیف «۲» برای نفر ۲ و همین‌طور تا آخر.</i>`
  );
}
