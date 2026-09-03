import type { InboundTextMessage } from './inbound-message';

/**
 * Layer 4 of the anonymity boundary (ADR-0009): relay hardening.
 *
 * Everything a user types passes through here before it is stored or shown to
 * anybody. Three jobs, in this order, and the order matters:
 *
 *  1. **Drop every entity.** Not "drop the dangerous ones" — all of them. A
 *     `text_mention` carries a raw Telegram user id in a field that has no
 *     representation in the text, so it is invisible to any amount of string
 *     scanning. An allowlist of "safe" entity types would be a list somebody has
 *     to keep correct as Telegram adds new ones; dropping all of them is a
 *     property that stays true when Telegram changes.
 *  2. **Mask contact details in the text.** Phone numbers, `@usernames`, `t.me/`
 *     links and email addresses become «حذف شد», and each one is recorded so
 *     moderation can see that an exchange was attempted.
 *  3. **Collapse what is left**, so a message made entirely of masked fragments
 *     does not arrive as a wall of «حذف شد».
 *
 * This module is pure and has no database, no clock and no Telegram client. That
 * is what lets the leak tests be exhaustive and fast — and the plan asks for them
 * to be written before the relay exists, which is only possible if the dangerous
 * part is a function.
 */

/** What replaces a masked fragment. Persian, because the recipient reads it. */
export const REDACTION_PLACEHOLDER = '«حذف شد»';

export type RedactionKind = 'PHONE' | 'USERNAME' | 'TELEGRAM_LINK' | 'EMAIL' | 'ENTITY';

export interface Redaction {
  kind: RedactionKind;
  /** What was removed, for moderation. Never shown to the recipient. */
  original: string;
}

export interface SanitizedMessage {
  /** Safe to store and to relay. */
  text: string;
  /** Everything removed, in the order it was found. */
  redactions: Redaction[];
  /** True when nothing survived masking — the relay refuses to send an empty message. */
  isEmpty: boolean;
}

export interface SanitizeOptions {
  /**
   * Whether contact details in the *text* are masked.
   *
   * On while the chat is anonymous, and off once the sender has been through the
   * contact-sharing consent flow (ADR-0009: masking applies "during the
   * anonymous stage"; exchange happens after "an explicit button, a confirmation
   * step, and writes `consent`"). Continuing to mask after that would be the
   * platform overriding a consent it had just recorded.
   *
   * It does **not** govern entities. Those are dropped unconditionally, because
   * a `text_mention` carries somebody's raw Telegram id and consenting to share
   * your own contact details is not consent to hand over a third party's.
   */
  maskContactDetails?: boolean;
}

/**
 * Order matters within the text rules too.
 *
 * `t.me/` before `@username`, because `t.me/someone` contains a username-shaped
 * tail that the username rule would otherwise claim first, leaving a bare `t.me/`
 * behind. Email before username for the same reason: `a@b.com` starts with
 * something an `@handle` rule finds attractive.
 */
const TEXT_RULES: ReadonlyArray<{ kind: RedactionKind; pattern: RegExp }> = [
  {
    kind: 'TELEGRAM_LINK',
    // Any t.me or telegram.me link, with or without a scheme, plus the
    // `tg://resolve?domain=` form that clients also honour.
    pattern: /(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/\S+|tg:\/\/resolve\?domain=\S+/gi,
  },
  {
    kind: 'EMAIL',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    kind: 'PHONE',
    /**
     * Iranian mobiles in the forms people actually type them, plus a generic
     * long-digit-run rule.
     *
     * Digits are normalised to Latin before this runs, so «۰۹۱۲…» is matched by
     * the same pattern as "0912…". Separators are permitted between groups
     * because "0912 345 6789" and "0912-345-6789" are the same phone number to
     * everyone except a naive regex.
     */
    pattern: /(?:\+?98|0)[\s.-]?9\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|\d[\d\s.-]{9,}\d/g,
  },
  {
    kind: 'USERNAME',
    // Telegram's own rule: 5–32 of [A-Za-z0-9_], and it must not be the tail of
    // an email that survived the rule above.
    pattern: /@[A-Za-z0-9_]{5,32}\b/g,
  },
];

/**
 * Strips entities and masks contact details.
 *
 * `normalizeDigits` is applied first so a phone written in Persian digits is
 * caught by the same rule as one written in Latin — the same argument ADR-0012
 * makes for moderation, applied to the one text path that reaches another user.
 */
export function sanitizeInbound(
  message: InboundTextMessage,
  options: SanitizeOptions = {},
): SanitizedMessage {
  const maskContactDetails = options.maskContactDetails ?? true;
  const redactions: Redaction[] = [];

  // Entities never reach the output, but the ones carrying identity are recorded
  // so a moderator can see that somebody tried.
  for (const entity of message.entities ?? []) {
    if (entity.type === 'text_mention' && entity.user) {
      redactions.push({ kind: 'ENTITY', original: `text_mention:${String(entity.user.id)}` });
    } else if (entity.type === 'text_link' && entity.url !== undefined) {
      redactions.push({ kind: 'ENTITY', original: `text_link:${entity.url}` });
    }
  }

  let text = normalizeDigits(message.text);

  if (maskContactDetails) {
    for (const rule of TEXT_RULES) {
      text = text.replace(rule.pattern, (match) => {
        redactions.push({ kind: rule.kind, original: match });
        return REDACTION_PLACEHOLDER;
      });
    }
  }

  // A `text_link` hides its target behind display text, so the URL never appeared
  // in `text` and no text rule could have caught it. The visible label survives;
  // the destination does not.
  text = collapse(text);

  return {
    text,
    redactions,
    isEmpty: text.replace(new RegExp(REDACTION_PLACEHOLDER, 'g'), '').trim().length === 0,
  };
}

/** Arabic-Indic and extended Arabic-Indic digits to Latin. */
function normalizeDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** Repeated placeholders and runaway whitespace collapse to one. */
function collapse(input: string): string {
  const placeholder = REDACTION_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return input
    .replace(new RegExp(`(?:${placeholder}[\\s]*){2,}`, 'g'), `${REDACTION_PLACEHOLDER} `)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
