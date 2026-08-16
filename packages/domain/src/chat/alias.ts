/**
 * Layer 3 of the anonymity boundary (ADR-0009): per-chat aliases.
 *
 * The property this file exists to provide is narrow and worth stating exactly:
 * **an alias is a function of the chat, never of the person in it.** A guest's
 * number is the position of their chat within its event — first requester is
 * «میهمان ۱», second is «میهمان ۲» — so the same person is «میهمان ۱» in one event
 * and «میهمان ۴» in another, and *every* event's first requester is «میهمان ۱».
 *
 * That is what makes cross-chat correlation impossible rather than merely
 * awkward. A stable per-user alias would let a host who runs many events notice
 * that «میهمان ۷» keeps coming back and, over a few events, work out who they
 * are; ADR-0009 rejects that explicitly. Here the number carries no information
 * about identity at all, because it was derived from arrival order and nothing
 * else.
 *
 * The numbering is not decoration. A host receives every relayed message in one
 * Telegram conversation with the bot, so without a per-event number they would
 * see several indistinguishable «میهمان»s and have no way to tell which of their
 * five guests just asked about parking.
 */

/** The host's alias. There is exactly one host per event (plan §2.6). */
export const HOST_ALIAS = 'میزبان';

/**
 * The host is index 0 and guests are 1-based, mirrored by a CHECK constraint.
 * Zero is reserved rather than merely unused: it means "the alias with no
 * number", which is what makes `UNIQUE (chat_id, alias_index)` hold for a chat
 * whose guest happens to be the event's first.
 */
export const HOST_ALIAS_INDEX = 0;

/** «میهمان ۳» for index 3. */
export function guestAlias(aliasIndex: number): string {
  if (!Number.isInteger(aliasIndex) || aliasIndex < 1) {
    throw new Error(`guest alias index must be a positive integer, got ${String(aliasIndex)}`);
  }
  return `میهمان ${toPersianDigits(aliasIndex)}`;
}

/**
 * Persian digits, for display only.
 *
 * The alias is stored already formatted because it is rendered verbatim into a
 * Telegram message body, and a formatter at that point would be a formatter in
 * the worker, the bot and the Mini App rather than in one place. Everything the
 * code computes with stays Latin in `alias_index` beside it (glossary §5).
 */
export function toPersianDigits(value: number): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
