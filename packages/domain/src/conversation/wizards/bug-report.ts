import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * «مشکلی پیدا کردم» — a description, then the screenshots (v0.6.5).
 *
 * ── Why this is not a `FILE_REPORT` ─────────────────────────────────────────
 *
 * `FILE_REPORT` is moderation: it is about a person or something they posted, it
 * carries a reason from a fixed list of seven, and filing one can hide the thing
 * it names. A bug report is about the *product*. It has no subject to hide, no
 * reason worth enumerating — «دکمه کار نمی‌کند» does not fit «آزار و توهین» —
 * and somebody who finds three bugs in an afternoon must be able to send three,
 * which invariant 5's one-per-reporter UNIQUE would refuse.
 *
 * ── The one wizard that takes a photo ───────────────────────────────────────
 *
 * Every other surface in this bot answers a photo with «این نوع پیام پشتیبانی
 * نمی‌شود» (criterion 11), and that is right everywhere else: the chat relay
 * stores and re-sends what it is given, and an image is a payload the product
 * has no way to moderate, encrypt or account for. It is exactly wrong here,
 * because a screenshot *is* the report — «دکمه‌ی پیوستن کار نمی‌کند» and a
 * picture of the screen it does not work on are not the same message.
 *
 * So the photo step takes `{ kind: 'photo' }` inputs, and what it stores is a
 * **Telegram `file_id`**, never bytes. The image is already on Telegram's
 * servers; fetching a copy into this deployment would mean owning a retention
 * policy, a deletion path and a scanning question for a file the reporter has
 * already handed over, and a `file_id` is scoped to one bot token rather than
 * being a public URL.
 *
 * ── Why the description comes first ─────────────────────────────────────────
 *
 * Because it is the half that cannot be skipped, and asking for it second would
 * mean a user who sent a screenshot and wandered off left a report nobody can
 * act on. Screenshots are optional; a sentence is not.
 */

export interface BugReportForm {
  description?: string;
  /** Telegram file ids, in the order they arrived. Capped at `MAX_SCREENSHOTS`. */
  screenshotFileIds?: string[];
}

/**
 * How many screenshots one report may carry.
 *
 * Ten is far more than anybody sends and is a bound rather than a guess: the
 * column is a `TEXT[]` on one row, a CHECK enforces the same number, and without
 * a cap a user holding the shutter on a burst of screenshots could grow one row
 * without limit.
 */
export const MAX_SCREENSHOTS = 10;

const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 2000;

const steps: WizardStep<BugReportForm>[] = [
  {
    key: 'what',
    ui: 'text',
    prompt: () =>
      'چه مشکلی پیش آمد؟ تا جای ممکن دقیق بنویسید — چه کاری می‌کردید، چه انتظاری داشتید، و چه چیزی دیدید.',
    accept: (input: WizardInput) => {
      if (input.kind !== 'text') {
        // A photo arriving here is not a mistake worth scolding: the user has
        // the screenshot in hand and sent it first. Say which half comes first
        // rather than «این نوع پیام پشتیبانی نمی‌شود», which reads as a refusal
        // of screenshots altogether — the thing this form exists to accept.
        return {
          ok: false,
          error: 'ابتدا مشکل را بنویسید. در گام بعد می‌توانید تصویر بفرستید.',
        };
      }
      const value = input.value.trim();
      if (value.length < MIN_DESCRIPTION) {
        return { ok: false, error: 'توضیح باید دست‌کم ۱۰ نویسه باشد.' };
      }
      if (value.length > MAX_DESCRIPTION) {
        return { ok: false, error: 'توضیح نباید بیش از ۲۰۰۰ نویسه باشد.' };
      }
      return { ok: true, patch: { description: value } };
    },
  },
  {
    key: 'shots',
    ui: 'text',
    optional: true,
    prompt: (form) => {
      const count = form.screenshotFileIds?.length ?? 0;
      return count === 0
        ? 'اگر تصویری از مشکل دارید بفرستید. می‌توانید چند تصویر پشت هم بفرستید.\n\n' +
            'برای فرستادن گزارش بدون تصویر، «رد کردن» را بزنید.'
        : `${count} تصویر دریافت شد. می‌توانید تصویر دیگری بفرستید، ` +
            `یا برای ثبت گزارش «رد کردن» را بزنید.`;
    },
    /**
     * A photo **adds** rather than answers.
     *
     * The patch carries the whole array back, because a step returns a patch and
     * the machinery merges it — there is no "append" in that contract, and
     * inventing one for the single step that needs it would put a mutation in a
     * pipeline whose testability comes from every step being a pure function of
     * the form it is handed.
     *
     * The step deliberately does **not** advance on a photo. `nextStep` is
     * consulted after `accept`, and this being the last step means every photo
     * lands on the summary — which is the screen that then says how many have
     * arrived and offers «ثبت». Sending five screenshots is five messages and
     * one growing summary, rather than five forms.
     */
    accept: (input: WizardInput, form: BugReportForm) => {
      if (input.kind !== 'photo') {
        return {
          ok: false,
          error: 'یک تصویر بفرستید، یا برای ثبت گزارش «رد کردن» را بزنید.',
        };
      }

      const existing = form.screenshotFileIds ?? [];
      if (existing.length >= MAX_SCREENSHOTS) {
        return { ok: false, error: 'بیشتر از ۱۰ تصویر نمی‌توان فرستاد.' };
      }
      // A resent identical photo is one screenshot, not two: Telegram gives the
      // same `file_id` for the same file to the same bot, and a duplicate here
      // would be a moderator opening the same picture twice.
      if (existing.includes(input.value)) {
        return { ok: true, patch: { screenshotFileIds: existing } };
      }

      return { ok: true, patch: { screenshotFileIds: [...existing, input.value] } };
    },
  },
];

export const bugReportWizard: WizardDefinition<BugReportForm> = {
  steps,
  empty: () => ({ screenshotFileIds: [] }),
};
