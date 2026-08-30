import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * A moderator's decision on one case (v0.6.3, ADR-0018).
 *
 * ── Why a decision is a form and not a pair of buttons ──────────────────────
 *
 * `AdminOperationsService.decideCase` refuses a note shorter than three
 * characters, and that refusal is §7's: *"terminal states require `decided_by` +
 * `decision_note`"*. A decision nobody signed and nobody explained is not
 * reviewable later, and the panel has always required both. A bot that offered
 * «تأیید»/«رد» as two taps would either write an empty note — making the bot the
 * one surface where a decision is unaccountable — or collect the note somewhere,
 * which is a form.
 *
 * So it is a form, and it reuses everything every other bot form already has:
 * `last_update_id` idempotency, one message edited in place, the seven-day
 * sweep, «انصراف» on every step.
 *
 * ── What is seeded and what is asked ────────────────────────────────────────
 *
 * The **case** arrives through `targetPublicId` and its **trigger** and
 * **headline** through `initialForm`, for the reason `FILE_REPORT`'s target
 * does: a step's `accept` is pure and cannot read a database, and asking a
 * moderator to restate which case they just tapped would be asking a question
 * the product already has the answer to.
 *
 * The headline is the case as `formatAdminCasePrompt` rendered it, carried in
 * the draft so the question stays readable on every redraw — including a
 * redelivery, which re-renders and must not re-read. It is plain text: the
 * wizard renderer escapes its prompt, so markup here would reach the moderator
 * as visible entities.
 *
 * ── Why `falsePositive` is conditional ──────────────────────────────────────
 *
 * It only means something when the automation is the thing being judged. A
 * moderator approving content that `AUTO_BLACKLIST` flagged is saying the
 * scanner was wrong, and ADR-0012 turns that into a *number* — the false
 * positive rate, without which the blacklist can only ever get more aggressive.
 * Approving a `REPORT_THRESHOLD` case says nothing about the scanner, and
 * rejecting content says the scanner was right. Asking in either of those cases
 * would collect an answer to a question nobody meant.
 *
 * `when` rather than a refusal, which is the rule the cost-amount step set:
 * *not asking* is a better expression of "does not apply" than asking and then
 * declining the answer. And because `nextStep` re-evaluates on every move,
 * going back and changing «تأیید» to «رد» removes the step it had added.
 */
export interface AdminCaseForm {
  /** Seeded: how the case reads, already rendered. */
  headline?: string;
  /** Seeded: `AUTO_BLACKLIST`, `REPORT_THRESHOLD` or `MANUAL`. */
  trigger?: string;
  decision?: string;
  falsePositive?: boolean;
  note?: string;
}

const DECISIONS = ['APPROVED', 'REJECTED'] as const;

/**
 * The two verdicts, in the language a moderator reads.
 *
 * «تأیید محتوا» rather than «تأیید پرونده»: what is being approved is the
 * *content*, and the case is closed either way. A moderator who reads "approve
 * the case" as "agree with the report" would reject what they meant to keep.
 */
const DECISION_FA: Record<string, string> = {
  APPROVED: '✅ محتوا مشکلی ندارد',
  REJECTED: '⛔️ محتوا رد شود',
};

const steps: WizardStep<AdminCaseForm>[] = [
  {
    key: 'verdict',
    ui: 'choice',
    // The case itself is the question. Seeded rather than re-read, so a redraw
    // and a redelivery show exactly what the moderator was looking at.
    prompt: (form) => form.headline ?? 'تصمیم شما دربارهٔ این پرونده چیست؟',
    load: () =>
      Promise.resolve(DECISIONS.map((value) => ({ value, label: DECISION_FA[value] ?? value }))),
    accept: (input: WizardInput) => {
      const value = DECISIONS.find((candidate) => candidate === input.value);
      if (value === undefined) return { ok: false, error: 'یکی از دو گزینه را انتخاب کنید.' };
      /**
       * Changing the verdict clears the false-positive answer.
       *
       * `when` removes the step, but a value already in the draft would survive
       * into `decideCase` and record that the scanner was wrong about a case the
       * moderator has since decided the other way. The same reason the cost step
       * clears its amount, and the reason `FormPatch` is a mapped type rather
       * than `Partial` — only the former can express *clearing* a field.
       */
      return { ok: true, patch: { decision: value, falsePositive: undefined } };
    },
  },
  {
    key: 'falsepos',
    ui: 'choice',
    when: (form) => form.decision === 'APPROVED' && form.trigger === 'AUTO_BLACKLIST',
    prompt: () => 'آیا هشدار خودکار اشتباه بود؟ پاسخ شما نرخ خطای فهرست واژه‌های مسدود را می‌سازد.',
    load: () =>
      Promise.resolve([
        { value: 'yes', label: 'بله، هشدار اشتباه بود' },
        { value: 'no', label: 'نه، هشدار درست بود' },
      ]),
    accept: (input: WizardInput) => {
      if (input.value !== 'yes' && input.value !== 'no') {
        return { ok: false, error: 'یکی از دو گزینه را انتخاب کنید.' };
      }
      return { ok: true, patch: { falsePositive: input.value === 'yes' } };
    },
  },
  {
    key: 'note',
    ui: 'text',
    // Not optional, and the one step in any bot wizard that cannot be: the
    // service refuses a note shorter than three characters, so «رد کردن» here
    // would build a form that is guaranteed to fail at submit.
    prompt: () => 'چرا؟ یک جمله بنویسید. این توضیح در پروندهٔ دائمی ثبت می‌شود.',
    accept: (input: WizardInput) => {
      if (input.kind !== 'text') return { ok: false, error: 'توضیح را بنویسید و بفرستید.' };
      const value = input.value.trim();
      // The service's own bound, restated so a refusal names the field rather
      // than arriving from the service as «اطلاعات نامعتبر».
      if (value.length < 3) return { ok: false, error: 'توضیح باید دست‌کم ۳ نویسه باشد.' };
      if (value.length > 500) return { ok: false, error: 'توضیح باید حداکثر ۵۰۰ نویسه باشد.' };
      return { ok: true, patch: { note: value } };
    },
  },
];

export const adminCaseWizard: WizardDefinition<AdminCaseForm> = {
  steps,
  empty: () => ({}),
};

/** The Persian label for a verdict, so a summary renders what the buttons offered. */
export function adminDecisionLabelFa(decision: string): string {
  return DECISION_FA[decision] ?? decision;
}
