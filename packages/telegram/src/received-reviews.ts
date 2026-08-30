import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { formatJalali } from './wizard/jalali';

/**
 * What other people wrote about you (v0.6.0).
 *
 * ── Why this was the last thing missing ─────────────────────────────────────
 *
 * The bot could rate somebody from v0.5.0 and could not show you a word anybody
 * had written about *you*. `ReviewsView` was where received reviews lived and
 * v0.4.6 removed the last button to it, so a Trust Score moved for reasons its
 * owner could read nowhere — which is the same complaint ADR-0007 makes about a
 * score with no ledger, one level up.
 *
 * It is also what unblocks reporting a review: `POST /reviews/:publicId/report`
 * has existed since M12 and there was nothing in the bot to report *from*.
 *
 * ── Invariant 8 is not this file's to hold ──────────────────────────────────
 *
 * A review appears here only once its pair has revealed, and `listForUser`
 * enforces that on the *pair's* status rather than the review's — deliberately,
 * because a review is SUBMITTED both before its counterparty writes and while
 * the pair waits. This renders what it is handed and makes no judgement about
 * what should have been in the list.
 *
 * ── Who wrote it is never shown ─────────────────────────────────────────────
 *
 * Not a rendering choice: `RevealedReview` carries no author, because the double
 * blind is the point of a pair. «بدون بازخورد متقابل» is marked instead, which
 * is D7a's requirement — a review that arrived because the window closed rather
 * than because somebody reciprocated reads differently, and the reader is
 * entitled to know which.
 */
export interface ReceivedReviewLine {
  rating: number;
  tags: readonly string[];
  comment: string | null;
  submittedAt: Date;
  withoutCounterpart: boolean;
}

/** Five stars, filled to the rating. Easier to read at a glance than «۴ از ۵». */
function stars(rating: number): string {
  const filled = Math.max(0, Math.min(5, Math.round(rating)));
  return '⭐️'.repeat(filled) + '☆'.repeat(5 - filled);
}

export function formatReceivedReviews(
  lines: readonly ReceivedReviewLine[],
  tagLabel: (tag: string) => string,
): string {
  const entries = lines.map((line, index) => {
    const tags =
      line.tags.length === 0
        ? ''
        : `\n  ${line.tags.map((tag) => escapeHtml(tagLabel(tag))).join(' · ')}`;
    const comment = line.comment === null ? '' : `\n  «${escapeHtml(line.comment)}»`;
    const oneSided = line.withoutCounterpart ? '\n  <i>بدون بازخورد متقابل</i>' : '';

    return (
      `<b>${toPersianDigits(String(index + 1))}. ${stars(line.rating)}</b>` +
      `${tags}${comment}\n  🗓 ${formatJalali(line.submittedAt)}${oneSided}`
    );
  });

  const digest = buildDigest({
    title: 'نظرهایی که درباره شما نوشته‌اند',
    empty:
      'هنوز نظری درباره شما ثبت نشده است. نظرها پس از پایان فعالیت و نوشتن هر دو طرف نمایش داده می‌شوند.',
    entries,
  });

  if (entries.length === 0) return digest;

  return `${digest}\n\n<i>اگر نظری نامناسب است، از دکمهٔ هم‌شمارهٔ زیر گزارش کنید.</i>`;
}
