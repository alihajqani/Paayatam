import { encodePolicyCallback, MAX_POLICY_PAGE, type PolicyDocLetter } from './callback-data';
import { escapeHtml, toPersianDigits } from './escape';

/** The three documents a user may be shown (`policy_version.type`). */
export type PolicyType = 'TERMS' | 'PRIVACY' | 'COMMUNITY';

/** The letter each document travels as in a `pl:` button. */
export const POLICY_LETTER: Record<PolicyType, Exclude<PolicyDocLetter, 's'>> = {
  TERMS: 't',
  PRIVACY: 'p',
  COMMUNITY: 'c',
};

/** And back. Null for `s`, which is the summary rather than a document. */
export function policyTypeFor(letter: PolicyDocLetter): PolicyType | null {
  switch (letter) {
    case 't':
      return 'TERMS';
    case 'p':
      return 'PRIVACY';
    case 'c':
      return 'COMMUNITY';
    default:
      return null;
  }
}

/**
 * What each document is called when its operator left the title empty.
 *
 * The deployed rows had no `title_fa`, and the first consent screen fell back to
 * the machine label — «TERMS v1» — which is a key, not a name anybody reads.
 */
export const POLICY_DEFAULT_TITLE: Record<PolicyType, string> = {
  TERMS: 'قوانین و شرایط استفاده',
  PRIVACY: 'سیاست حریم خصوصی',
  COMMUNITY: 'آیین‌نامهٔ رفتار',
};

/** The button that opens each document. */
const READ_LABEL: Record<PolicyType, string> = {
  TERMS: '📄 متن کامل قوانین',
  PRIVACY: '📄 حریم خصوصی',
  COMMUNITY: '📄 آیین‌نامهٔ رفتار',
};

/** The order the documents are offered in, whatever order they were read in. */
const ORDER: readonly PolicyType[] = ['TERMS', 'PRIVACY', 'COMMUNITY'];

/**
 * What one page of a document may spend.
 *
 * Telegram's limit is 4096, and the page's own header takes a line. Three
 * thousand leaves the rest as margin rather than as something to fill: HTML
 * tags count here and not in Telegram's reckoning, so the real text is shorter
 * than this measures.
 */
export const PAGE_BUDGET = 3000;

type Row = { text: string; callbackData: string }[];

/**
 * Flatten Markdown into something Telegram's HTML mode renders sensibly.
 *
 * `policy_version.content_md` is Markdown and the bot sends HTML, so the raw
 * text would arrive with `#` and `**` in it. This is not a Markdown parser and
 * does not try to be — it handles the constructs a policy document actually
 * uses and escapes everything else.
 *
 * Headings become bold lines rather than being dropped: a policy's structure is
 * part of reading it. A horizontal rule is dropped: pages already separate what
 * it would have.
 */
function flatten(markdown: string): string {
  const lines = markdown
    .split('\n')
    .filter((line) => !/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line))
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
      if (heading !== null) return `<b>${escapeHtml(stripEmphasis(heading[1] ?? ''))}</b>`;

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

/** A heading is bold already; `**` inside one would print as asterisks. */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}

/**
 * A document cut at its `##` headings.
 *
 * Whatever comes before the first one — the title, the date, the opening
 * paragraph — is a section of its own. `###` and deeper stay inside their
 * section: a page break between a subheading and the heading above it would
 * separate a clause from what it qualifies.
 */
function sections(markdown: string): string[] {
  const groups: string[][] = [[]];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const current = groups[groups.length - 1] ?? [];
    if (/^##\s/.test(line.trim()) && current.some((existing) => existing.trim() !== '')) {
      groups.push([line]);
    } else {
      current.push(line);
    }
  }
  return groups.map((group) => group.join('\n').trim()).filter((group) => group !== '');
}

/**
 * One section, as pages that each fit the budget.
 *
 * Almost always one page: the documents are written in short sections. A
 * section that is longer is cut between lines, and a single line longer than a
 * page — which no policy should have — between words.
 */
