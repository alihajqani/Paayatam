import { escapeHtml } from './escape';
import { TELEGRAM_MESSAGE_LIMIT } from './digest';

/** One document, as the consent screen needs it. */
export interface PolicyDocument {
  /** «قوانین», or `TERMS v1` when the operator left the title empty. */
  title: string;
  /** The one-line summary, when there is one. */
  summary: string | null;
  /** The document itself, Markdown as stored. */
  contentMd: string;
}

/**
 * What a wizard screen may spend on the documents.
 *
 * The rest of Telegram's 4096 goes to the wizard's own chrome — the progress
 * line, the question, and the sentence about accepting. Deliberately generous:
 * the two current documents are about 900 characters together, and the point of
 * this module is that a user reads what they are agreeing to.
 */
const BUDGET = 3200;

/**
 * Flatten Markdown into something Telegram's HTML mode renders sensibly.
 *
 * `policy_version.content_md` is Markdown and the bot sends HTML, so the raw
 * text would arrive with `#` and `**` in it. This is not a Markdown parser and
 * does not try to be — it handles the four constructs a policy document actually
 * uses and escapes everything else.
 *
 * Headings become bold lines rather than being dropped: a policy's structure is
 * part of reading it.
 */
function flatten(markdown: string): string {
  const lines = markdown.split('\n').map((line) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading !== null) return `<b>${escapeHtml(heading[1] ?? '')}</b>`;

    const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
    const body = bullet !== null ? `• ${bullet[1] ?? ''}` : line;

    // Bold and italic, escaped first so a stray angle bracket in the document
    // cannot become markup.
    return escapeHtml(body)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])/g, '<i>$1</i>');
  });

  // Three or more blank lines is a paragraph break somebody typed twice.
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The policies, rendered for the consent gate.
 *
 * ── Why the whole document and not the summary ──────────────────────────────
 *
 * The first version of this screen printed the title and the one-line summary,
 * and production showed what that reads like: «TERMS v1 — قوانین استفاده از
 * پایه‌تَم», which is a *label*, not something anybody can agree to. Consent to a
 * document nobody has been shown is not consent. The documents are short, they
 * fit, and where they stop fitting this says so rather than silently truncating.
 */
export function formatPolicies(documents: readonly PolicyDocument[]): string {
  if (documents.length === 0) return '';

  const rendered: string[] = [];
  let spent = 0;
  let omitted = 0;

  for (const document of documents) {
    const body = flatten(document.contentMd);
    const summary =
      document.summary === null || document.summary === ''
        ? ''
        : `<i>${escapeHtml(document.summary)}</i>\n`;
    const block = `<b>${escapeHtml(document.title)}</b>\n${summary}\n${body}`;

    if (spent + block.length > BUDGET) {
      omitted += 1;
      continue;
    }
    rendered.push(block);
    spent += block.length + 2;
  }

  /**
   * A document that did not fit is named, never dropped in silence.
   *
   * If this ever fires the honest fix is a `?start=terms` deep link to the full
   * text rather than a bigger budget — Telegram's limit is not negotiable.
   */
  const tail =
    omitted > 0
      ? `\n\n<i>${String(omitted)} سند دیگر در این پیام جا نشد. برای خواندن کامل با پشتیبانی تماس بگیرید.</i>`
      : '';

  const text = rendered.join('\n\n') + tail;
  return text.length > TELEGRAM_MESSAGE_LIMIT ? text.slice(0, BUDGET) : text;
}

/** One acceptance, as `/terms` reports it back. */
export interface AcceptedPolicy {
  /** The document's Persian title, or its label when the operator left it empty. */
  title: string;
  /** When it was accepted, already formatted in Tehran time. */
  acceptedAt: string;
}

/**
 * `/terms`, for somebody who owes nothing — what they accepted, and when.
 *
 * ── Why it lives here rather than in `BotService` ───────────────────────────
 *
 * It was built inline in the command handler, and it interpolated
 * `policy_version.title_fa` into a `<b>` tag **without escaping it**. An
 * operator is not an attacker, but a title with an `&` in it would still have
 * made Telegram reject the whole message — and the escaping rule this package
 * enforces is «every value, at the point it is interpolated», not «every value
 * an attacker might reach».
 *
 * Moving it also satisfies the exemption `escape.test.ts` grants a pre-rendered
 * body: the writer of the payload has to be this package's own renderer, and
 * there has to be a test proving that renderer escapes. Now there is.
 */
export function formatStanding(accepted: readonly AcceptedPolicy[]): string {
  if (accepted.length === 0) return 'سندی ثبت نشده است.';

  const lines = accepted
    .map((entry) => `• <b>${escapeHtml(entry.title)}</b>\n  ${escapeHtml(entry.acceptedAt)}`)
    .join('\n');

  return `<b>قوانینی که پذیرفته‌اید</b>\n\n${lines}`;
}
