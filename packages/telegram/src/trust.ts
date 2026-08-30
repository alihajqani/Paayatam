import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
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

export function formatTrust(score: number, lines: readonly TrustLine[]): string {
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

  const history = buildDigest({
    title: 'تغییرهای اخیر',
    empty: 'هنوز تغییری ثبت نشده است.',
    entries,
  });

  return `${heading}\n\n${history}`;
}
