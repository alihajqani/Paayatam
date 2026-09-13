import { encodeAdminCallback } from './callback-data';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { formatTehran } from './datetime';
import { TELEGRAM_MESSAGE_LIMIT } from './digest';

/**
 * The moderation queue, in the bot (v0.6.3, ADR-0018).
 *
 * ── What a moderator is shown, and the reason for each omission ─────────────
 *
 * The bot's admin session holds `event.moderate` and `report.review` and nothing
 * else, so this renderer can only be given what those two permissions cover —
 * and what it is given is bounded again by the fact that a Telegram message can
 * be forwarded out of the chat it was sent to.
 *
 *  * **An event's own title and description** are shown in full: they are
 *    already public, on a discovery screen and possibly in a channel, and
 *    judging them is what `event.moderate` is.
 *  * **Report reasons are counted, never quoted.** "Six people said کلاهبرداری"
 *    is what sorts a queue; the paragraphs behind it belong on a screen that is
 *    not a chat message.
 *  * **Blacklist matches are counted, never named.** `matched_terms` has always
 *    been an allowlisted projection that excludes the scanned text, and this
 *    keeps one step further back.
 *  * **A `MESSAGE` case carries nothing at all**, and says so. Private
 *    conversations are behind break-glass — a permission, a case, a reason and a
 *    fifteen-minute clock — and no amount of convenience makes a bot the surface
 *    for one.
 */
export interface AdminCaseLine {
  id: string;
  subjectType: string;
  status: string;
  trigger: string;
  reportCount: number;
  createdAt: Date;
  eventTitle: string | null;
  /**
   * Who holds the case, from the reader's point of view (plan 07). Absent reads
   * as unclaimed, which is what every case was before triage reached the bot.
   */
  assignment?: 'NONE' | 'ME' | 'OTHER';
}

export const CASE_SUBJECT_FA: Record<string, string> = {
  EVENT: 'فعالیت',
  USER: 'کاربر',
  MESSAGE: 'گفتگو',
  REVIEW: 'نظر',
};

export const CASE_TRIGGER_FA: Record<string, string> = {
  AUTO_BLACKLIST: 'هشدار خودکار',
  REPORT_THRESHOLD: 'گزارش کاربران',
  MANUAL: 'ثبت دستی',
};

export const CASE_STATUS_FA: Record<string, string> = {
  OPEN: 'باز',
  IN_REVIEW: 'در حال بررسی',
  ESCALATED: 'ارجاع‌شده',
  APPROVED: 'تأیید شد',
  REJECTED: 'رد شد',
};

/**
 * The queue, oldest first — a queue nobody works from the bottom.
 *
 * Capped by `buildDigest` like every other bot list, because past Telegram's
 * 4096 characters `sendMessage` answers 400 and `classify()` reads a bare 400 as
 * retryable: the message would be retried until it dead-lettered, for a
 * moderator who simply never heard back.
 */
export function formatAdminQueue(lines: readonly AdminCaseLine[]): string {
  const entries = lines.map((line, index) => {
    const subject = CASE_SUBJECT_FA[line.subjectType] ?? line.subjectType;
    const trigger = CASE_TRIGGER_FA[line.trigger] ?? line.trigger;
    const title = line.eventTitle === null ? '' : `\n  «${escapeHtml(line.eventTitle)}»`;
    const reports =
      line.reportCount === 0 ? '' : ` · ${toPersianDigits(String(line.reportCount))} گزارش`;

    const holder =
      line.assignment === 'ME'
        ? `\n  ✋ دست خودتان است`
        : line.assignment === 'OTHER'
          ? `\n  ✋ دست داور دیگری است`
          : '';
    const escalated = line.status === 'ESCALATED' ? ` · ${CASE_STATUS_FA['ESCALATED']}` : '';

    return (
      `<b>${toPersianDigits(String(index + 1))}. ${escapeHtml(subject)}</b>${title}\n` +
      `  ${escapeHtml(trigger)}${reports}${escalated}\n` +
      `  ${escapeHtml(formatTehran(line.createdAt))}${holder}`
    );
  });

  const digest = buildDigest({
    title: 'پرونده‌های بررسی‌نشده',
    empty: 'هیچ پروندهٔ بازی نیست. 👌',
    entries,
  });

  if (entries.length === 0) return digest;
  return (
    `${digest}\n\n<i>برای تصمیم‌گیری، دکمهٔ هم‌شمارهٔ زیر را بزنید؛ «✋ برداشتم» یعنی ` +
    `روی آن کار می‌کنید و «⬆️ ارجاع» آن را به پنل می‌سپارد.</i>\n` +
    // The one sentence whose absence started «کارهای ادمینی از تلگرام انجام
    // نمی‌شود» (plan 07): this surface is the queue by design (ADR-0018).
    `<i>اینجا فقط صف داوری است؛ بقیهٔ کارهای ادمین در پنل انجام می‌شود.</i>`
  );
}

