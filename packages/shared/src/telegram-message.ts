/**
 * Validating a message a **person** typed, before Telegram sees it (M22 phase 4).
 *
 * In `@payetam/shared` rather than in `@payetam/telegram`, for ADR-0003's reason:
 * this is a **contract**, and the admin panel has to reach it. The panel shows
 * «تگ ناشناخته: div» while an operator is typing, and the API refuses the same
 * body with `MESSAGE_FORMAT_INVALID` — one function, so the two cannot disagree
 * about what Telegram will accept. `@payetam/telegram` is where message *rendering*
 * lives and is not a package a browser bundle imports.
 *
 * Everything else in this package renders from a template: the text is ours, the
 * only user-authored parts go through `escapeHtml`, and the markup is a constant.
 * An admin broadcast is the first message in the product whose *whole body* is
 * free text — so it is the first one where "what markup is allowed" has to be an
 * answer rather than an assumption.
 *
 * ── Two modes, and plain text is the default ─────────────────────────────────
 *
 * Sending with **no `parse_mode`** makes Telegram render the body literally.
 * `<b>` arrives as the four characters `<b>`, an `<a href>` arrives as text, and
 * there is no injection point at all. That is the default here, and it is the
 * right default: most operational messages are sentences.
 *
 * `parse_mode: 'HTML'` is available for the ones that are not, and it is
 * validated rather than sanitised. **Rejecting beats stripping**: an operator who
 * pasted markup Telegram will not accept should be told before four thousand
 * people receive something mangled, and a sanitiser that silently drops half a
 * tag produces a message nobody wrote. The refusal names the offending tag.
 *
 * The allowlist is Telegram's own documented set, minus the ones that carry a
 * reference to something outside the message: `tg-emoji` needs a custom emoji id,
 * and `a href="tg://user?id=…"` is a mention that only resolves for a peer the
 * recipient already knows. Neither belongs in a broadcast.
 */

/** Telegram refuses anything longer. Counted in UTF-16 units, as Telegram does. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/**
 * The tags Telegram documents for `parse_mode: 'HTML'`, minus the two that point
 * outward. `br` is deliberately absent: Telegram treats a newline as a newline.
 */
const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'blockquote',
  'tg-spoiler',
  'a',
]);

export type MessageFormatProblem =
  | { kind: 'TOO_LONG'; length: number; limit: number }
  | { kind: 'EMPTY' }
  | { kind: 'UNKNOWN_TAG'; tag: string }
  | { kind: 'UNCLOSED_TAG'; tag: string }
  | { kind: 'UNEXPECTED_CLOSING_TAG'; tag: string }
  | { kind: 'UNSAFE_LINK'; href: string }
  | { kind: 'UNSUPPORTED_ATTRIBUTE'; tag: string; attribute: string };

export interface MessageFormatVerdict {
  ok: boolean;
  problems: MessageFormatProblem[];
}

/** `<a href="…">` and any other attribute, captured so both can be judged. */
const TAG_PATTERN = /<\s*(\/?)\s*([a-zA-Z-]+)([^>]*)>/g;
const ATTRIBUTE_PATTERN = /([a-zA-Z-]+)\s*=\s*"([^"]*)"/g;

/**
 * Whether Telegram will accept this body, and if not, why.
 *
 * Returns every problem rather than the first: an operator fixing a message
 * should not discover the second mistake by submitting the fix.
 */
export function validateTelegramMessage(
  text: string,
  parseMode: 'HTML' | undefined,
): MessageFormatVerdict {
  const problems: MessageFormatProblem[] = [];

  if (text.trim().length === 0) problems.push({ kind: 'EMPTY' });
  if (text.length > TELEGRAM_MESSAGE_LIMIT) {
    problems.push({ kind: 'TOO_LONG', length: text.length, limit: TELEGRAM_MESSAGE_LIMIT });
  }

  // Plain text has no markup to be wrong about. Anything that looks like a tag is
  // just characters, which is the whole reason this is the default.
  if (parseMode !== 'HTML') return { ok: problems.length === 0, problems };

  const open: string[] = [];
  for (const match of text.matchAll(TAG_PATTERN)) {
    const closing = match[1] === '/';
    const tag = (match[2] ?? '').toLowerCase();
    const attributes = match[3] ?? '';

    if (!ALLOWED_TAGS.has(tag)) {
      problems.push({ kind: 'UNKNOWN_TAG', tag });
      continue;
    }

    if (closing) {
      const expected = open.pop();
      if (expected !== tag) {
        problems.push({ kind: 'UNEXPECTED_CLOSING_TAG', tag });
        // Put it back: one stray `</b>` should not cascade into "everything after
        // this is unbalanced".
        if (expected !== undefined) open.push(expected);
      }
      continue;
    }

    open.push(tag);
    for (const attribute of attributes.matchAll(ATTRIBUTE_PATTERN)) {
      const name = (attribute[1] ?? '').toLowerCase();
      const value = attribute[2] ?? '';

      if (tag === 'a' && name === 'href') {
        // https only. `tg://user?id=…` is deliberately refused: it resolves only
        // for a recipient who already has that peer, so in a broadcast it is a
        // link that works for some readers and silently does nothing for the rest.
        if (!/^https:\/\/[^\s"']+$/.test(value)) {
          problems.push({ kind: 'UNSAFE_LINK', href: value.slice(0, 120) });
        }
        continue;
      }
      if (tag === 'pre' && name === 'class') continue; // `class="language-…"`, documented.

      problems.push({ kind: 'UNSUPPORTED_ATTRIBUTE', tag, attribute: name });
    }
  }

  for (const tag of open) problems.push({ kind: 'UNCLOSED_TAG', tag });

  return { ok: problems.length === 0, problems };
}
