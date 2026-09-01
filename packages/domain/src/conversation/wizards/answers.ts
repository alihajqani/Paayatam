import { toPersianDigits } from '@payetam/telegram';
import type { WizardInput } from '../wizard';

/**
 * What a step says when it refuses an answer.
 *
 * ── Why the refusals are shared rather than written per step ────────────────
 *
 * Because the property that makes them useful is a property of *all* of them,
 * and it is easy to lose one step at a time. A refusal has to say three things:
 * **which question** was refused, **what the rule is**, and **what the bot
 * actually received**. Production reported the third missing everywhere — «نام
 * فعالیت باید دست‌کم ۳ نویسه باشد» is a rule restated at somebody who believes
 * they satisfied it, and it does not tell them that the two spaces they typed
 * were trimmed away, or that the button they tapped was not an answer to this
 * question at all.
 *
 * Every message below is a **Persian sentence** for exactly the reason
 * `StepResult` says: it is rendered above the question, in the same message the
 * user typed into, so a code would need a second catalogue to translate it.
 *
 * ── The echo is quoted, bounded and escaped downstream ──────────────────────
 *
 * `renderStep` escapes the whole complaint, so a title containing `<b>` is safe
 * here. What this module owns is the *length*: a wizard lives on one edited
 * message, and echoing two thousand characters back would push the question off
 * the screen — which is the failure the refusal exists to prevent.
 */

/** How much of what the user sent is echoed back at them. */
const ECHO_LIMIT = 40;

/**
 * What they sent, in «…» — or nothing when there is nothing worth quoting.
 *
 * Whitespace is collapsed before the quote, because the common invisible mistake
 * is exactly that: a newline or a run of spaces that the user cannot see and the
 * trim removed.
 */
export function quoted(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';
  const shown = collapsed.length > ECHO_LIMIT ? `${collapsed.slice(0, ECHO_LIMIT)}…` : collapsed;
  return `«${shown}»`;
}

/** «۱۲ نویسه», for a length the user is being told about. */
function characters(count: number): string {
  return `${toPersianDigits(String(count))} نویسه`;
}

/**
 * The refusal for an answer that arrived in the wrong *shape*.
 *
 * Three shapes reach a step and only one of them is text, so a step that wants
 * text has three different things to say. Saying the same sentence to all three
 * is what made «رایگان» look broken: a tap left over from a keyboard the wizard
 * had moved past was answered with «نام فعالیت را بنویسید», which is advice
 * about a question the user was not looking at.
 */
export function wrongShape(input: WizardInput, what: string): string {
  if (input.kind === 'photo') {
    return `این مرحله تصویر نمی‌گیرد. ${what} را بنویسید و بفرستید.`;
  }
  return `این مرحله با دکمه پاسخ داده نمی‌شود. ${what} را بنویسید و بفرستید.`;
}

/** Free text, trimmed and bounded, with both the bound and what arrived stated. */
export type TextResult = { ok: true; value: string } | { ok: false; error: string };

export function acceptText(input: WizardInput, min: number, max: number, what: string): TextResult {
  if (input.kind !== 'text') return { ok: false, error: wrongShape(input, what) };

  const value = input.value.trim();

  if (value.length < min) {
    /**
     * The two short cases are told apart, because they are two different
     * mistakes. An empty answer after a trim means the message held only spaces
     * or an emoji the trim did not keep — and quoting «» at somebody would be
     * the bot showing them nothing and calling it their answer.
     */
    const received =
      value.length === 0
        ? 'چیزی در پیام شما نبود'
        : `${quoted(value)} ${characters(value.length)} است`;
    return {
      ok: false,
      error: `${what} باید دست‌کم ${characters(min)} باشد — ${received}.`,
    };
  }

  if (value.length > max) {
    // Not quoted: the whole point is that it is too long to show.
    return {
      ok: false,
      error:
        `${what} نباید بیش از ${characters(max)} باشد — ` +
        `آنچه فرستادید ${characters(value.length)} بود. ` +
        `${toPersianDigits(String(value.length - max))} نویسه کوتاه‌ترش کنید.`,
    };
  }

  return { ok: true, value };
}

/**
 * Every digit a Persian keyboard can produce, folded to ASCII.
 *
 * Three systems reach this product, not one: ASCII, **Persian** `۰-۹`
 * (U+06F0…) and **Arabic-Indic** `٠-٩` (U+0660…). iOS Persian keyboards emit
 * the second, several Android keyboards emit the third, and a user pasting from
 * a website can produce either. Handling only Persian — which this did — refuses
 * a number the user can see perfectly well on their own screen.
 *
 * `packages/shared`'s `unifyDigits` does this for search and moderation; this is
 * the same rule at the wizard boundary, kept local because the domain must not
 * depend on the normalizer's whole pipeline for one character class.
 */
export function toAsciiDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * An integer from typed text or a tapped button, within bounds.
 *
 * Returns the number, or the Persian sentence explaining why not — the shape
 * the callers already read, kept so a step stays two lines.
 */
export function acceptInteger(
  input: WizardInput,
  min: number,
  max: number,
  what: string,
): number | string {
  // Thousands separators, both kinds, because «۵۰,۰۰۰» and «۵۰٬۰۰۰» are how a
  // price is written by hand.
  const typed = input.value.trim();
  const raw = toAsciiDigits(typed).replace(/[,٬\s]/g, '');

  if (raw.length === 0) return `${what} را با عدد بنویسید — پیام شما خالی بود.`;
  if (!/^\d{1,9}$/.test(raw)) {
    /**
     * The refusal names the thing that is not a number, which is the whole
     * difference between "I mistyped" and "I do not understand the question".
     * A negative sign, a decimal point and a word all land here, and quoting the
     * answer is what tells the user which of those they wrote.
     */
    return `${what} را فقط با عدد بنویسید — ${quoted(typed)} عدد نیست.`;
  }

  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    return (
      `${what} باید بین ${toPersianDigits(String(min))} و ${toPersianDigits(String(max))} باشد — ` +
      `${toPersianDigits(String(value))} فرستادید.`
    );
  }
  return value;
}
