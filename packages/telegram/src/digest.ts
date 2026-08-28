import { toPersianDigits } from './escape';

/**
 * Telegram's hard limit on a `sendMessage` body, in characters.
 *
 * Not a style guide — the API returns `400 Bad Request: message is too long`
 * past it, and `classify()` reads a bare 400 as `RETRY`. So an over-long digest
 * is not "a message that looks bad": it is a message that can never succeed,
 * retried until it dead-letters, for a user who simply never hears back.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * What a digest may actually spend.
 *
 * Deliberately well under the limit. The count is characters as JavaScript
 * counts them, and what Telegram measures is the encoded body — `escapeHtml`
 * turns one `&` into five characters, and a Persian title is multi-byte. The
 * headroom absorbs both rather than requiring this module to model either.
 */
const BUDGET = 3500;

/**
 * The most entries any digest renders, before length is even considered.
 *
 * A cap on *reading*, not only on sending. Thirty conversations scrolling past
 * in one message is not an answer to "what is open" — past a point the list has
 * to become the app, and saying so beats rendering a wall nobody reads.
 */
const MAX_ENTRIES = 20;

export interface DigestInput {
  /** The bold heading, without markup. */
  title: string;
  /** The whole message when there is nothing to list. */
  empty: string;
  /** Rendered entries, most relevant first. Trimmed from the end when over budget. */
  entries: readonly string[];
}

/**
 * Assemble one bot digest: a heading, the entries, and an honest tail.
 *
 * ── Why this is shared ───────────────────────────────────────────────────────
 *
 * `/requests`, `/myevents` and `/chats` are the same message three times — bold
 * heading, blank line, `\n\n`-joined entries, a Persian sentence when empty — and
 * all three read a list with no upper bound: `listMine` and `listForUser` take no
 * `take` at all, and `listOwned` takes 100. Each was one prolific user away from
 * the failure described on `TELEGRAM_MESSAGE_LIMIT`, and fixing that three times
 * in three files is how two of them stay broken.
 *
 * ── What "dropped" means ─────────────────────────────────────────────────────
 *
 * Entries are trimmed from the **end**, which is why every caller passes them
 * most-relevant-first: the newest request, the soonest event, the conversation
 * that just moved. What is cut is the tail nobody was scrolling to.
 *
 * The tail sentence is not decoration. A digest that silently shows 20 of 63 is
 * a digest that lies about how much you have, and the one thing a host checking
 * their events must not be told is a wrong number.
 */
export function buildDigest({ title, empty, entries }: DigestInput): string {
  const heading = `<b>${title}</b>`;
  if (entries.length === 0) return `${heading}\n\n${empty}`;

  const kept: string[] = [];
  let spent = heading.length + 2;

  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    // +2 for the blank line between entries. Checked *before* appending, so the
    // budget is never exceeded rather than exceeded and then noticed.
    const cost = entry.length + 2;
    if (spent + cost > BUDGET) break;
    kept.push(entry);
    spent += cost;
  }

  /**
   * One entry that alone exceeds the budget would otherwise render an empty
   * digest — a heading, a tail, and nothing between them — which reads as a bug
   * rather than as a limit. Keeping it means one over-long message, and the send
   * path's own guard is what catches that; keeping none means a message that
   * looks broken to everybody who receives it.
   */
  if (kept.length === 0) kept.push(entries[0] as string);

  const dropped = entries.length - kept.length;
  const tail =
    dropped > 0
      ? `\n\n<i>و ${toPersianDigits(String(dropped))} مورد دیگر — برای دیدن همه برنامه را باز کنید.</i>`
      : '';

  return `${heading}\n\n${kept.join('\n\n')}${tail}`;
}
