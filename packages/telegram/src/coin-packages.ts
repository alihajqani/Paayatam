import { encodeBuyCallback } from './callback-data';
import { escapeHtml, toPersianAmount, toPersianDigits } from './escape';
import type { InlineButton } from './keyboards';

/**
 * «خرید سکه» — the price list, and the only toman figures this product quotes
 * (ADR-0019).
 *
 * ── Why a price list and not a checkout ─────────────────────────────────────
 *
 * There is no payment gateway. Somebody transfers money to a bank account and a
 * human being confirms the deposit in their banking app before granting the
 * coins from the admin panel — «هرگز قبل از دیدن واریز در اپلیکیشن بانک، سکه
 * نده» is the one rule the economy plan writes without an exception, because a
 * screenshot of a receipt is the easiest thing in this flow to forge.
 *
 * So this screen ends at a handle rather than at a button that takes money, and
 * the product records **no order**: the only trace of a sale is the bank's and
 * the `coin_ledger` row the operator writes afterwards. That is also why it is
 * cheap — no state, no table, no webhook to get wrong, and nothing to reconcile
 * if somebody walks away half-way through.
 *
 * ── Why it exists at all ────────────────────────────────────────────────────
 *
 * Until this, a user whose free coins ran out had **no way to learn that buying
 * more was possible**. The economy had a spend side and no entrance: the only
 * routes to a coin were the onboarding gift, a referral, a review, a gift code,
 * the founding tier and a comeback grant — every one of them capped, and most
 * once-per-lifetime. Somebody who hit the end of that was not asked to pay; they
 * were shown a wall. Revenue was zero because the product never mentioned it.
 *
 * ── The ladder ──────────────────────────────────────────────────────────────
 *
 * Per-coin price is shown for every tier because the ladder only works if it can
 * be compared: the small package is deliberately priced **above** the reference
 * price so that the medium one — the tier meant to carry most sales, and the
 * only one marked — reads as the sensible choice. That is plan §6's design, not
 * an error to correct.
 *
 * A discount is named only when it reaches ten per cent. Below that it is noise
 * on a screen whose job is one comparison, and the per-coin figure already says
 * it to anybody doing the arithmetic.
 */
export interface CoinPackage {
  /** «کوچک», «میانه» … — the name somebody types to the operator. */
  name: string;
  coins: number;
  toman: number;
  /** The one tier the screen marks. Exactly one, or the mark means nothing. */
  featured?: boolean;
}

/** Below this, a discount is noise rather than a reason. */
const DISCOUNT_FLOOR = 0.1;

/**
 * One row of the table.
 *
 * `escapeHtml` on the name because it is operator-facing copy that reaches a
 * `parse_mode: HTML` message — these four are constants today, and the escape is
 * what keeps that from being load-bearing.
 */
function packageLine(entry: CoinPackage, referencePrice: number): string {
  const perCoin = Math.round(entry.toman / entry.coins);
  const discount = referencePrice > 0 ? 1 - perCoin / referencePrice : 0;

  const bullet = entry.featured === true ? '★' : '•';
  const head =
    `${bullet} <b>${escapeHtml(entry.name)}</b> — ` +
    `${toPersianDigits(String(entry.coins))} سکه · ${toPersianAmount(entry.toman)} تومان`;

  const perCoinText = `هر سکه ${toPersianAmount(perCoin)} تومان`;
  const saving =
    discount >= DISCOUNT_FLOOR
      ? ` — ${toPersianDigits(String(Math.round(discount * 100)))}٪ ارزان‌تر`
      : '';

  return `${head}\n   <i>${perCoinText}${saving}</i>`;
}

/**
 * The whole screen.
 *
 * `contact` is `COIN_PURCHASE_CONTACT` and is the reason this is reachable at
 * all — the caller does not draw the button without one, so it arrives here
 * already known to be set.
 *
 * Packages with a zero on either side are dropped by the caller, so an empty
 * list is possible in principle and is answered honestly rather than with an
 * empty table: an operator who zeroed every tier has closed the shop, and the
 * screen should say so rather than look broken.
 */
export function formatCoinPackages(input: {
  packages: readonly CoinPackage[];
  referencePrice: number;
  contact: string;
  balance: number;
}): string {
  const heading =
    `<b>خرید سکه</b>\n\n` + `موجودی شما: <b>${toPersianDigits(String(input.balance))} سکه</b>`;

  if (input.packages.length === 0) {
    return (
      `${heading}\n\n` +
      `فروش سکه فعلاً باز نیست. اگر سکه لازم دارید، به ${escapeHtml(input.contact)} پیام بدهید.`
    );
  }

  const anchor =
    input.referencePrice > 0
      ? `\n\nهر سکه حدود ${toPersianAmount(input.referencePrice)} تومان می‌ارزد.`
      : '';

  const table = input.packages.map((entry) => packageLine(entry, input.referencePrice)).join('\n');

  /**
   * Three steps, and the third is the one that matters.
   *
   * The tracking number is what makes the deposit findable in a banking app and
   * what the operator writes into the ledger row's reference — it is both the
   * receipt and the thing that stops one transfer being credited twice.
   */
  const how =
    `<b>چطور بخرید</b>\n` +
    `۱. به ${escapeHtml(input.contact)} پیام بدهید و بگویید کدام بسته را می‌خواهید.\n` +
    `۲. شمارهٔ کارت را همان‌جا می‌گیرید و مبلغ را کارت‌به‌کارت می‌کنید.\n` +
    `۳. شمارهٔ پیگیریِ تراکنش را بفرستید. پس از دیده‌شدن واریز، سکه‌ها به ` +
    `حسابتان اضافه می‌شود و در «کیف پول» می‌بینیدشان.`;

  /**
   * The safety line, and why it is on the screen rather than in a policy page.
   *
   * This is the one place the product sends somebody to move money, which makes
   * it the exact screen a scammer would imitate. Saying plainly that the bot
   * never asks for a card number or a password is worth more here than anywhere
   * else it could be written.
   */
  const safety =
    `<i>پرداخت بیرون از ربات انجام می‌شود. پایه‌تَم هرگز شمارهٔ کارت، رمز یا ` +
    `کد پیامکی شما را نمی‌پرسد.</i>`;

  return `${heading}${anchor}\n\n${table}\n\n${how}\n\n${safety}`;
}

/**
 * The button that opens it, for the foot of the wallet.
 *
 * A row of its own rather than beside «کد هدیه دارم»: they are two different
 * answers to "I have no coins" — one is a code somebody was given, the other is
 * money — and a reader scanning for the second should not have to read the
 * first.
 */
export function buyCoinsRow(): InlineButton[][] {
  return [[{ text: '🪙 خرید سکه', callbackData: encodeBuyCallback() }]];
}
