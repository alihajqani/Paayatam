import { encodeAdminCallback } from './callback-data';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';
import { formatTehran } from './datetime';

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

    return (
      `<b>${toPersianDigits(String(index + 1))}. ${escapeHtml(subject)}</b>${title}\n` +
      `  ${escapeHtml(trigger)}${reports}\n` +
      `  ${escapeHtml(formatTehran(line.createdAt))}`
    );
  });

  const digest = buildDigest({
    title: 'پرونده‌های بررسی‌نشده',
    empty: 'هیچ پروندهٔ بازی نیست. 👌',
    entries,
  });

  if (entries.length === 0) return digest;
  return `${digest}\n\n<i>برای تصمیم‌گیری، دکمهٔ هم‌شمارهٔ زیر را بزنید.</i>`;
}

/** One button per case, numbered to match the body above it. */
export function adminQueueRows(
  lines: readonly AdminCaseLine[],
): { text: string; callbackData: string }[][] {
  return lines.map((line, index) => [
    {
      text: `${toPersianDigits(String(index + 1))} ⚖️ بررسی`,
      callbackData: encodeAdminCallback('open', line.id),
    },
  ]);
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
    lines.push(`عنوان: ${detail.eventTitle}`);
    if (detail.eventDescription !== null) lines.push(`شرح: ${detail.eventDescription}`);
  } else if (detail.subjectType !== 'EVENT') {
    // Said rather than left blank: a moderator deciding on metadata alone should
    // know that is what they are doing.
    lines.push('');
    lines.push('محتوای این پرونده در ربات نشان داده نمی‌شود. برای دیدن آن از پنل استفاده کنید.');
  }

  lines.push('');
  lines.push('تصمیم شما چیست؟');

  return lines.join('\n');
}
