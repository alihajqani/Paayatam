import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * A report, with the detail a moderator actually needs (v0.5.8).
 *
 * ── Why this is a form and not a follow-up ──────────────────────────────────
 *
 * v0.5.7 filed from a single tap: seven reasons as buttons, and the reason
 * alone. `report.description` is nullable and the contract makes it optional, so
 * that was a complete report — but «HARASSMENT» with no detail is much weaker in
 * front of a moderator than the same word with two sentences under it.
 *
 * `ReportService` has exactly one method, `file`. There is no update path, and a
 * report is append-only by design — so the description cannot be added
 * afterwards. It is collected before the row exists or not at all.
 *
 * ── The target is seeded, not asked ─────────────────────────────────────────
 *
 * A public id does not carry its table. Whether the subject is an event, a
 * conversation or a user is known to the button that was tapped and to nothing
 * else, so it arrives through `start`'s `initialForm` — asking the user to
 * restate it would be asking a question the product already has the answer to.
 *
 * ── Why the description is still optional ───────────────────────────────────
 *
 * Because a report that gets filed is worth more than one abandoned at a text
 * prompt, and somebody reporting harassment should not have to compose a
 * paragraph before the product will listen. «رد کردن» files the reason alone,
 * which is exactly what v0.5.7 did.
 */

export interface FileReportForm {
  /** `e` event, `c` conversation, `u` user — seeded by the caller. */
  target?: string;
  reason?: string;
  description?: string;
}

const REASONS = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE',
  'SCAM',
  'IMPERSONATION',
  'SAFETY',
  'OTHER',
] as const;

/**
 * The reasons, in the language the reporter reads.
 *
 * Duplicated from `packages/telegram`'s catalogue rather than imported: this
 * package does not depend on that one, and inverting it to share seven strings
 * would drag the message catalogue into the domain. `file-report.test.ts` in
 * neither place would notice a drift, which is why the labels are asserted
 * against each other in `report.test.ts`.
 */
const REASON_FA: Record<string, string> = {
  SPAM: '📢 هرزنامه یا تبلیغ',
  HARASSMENT: '🚫 آزار و توهین',
  INAPPROPRIATE: '⚠️ محتوای نامناسب',
  SCAM: '🎣 کلاهبرداری',
  IMPERSONATION: '🎭 جعل هویت',
  SAFETY: '🆘 نگرانی برای ایمنی',
  OTHER: '❓ موردی دیگر',
};

const steps: WizardStep<FileReportForm>[] = [
  {
    key: 'why',
    ui: 'choice',
    // Not optional: a report with no reason is a report a moderator cannot sort.
    prompt: () => 'دلیل گزارش چیست؟ گزارش شما محرمانه است و به طرف مقابل اطلاع داده نمی‌شود.',
    load: () =>
      Promise.resolve(REASONS.map((value) => ({ value, label: REASON_FA[value] ?? value }))),
    accept: (input: WizardInput) => {
      const value = REASONS.find((candidate) => candidate === input.value);
      if (value === undefined) return { ok: false, error: 'یکی از گزینه‌ها را انتخاب کنید.' };
      return { ok: true, patch: { reason: value } };
    },
  },
  {
    key: 'note',
    ui: 'text',
    optional: true,
    prompt: () =>
      'اگر توضیحی دارید بنویسید — چه اتفاقی افتاد، و کِی. ' +
      'برای فرستادن گزارش بدون توضیح، «رد کردن» را بزنید.',
    accept: (input: WizardInput) => {
      if (input.kind !== 'text') return { ok: false, error: 'توضیح را بنویسید و بفرستید.' };
      const value = input.value.trim();
      // The contract's own bounds, restated so a refusal names the field rather
      // than arriving from Zod as «اطلاعات نامعتبر».
      if (value.length === 0) return { ok: false, error: 'توضیح خالی است.' };
      if (value.length > 1000) return { ok: false, error: 'توضیح باید حداکثر ۱۰۰۰ نویسه باشد.' };
      return { ok: true, patch: { description: value } };
    },
  },
];

export const fileReportWizard: WizardDefinition<FileReportForm> = {
  steps,
  empty: () => ({}),
};

/** The Persian label for a reason, so a summary renders what the buttons offered. */
export function reportReasonLabelFa(reason: string): string {
  return REASON_FA[reason] ?? reason;
}