/** One button per case, numbered to match the body above it. */
export function adminQueueRows(
  lines: readonly AdminCaseLine[],
): { text: string; callbackData: string }[][] {
  return lines.map((line, index) => {
    const number = toPersianDigits(String(index + 1));
    const assignment = line.assignment ?? 'NONE';
    return [
      { text: `${number} ⚖️ بررسی`, callbackData: encodeAdminCallback('open', line.id) },
      // Claim only what nobody holds, release only what the reader holds: a
      // button the service would refuse is worse than no button.
      ...(assignment === 'NONE'
        ? [{ text: `${number} ✋ برداشتم`, callbackData: encodeAdminCallback('claim', line.id) }]
        : []),
      ...(assignment === 'ME'
        ? [{ text: `${number} ↩️ رها`, callbackData: encodeAdminCallback('release', line.id) }]
        : []),
      ...(line.status !== 'ESCALATED'
        ? [{ text: `${number} ⬆️ ارجاع`, callbackData: encodeAdminCallback('escalate', line.id) }]
        : []),
    ];
  });
}

export interface AdminCaseDetailLine extends AdminCaseLine {
  eventDescription: string | null;
  eventStatus: string | null;
  reportReasons: readonly { reason: string; count: number }[];
  matchedTermCount: number;
}

const REPORT_REASON_FA: Record<string, string> = {
  SPAM: 'هرزنامه یا تبلیغ',
  HARASSMENT: 'آزار و توهین',
  INAPPROPRIATE: 'محتوای نامناسب',
  SCAM: 'کلاهبرداری',
  IMPERSONATION: 'جعل هویت',
  SAFETY: 'نگرانی برای ایمنی',
  OTHER: 'موردی دیگر',
};

/**
 * How much of a case may reach one Telegram message.
 *
 * An event description is up to 2000 characters of host-authored text, and
 * escaping can nearly double that — `&amp;` is five characters for one. Add the
 * report breakdown and the wizard's own progress line and keyboard, and the
 * total can pass Telegram's 4096.
 *
 * That failure is the shape trap 6 records and is worth restating: past the
 * limit `sendMessage` answers **400**, `classify()` reads a bare 400 as
 * retryable, and the message is retried until it dead-letters — so a moderator
 * taps «بررسی» and simply never hears back. **Anything rendered into a Telegram
 * message needs a ceiling at the point of rendering.**
 *
 * The description is what gets cut, because it is the only unbounded field and
 * because the metadata above it is what sorts a queue. A moderator who needs the
 * whole text has the panel.
 */
const DESCRIPTION_BUDGET = 1200;

