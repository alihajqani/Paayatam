import { encodeTrustCallback } from './callback-data';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import type { InlineButton } from './keyboards';
import { formatJalali } from './wizard/jalali';

/**
 * The Trust Score, and how it got there (v0.5.6).
 *
 * ── Why the history and not just the number ─────────────────────────────────
 *
 * `/profile` has shown the number since v0.4.x and ADR-0007's «a score nobody
 * can account for is a score nobody can appeal» has been true the whole time. A
 * number that moves for reasons a user cannot see is a number they cannot argue
 * with, and the two things that move it most — a review somebody left, a
 * cancellation — are exactly the ones worth being able to point at.
 *
 * The Mini App never showed this either. `GET /me/trust` returns the ledger and
 * no view rendered it, so this is not a port so much as the first place the
 * product keeps its own promise.
 *
 * ── What a row does not say ─────────────────────────────────────────────────
 *
 * Never *who*. A `REVIEW` row means "a review moved this"; naming the reviewer
 * would undo the double-blind the review pair exists to hold, and a score is
 * appealable without knowing which stranger wrote what.
 *
 * ── Five to a page, and a page control (v0.8.1) ─────────────────────────────
 *
 * `/wallet` grew this in v0.7.0 and `/trust` did not, so «سکه و امتیاز» was one
 * screen you could read all of and one you could not: twenty movements in a
 * single message with nothing to say there were more behind them, which for an
 * account with any history at all meant the rest was **unreachable from the bot**.
 * ADR-0007's «a score nobody can account for is a score nobody can appeal» is
 * not satisfied by showing the most recent twentieth of it.
 *
 * Five, so the score itself is still above the fold, and «قبلی»/«بعدی» reach the
 * rest — a callback on the same message, exactly as the wallet and the discovery
 * list do it. A page per message would rebuild the wall this removes.
 */
export interface TrustLine {
  delta: number;
  scoreAfter: number;
  type: string;
  createdAt: Date;
}

const TRUST_TYPE_FA: Record<string, string> = {
  INITIAL: 'امتیاز آغازین',
  PROFILE_COMPLETE: 'کامل کردن نمایه',
  ATTENDANCE: 'شرکت در فعالیت',
  REVIEW: 'نظری که دریافت کردید',
  CANCELLATION: 'لغو درخواست',
  NO_SHOW: 'غیبت بدون اطلاع',
  MODERATION: 'تصمیم پشتیبانی',
  REHABILITATION: 'بازیابی امتیاز',
  ADMIN_ADJUSTMENT: 'اصلاح توسط پشتیبانی',
  REVERSAL: 'برگشت',
};

export function trustLabelFa(type: string): string {
  return TRUST_TYPE_FA[type] ?? type;
}

export function formatTrust(
  score: number,
  lines: readonly TrustLine[],
  /** Zero-based, so the heading can say «صفحهٔ ۲» without arithmetic elsewhere. */
  page = 0,
): string {
  const entries = lines.map((line) => {
    // U+2212, not a hyphen: it is digit-width, so a column of deltas aligns.
    const sign = line.delta < 0 ? '−' : '+';
    const delta = `${sign}${toPersianDigits(String(Math.abs(line.delta)))}`;

    return (
      `<b>${delta}</b> — ${escapeHtml(trustLabelFa(line.type))}\n` +
      `  🗓 ${formatJalali(line.createdAt)} · امتیاز پس از آن: ${toPersianDigits(
        String(line.scoreAfter),
      )}`
    );
  });

  const heading =
    `<b>امتیاز اعتماد شما</b>\n\n⭐️ ${toPersianDigits(String(score))} از ۱۰۰\n\n` +
    `<i>این امتیاز با شرکت در فعالیت‌ها و نظرهایی که می‌گیرید بالا می‌رود، ` +
    `و با لغو دیرهنگام یا غیبت پایین می‌آید.</i>`;

  /**
   * «تغییرهای اخیر» only on the first page.
   *
   * On page three these are not recent, and a heading that says they are lies
   * about what the reader is looking at — the same rule `formatWallet` follows.
   */
  const history = buildDigest({
    title: page === 0 ? 'تغییرهای اخیر' : `تغییرها — صفحهٔ ${toPersianDigits(String(page + 1))}`,
    empty: page === 0 ? 'هنوز تغییری ثبت نشده است.' : 'تغییر دیگری نیست.',
    entries,
  });

  return `${heading}\n\n${history}`;
}

/**
 * «قبلی» / «بعدی» under the score's history, or nothing when one page is all
 * there is.
 *
 * The middle button re-draws the page it is already on, exactly as
 * `walletPageRow` does: it labels where the reader is, and a control that only
 * ever moves gives them no way to refresh a screen they left open while a review
 * landed underneath it.
 */
export function trustPageRow(page: number, hasNext: boolean): InlineButton[][] {
  if (page === 0 && !hasNext) return [];

  const row: InlineButton[] = [];
  if (page > 0) row.push({ text: '‹ قبلی', callbackData: encodeTrustCallback(page - 1) });
  row.push({
    text: `صفحهٔ ${toPersianDigits(String(page + 1))}`,
    callbackData: encodeTrustCallback(page),
  });
  if (hasNext) row.push({ text: 'بعدی ›', callbackData: encodeTrustCallback(page + 1) });

  return [row];
}
