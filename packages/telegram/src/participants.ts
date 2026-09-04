import { PARTICIPANT_STATUS_GUEST_FA, type ParticipantStatus } from '@payetam/shared';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { foundingBadge } from './founding';

/**
 * Who is coming (v0.6.2).
 *
 * ── The screen three earlier batches needed and none could build ────────────
 *
 * `markNoShow` takes a participant public id, and until now the bot had no way
 * to name one: `/myevents` counts guests and `GET events/:publicId/participants`
 * had no bot equivalent, so a host could see that four people were coming and
 * nothing about who, and could not record that one of them did not turn up.
 *
 * ── What a host is given, and what they are not ─────────────────────────────
 *
 * A display name and a Trust Score. That is the same pair
 * `ParticipantSummary` gives the Mini App, and the reasoning is its own: a host
 * accepting somebody into a real-world meeting is exactly the moment where "has
 * this person behaved" is a legitimate question. **Nothing from the trust ledger
 * comes with it** — the number, never its history, because the history is a
 * record of specific incidents and belongs to the person they happened to.
 *
 * Null is «تازه‌وارد», never zero. A brand-new account has no row and has done
 * nothing wrong.
 */
export interface ParticipantLine {
  displayName: string;
  trustScore: number | null;
  /**
   * The launch-campaign tier, or null (v0.9.0). Never the rank — see
   * `foundingBadge`, which also explains why a number here would collide with
   * the two this line already carries.
   */
  foundingTier: number | null;
  status: ParticipantStatus;
  waitlistRank: number | null;
}

export function formatParticipants(eventTitle: string, lines: readonly ParticipantLine[]): string {
  const entries = lines.map((line, index) => {
    const trust =
      line.trustScore === null ? 'تازه‌وارد' : `${toPersianDigits(String(line.trustScore))} از ۱۰۰`;
    const rank =
      line.status === 'WAITLISTED' && line.waitlistRank !== null
        ? ` (نفر ${toPersianDigits(String(line.waitlistRank))})`
        : '';

    return (
      `<b>${toPersianDigits(String(index + 1))}. ${escapeHtml(line.displayName)}</b>` +
      `${foundingBadge(line.foundingTier)}\n` +
      `  ⭐️ ${trust}\n` +
      `  ${PARTICIPANT_STATUS_GUEST_FA[line.status]}${rank}`
    );
  });

  const digest = buildDigest({
    title: `مهمان‌های «${escapeHtml(eventTitle)}»`,
    empty: 'هنوز کسی درخواست نداده است.',
    entries,
  });

  if (entries.length === 0) return digest;

  return (
    `${digest}\n\n` +
    `<i>دکمه‌های زیر با شمارهٔ همین فهرست مشخص شده‌اند: دکمهٔ «۱» برای نفر ۱، ` +
    `دکمهٔ «۲» برای نفر ۲ و همین‌طور تا آخر.</i>`
  );
}
