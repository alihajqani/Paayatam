import { encodeWalletCallback } from './callback-data';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import type { InlineButton } from './keyboards';
import { formatJalali } from './wizard/jalali';

/**
 * `/wallet` — the balance, and where it came from.
 *
 * ── Why the ledger and not just the number ──────────────────────────────────
 *
 * `/balance` answers "how many" and has since M13. It does not answer "why is it
 * that number", which is the question somebody asks the moment it changes: an
 * event cost fifteen coins, a review paid one back, a cancellation took some. The
 * ledger is the answer and it lived only in `WalletView`, so the bot could tell
 * you your balance and not account for it — and ADR-0007's «a balance nobody can
 * account for is a balance nobody can appeal» applies to coins exactly as it
 * applies to the Trust Score.
 *
 * ── The sign is the whole reading ───────────────────────────────────────────
 *
 * A row is `+۱۵` or `−۱۵` and a Persian reader scans the column, so the sign is
 * rendered explicitly rather than left to a minus that `toPersianDigits` would
 * carry through unchanged. `−` is U+2212, not a hyphen: it aligns with digits.
 *
 * ── Five to a page, and a page control (v0.7.0) ─────────────────────────────
 *
 * It was twenty in one message, which is a wall of near-identical rows that
 * pushes the balance — the thing somebody opened `/wallet` to see — off the top
 * of the screen. And twenty was never the whole ledger either: it was a fixed
 * slice with nothing to say there was more behind it, so an account with fifty
 * movements had thirty that were unreachable from the bot at all.
 *
 * Five fits above the fold with the balance still visible, and «قبلی»/«بعدی»
 * reach the rest. The page is a **callback on the same message**, like the
 * discovery list and «فعالیت‌های من» — a second message per page would rebuild
 * exactly the wall this is removing.
 */
export interface WalletLine {
  amount: number;
  balanceAfter: number;
  type: string;
  createdAt: Date;
}

/**
 * What each ledger type means, in the language the user reads.
 *
 * Exhaustive over `CoinLedgerType` by hand rather than by a mapped type, because
 * this package deliberately does not depend on `@payetam/db` — the catalogue is
 * testable with no Prisma client and no database. `labelFor` falls back to the
 * raw value, so a type added by a newer deploy renders as itself rather than
 * disappearing from somebody's ledger.
 */
const LEDGER_TYPE_FA: Record<string, string> = {
  ONBOARDING_REWARD: 'هدیهٔ خوش‌آمد',
  REFERRAL_REWARD: 'پاداش معرفی',
  REVIEW_REWARD: 'پاداش نظر',
  GIFT_CODE_REDEEM: 'کد هدیه',
  BOOST_SPEND: 'ارتقای فعالیت',
  VIP_SPEND: 'اشتراک ویژه',
  EVENT_CREATE_SPEND: 'ساختن فعالیت',
  CHANNEL_POST_SPEND: 'انتشار در کانال',
  INVITE_SPEND: 'دعوت از افراد',
  EVENT_JOIN_SPEND: 'درخواست شرکت',
  CANCELLATION_PENALTY: 'جریمهٔ لغو',
  NO_SHOW_PENALTY: 'جریمهٔ غیبت',
  HOST_CANCELLATION_REFUND: 'بازگشت وجه لغو میزبان',
  ADMIN_ADJUSTMENT: 'اصلاح توسط پشتیبانی',
  REVERSAL: 'برگشت تراکنش',
};

export function ledgerLabelFa(type: string): string {
  return LEDGER_TYPE_FA[type] ?? type;
}

export function formatWallet(
  balance: number,
  lines: readonly WalletLine[],
  /** Zero-based, so the heading can say «صفحهٔ ۲» without arithmetic elsewhere. */
  page = 0,
): string {
  const entries = lines.map((line) => {
    // U+2212 rather than a hyphen: it is the width of a digit, so a column of
    // amounts lines up instead of ragging by one pixel per negative row.
    const sign = line.amount < 0 ? '−' : '+';
    const amount = `${sign}${toPersianDigits(String(Math.abs(line.amount)))}`;

    return (
      `<b>${amount}</b> — ${escapeHtml(ledgerLabelFa(line.type))}\n` +
      `  🗓 ${formatJalali(line.createdAt)} · موجودی پس از آن: ${toPersianDigits(
        String(line.balanceAfter),
      )}`
    );
  });

  const heading = `<b>کیف پول شما</b>\n\n💰 موجودی: ${toPersianDigits(String(balance))} سکه`;

  /**
   * «تراکنش‌های اخیر» only on the first page.
   *
   * On page three the rows are not recent, and a heading that says they are is
   * a heading that lies about what the reader is looking at.
   */
  const history = buildDigest({
    title:
      page === 0 ? 'تراکنش‌های اخیر' : `تراکنش‌ها — صفحهٔ ${toPersianDigits(String(page + 1))}`,
    empty: page === 0 ? 'هنوز تراکنشی ندارید.' : 'تراکنش دیگری نیست.',
    entries,
  });

  return `${heading}\n\n${history}`;
}

/**
 * «قبلی» / «بعدی» under the ledger, or nothing when one page is all there is.
 *
 * The middle button re-draws the page it is already on. That is deliberate and
 * `myEventsPageRow` does the same: it labels where the reader is, and a control
 * that only ever moves gives them no way to refresh a screen they have left open
 * while their balance changed underneath it.
 */
export function walletPageRow(page: number, hasNext: boolean): InlineButton[][] {
  if (page === 0 && !hasNext) return [];

  const row: InlineButton[] = [];
  if (page > 0) row.push({ text: '‹ قبلی', callbackData: encodeWalletCallback(page - 1) });
  row.push({
    text: `صفحهٔ ${toPersianDigits(String(page + 1))}`,
    callbackData: encodeWalletCallback(page),
  });
  if (hasNext) row.push({ text: 'بعدی ›', callbackData: encodeWalletCallback(page + 1) });

  return [row];
}
