import { REPORT_REASONS, type ReportReasonValue } from './callback-data';

/**
 * Reporting, as the bot asks it (v0.5.7).
 *
 * ── The one control that was not a convenience ──────────────────────────────
 *
 * The four report endpoints have existed since M12 and were reachable only from
 * the Mini App. From v0.4.6 — when the last button to it went — somebody meeting
 * strangers through this product had no way to say that something was wrong.
 * Every other gap the retirement left was a screen you could live without; this
 * one was a safety control.
 *
 * ── Why seven buttons and no free text ──────────────────────────────────────
 *
 * `fileReportRequest` takes a reason and an **optional** description, so a
 * reason alone is a complete report: it names the target, it counts toward
 * `moderation.report_threshold`, and it puts the subject in front of a
 * moderator. Free text needs a wizard and a `ConversationKind`, and a report
 * that gets filed today is worth more than a richer one that waits for a
 * migration. The description is a real gap and it is the next thing here.
 *
 * ── What the reporter is told ───────────────────────────────────────────────
 *
 * That it was filed, and nothing else. Never how many others reported, never
 * who — a count would let somebody probe how close a rival's event is to being
 * hidden. And **nobody is notified**: telling one side of an anonymous chat that
 * the other reported them is the single message this area must never send.
 */
const REASON_FA: Record<ReportReasonValue, string> = {
  SPAM: '📢 هرزنامه یا تبلیغ',
  HARASSMENT: '🚫 آزار و توهین',
  INAPPROPRIATE: '⚠️ محتوای نامناسب',
  SCAM: '🎣 کلاهبرداری',
  IMPERSONATION: '🎭 جعل هویت',
  SAFETY: '🆘 نگرانی برای ایمنی',
  OTHER: '❓ موردی دیگر',
};

export function reportReasonLabel(reason: ReportReasonValue): string {
  return REASON_FA[reason];
}

/** The seven reasons, in the order they are offered. */
export const REPORT_REASON_CHOICES: readonly { reason: ReportReasonValue; label: string }[] =
  REPORT_REASONS.map((reason) => ({ reason, label: REASON_FA[reason] }));

/** What the target of a report is called, for the question above the buttons. */
const TARGET_FA: Record<string, string> = {
  e: 'این فعالیت',
  c: 'این گفتگو',
  u: 'این کاربر',
  v: 'این نظر',
};

export function reportPrompt(target: string): string {
  const what = TARGET_FA[target] ?? 'این مورد';
  return (
    `<b>گزارش ${what}</b>\n\n` +
    `دلیل گزارش را انتخاب کنید. گزارش شما محرمانه است و به طرف مقابل اطلاع داده نمی‌شود.`
  );
}
