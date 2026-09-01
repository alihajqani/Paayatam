import { toPersianDigits } from './escape';

/**
 * The bot's one-line refusals, in the package that owns its Persian.
 *
 * ── Why these live here rather than beside their caller ─────────────────────
 *
 * Because of the rule the whole catalogue is built on: a message body is
 * rendered by `@payetam/telegram`, and every renderer here has a test proving
 * what it emits. `BOT_NOTICE` escapes its payload — rightly, since almost
 * everything it carries is a sentence from `ERROR_MESSAGES_FA` or a service's
 * own words — so a body built at the call site with `<b>` in it reaches the user
 * as `&lt;b&gt;`, and nothing in the API app would notice.
 *
 * That is exactly what happened to the coin refusal, on the screen where a new
 * host is told they cannot afford to register their first activity. The rule
 * these functions exist to hold is therefore stated as a test: **a notice body
 * contains no markup at all.**
 */

/**
 * "You need N, you have M" — the refusal a precondition gives before the work.
 *
 * Both numbers, because "not enough coins" alone leaves a host to go and look up
 * a balance the bot already knows, and the gap is what tells them whether this
 * is one referral away or out of reach today.
 *
 * Emphasis is typography, not markup: the amounts are in Persian digits with
 * «سکه» after each of them, which is as much as one sentence needs.
 */
export function insufficientCoinsNotice(what: string, cost: number, balance: number): string {
  return (
    `${what} ${toPersianDigits(String(cost))} سکه هزینه دارد و ` +
    `موجودی شما ${toPersianDigits(String(balance))} سکه است.\n\n` +
    `می‌توانید با دعوت دوستان یا کد هدیه سکه به دست بیاورید — /referral و /gift.`
  );
}