/** Cut on a whole character, and say that it was cut. */
function clip(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget).trimEnd()}… (بریده شد)`;
}

/**
 * One case, as the wizard's first question asks about it.
 *
 * **Plain text, not HTML**, because `renderStep` escapes the prompt it is given
 * — the wizard's own markup is the only markup on that screen. Anything emitted
 * here with angle brackets in it would reach the moderator as visible
 * `&lt;b&gt;`, which is the bug `prerendered` exists to prevent elsewhere.
 */
export function formatAdminCasePrompt(detail: AdminCaseDetailLine): string {
  const subject = CASE_SUBJECT_FA[detail.subjectType] ?? detail.subjectType;
  const trigger = CASE_TRIGGER_FA[detail.trigger] ?? detail.trigger;
  const status = CASE_STATUS_FA[detail.status] ?? detail.status;

  const lines = [
    `پروندهٔ ${subject} — ${status}`,
    `دلیل باز شدن: ${trigger}`,
    `ثبت: ${formatTehran(detail.createdAt)}`,
  ];

  if (detail.matchedTermCount > 0) {
    // A count, never the terms and never the text they matched.
    lines.push(`واژه‌های مسدود منطبق: ${toPersianDigits(String(detail.matchedTermCount))}`);
  }

  if (detail.reportReasons.length > 0) {
    lines.push('');
    lines.push(`گزارش‌ها (${toPersianDigits(String(detail.reportCount))}):`);
    for (const entry of detail.reportReasons) {
      const label = REPORT_REASON_FA[entry.reason] ?? entry.reason;
      lines.push(`• ${label} — ${toPersianDigits(String(entry.count))}`);
    }
  }

  if (detail.eventTitle !== null) {
    lines.push('');
    lines.push(`عنوان: ${clip(detail.eventTitle, 200)}`);
    if (detail.eventDescription !== null) {
      lines.push(`شرح: ${clip(detail.eventDescription, DESCRIPTION_BUDGET)}`);
    }
  } else if (detail.subjectType !== 'EVENT') {
    // Said rather than left blank: a moderator deciding on metadata alone should
    // know that is what they are doing.
    lines.push('');
    lines.push('محتوای این پرونده در ربات نشان داده نمی‌شود. برای دیدن آن از پنل استفاده کنید.');
  }

  /**
   * The last ceiling — over the body, and **not** over the question.
   *
   * The per-field budgets above bound the two unbounded fields; this bounds
   * everything else: seven report reasons, a long category name, a future field
   * somebody adds without reading this comment. Half the limit, because the
   * wizard renderer adds its own progress line and Telegram counts the whole
   * message.
   *
   * The question is appended *after* the clip rather than included in it. A
   * ceiling that could swallow «تصمیم شما چیست؟» would leave a screen of
   * evidence over two unexplained buttons — which is the one line on it that
   * cannot be lost.
   */
  const question = 'تصمیم شما چیست؟';
  const budget = Math.floor(TELEGRAM_MESSAGE_LIMIT / 2) - question.length - 2;

  return `${clip(lines.join('\n'), budget)}\n\n${question}`;
}

/** The counts a moderator digest carries — see `ModerationDigestService` (plan 06). */
export interface ModerationDigestSummary {
  openCount: number;
  unclaimedCount: number;
  oldestUnclaimedAt: Date | null;
  bySubject: Readonly<Record<string, number>>;
}

function waitedFor(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${toPersianDigits(String(minutes))} دقیقه`;
  return `${toPersianDigits(String(Math.floor(minutes / 60)))} ساعت`;
}

/**
 * «۳ پرونده منتظر داوری است» — the nudge a linked moderator gets (plan 06).
 *
 * **Counts, never content.** No title, no report text, nothing about who: a
 * Telegram message can be forwarded out of the chat it was sent to, and a digest
 * is more likely to be than the queue screen itself — the same rule the queue is
 * rendered by, «counted, not quoted».
 */
export function formatModerationDigest(summary: ModerationDigestSummary, now: Date): string {
  const subjects = Object.entries(summary.bySubject)
    .filter(([, count]) => count > 0)
    .map(
      ([subject, count]) =>
        `${CASE_SUBJECT_FA[subject] ?? subject} ${toPersianDigits(String(count))}`,
    )
    .join(' · ');
  const oldest =
    summary.oldestUnclaimedAt === null
      ? ''
      : `\nقدیمی‌ترین‌شان ${waitedFor(summary.oldestUnclaimedAt, now)} است که منتظر است.`;
  const claimed = summary.openCount - summary.unclaimedCount;

  return (
    `<b>🛡 صف داوری</b>\n\n` +
    `${toPersianDigits(String(summary.unclaimedCount))} پرونده منتظر است که کسی برش دارد.` +
    oldest +
    (subjects === '' ? '' : `\n${escapeHtml(subjects)}`) +
    (claimed > 0 ? `\n<i>${toPersianDigits(String(claimed))} پروندهٔ دیگر دست داورهاست.</i>` : '')
  );
}

/** The digest's one button: the queue itself (`ad:list`, handled since v0.6.3). */
export function moderationDigestKeyboard(): { text: string; callbackData: string }[][] {
  return [[{ text: '🛡 باز کردن صف', callbackData: encodeAdminCallback('list', null) }]];
}