function fit(section: string, budget: number): string[] {
  const whole = flatten(section);
  if (whole.length <= budget) return [whole];

  const pieces: string[] = [];
  for (const line of section.split('\n')) {
    if (flatten(line).length <= budget) {
      pieces.push(line);
      continue;
    }
    let chunk = '';
    for (const word of line.split(' ')) {
      const candidate = chunk === '' ? word : `${chunk} ${word}`;
      if (flatten(candidate).length > budget && chunk !== '') {
        pieces.push(chunk);
        chunk = word;
      } else {
        chunk = candidate;
      }
    }
    if (chunk !== '') pieces.push(chunk);
  }

  return pack(pieces.map(flatten), budget, '\n');
}

/** Greedy: as many blocks per page as fit, never splitting one. */
function pack(blocks: readonly string[], budget: number, joiner: string): string[] {
  const pages: string[] = [];
  let current = '';
  for (const block of blocks) {
    if (block === '') continue;
    const candidate = current === '' ? block : `${current}${joiner}${block}`;
    if (candidate.length > budget && current !== '') {
      pages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current !== '') pages.push(current);
  return pages;
}

/**
 * A document as the pages it is read in, already rendered as HTML.
 *
 * Cut at `##` headings and packed greedily, so a page holds as many whole
 * sections as fit and a section is only ever split when it alone is longer than
 * a page. Never more pages than the `pl:` button can name.
 */
export function paginatePolicy(contentMd: string, budget = PAGE_BUDGET): string[] {
  const pages = pack(
    sections(contentMd).flatMap((section) => fit(section, budget)),
    budget,
    '\n\n',
  );
  return pages.length === 0 ? [''] : pages.slice(0, MAX_POLICY_PAGE + 1);
}

/** One page, with the document's name and where the reader is in it. */
export function formatPolicyPage(input: {
  title: string;
  body: string;
  /** Zero-based. */
  page: number;
  pages: number;
}): string {
  const position =
    input.pages > 1
      ? ` · <i>بخش ${toPersianDigits(String(input.page + 1))} از ${toPersianDigits(
          String(input.pages),
        )}</i>`
      : '';
  return `<b>📄 ${escapeHtml(input.title)}</b>${position}\n\n${input.body}`;
}

/**
 * Under a page: the way through the document, the way back, and — while the
 * reader still owes an acceptance — the acceptance itself.
 *
 * «می‌پذیرم» is on every page on purpose. Consent needs the whole text to be
 * **available** before somebody agrees, not proof that they paged to the end;
 * hiding the button until the last page would only teach people to tap «بعدی»
 * without reading.
 */
export function policyPageRows(input: {
  type: PolicyType;
  page: number;
  pages: number;
  /** The `wz:` acceptance, or null when there is nothing to accept. */
  acceptCallbackData: string | null;
}): Row[] {
  const letter = POLICY_LETTER[input.type];
  const nav: Row = [];
  if (input.page > 0) {
    nav.push({ text: '◀️ قبلی', callbackData: encodePolicyCallback(letter, input.page - 1) });
  }
  if (input.page < input.pages - 1) {
    nav.push({ text: 'بعدی ▶️', callbackData: encodePolicyCallback(letter, input.page + 1) });
  }

  const rows: Row[] = [];
  if (nav.length > 0) rows.push(nav);
  rows.push([{ text: '↩️ بازگشت به فهرست اسناد', callbackData: encodePolicyCallback('s') }]);
  if (input.acceptCallbackData !== null) {
    rows.push([{ text: '✅ می‌پذیرم', callbackData: input.acceptCallbackData }]);
  }
  return rows;
}

/** One button per document, in a fixed order. */
export function policyReadRows(types: readonly PolicyType[]): Row[] {
  return ORDER.filter((type) => types.includes(type)).map((type) => [
    { text: READ_LABEL[type], callbackData: encodePolicyCallback(POLICY_LETTER[type]) },
  ]);
}

/** A document whose new version somebody is being asked to accept again. */
export interface PolicyChange {
  title: string;
  /** `change_summary_fa`: what changed since the version they accepted. */
  changeSummary: string | null;
}

/**
 * The consent screen's body: what somebody must know before they agree.
 *
 * ── Why a summary and not the documents ──────────────────────────────────────
 *
 * The documents stopped fitting. Terms, privacy and the code of conduct run to
 * well over one Telegram message each, and the first version of this screen
 * printed them inline under a 3200-character budget — which, given documents
 * that size, would have shown **none** of them and asked for an acceptance
 * anyway. So the screen carries the points a person is most likely to be
 * surprised by, and every document is one tap away, in full, before the
 * acceptance button (`policyPageRows`).
 *
 * The summary is a guide to the text, never a substitute for it, and it says so.
 * It quotes no number an operator can change in the settings: a penalty quoted
 * here would go stale the day somebody retuned it, and the documents are where
 * the current values are stated.
 */
export function formatPolicySummary(input: {
  mode: 'accept' | 'reaccept';
  /** For `reaccept`: which documents changed, and how. */
  changes?: readonly PolicyChange[];
}): string {
  const changes =
    input.mode === 'reaccept' && input.changes !== undefined && input.changes.length > 0
      ? `<b>چه چیزی تغییر کرده است</b>\n` +
        input.changes
          .map(
            (change) =>
              `• <b>${escapeHtml(change.title)}</b>` +
              (change.changeSummary !== null && change.changeSummary !== ''
                ? `: ${escapeHtml(change.changeSummary)}`
                : ''),
          )
          .join('\n') +
        '\n\n'
      : '';

  return (
    changes +
    `<b>چند نکتهٔ مهم پیش از پذیرش</b>\n` +
    `• استفاده از ربات پایتم فقط برای افراد ۱۸ سال و بالاتر مجاز است.\n` +
    `• پیام مستقیم ناشناس نیست: نام نمایشی پروفایلتان به گیرنده نشان داده می‌شود. ` +
    `شماره، آیدی یا هر اطلاعات تماسی فقط وقتی رد و بدل می‌شود که خودتان بفرستید، ` +
    `و مسئولیتش با خودتان است.\n` +
    `• پیام‌های مستقیم ۱۸۰ روز نگهداری می‌شوند و تیم پایتم برای رسیدگی به تخلف و ` +
    `پشتیبانی می‌تواند آن‌ها را بخواند.\n` +
    `• لغو شرکت پس از پذیرفته‌شدن و غیبت در فعالیت، سکه و امتیاز اعتماد شما را کم می‌کند.\n` +
    `• پولی که برای خرید سکه پرداخت می‌شود برگشت داده نمی‌شود، و سکه به پول تبدیل ` +
    `یا به کس دیگری منتقل نمی‌شود.\n\n` +
    `<i>این خلاصه جای متن کامل را نمی‌گیرد. هر سند را با دکمهٔ خودش بخوانید؛ ` +
    `با زدن «می‌پذیرم» همهٔ سندهای زیر را می‌پذیرید.</i>`
  );
}

/** One acceptance, as `/terms` reports it back. */
export interface AcceptedPolicy {
  /** The document's Persian title, or its default name when the operator left it empty. */
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
 *
 * The documents themselves are under it, one button each (`policyReadRows`):
 * a list of what somebody agreed to is only half an answer without a way to
 * read it again.
 */
export function formatStanding(accepted: readonly AcceptedPolicy[]): string {
  if (accepted.length === 0) return 'سندی ثبت نشده است.';

  const lines = accepted
    .map((entry) => `• <b>${escapeHtml(entry.title)}</b>\n  ${escapeHtml(entry.acceptedAt)}`)
    .join('\n');

  return (
    `<b>قوانینی که پذیرفته‌اید</b>\n\n${lines}\n\n` +
    `<i>برای خواندن متن کامل هر سند، دکمه‌اش را بزنید.</i>`
  );
}
