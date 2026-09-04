import { reviewTag, type ReviewTag } from '@payetam/shared';
import { toPersianDigits } from '@payetam/telegram';
import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * The half of a review that needs a form (v0.5.4).
 *
 * ── Why the rating is not in here ───────────────────────────────────────────
 *
 * Because it does not need to be. `/reviews` offers five ratings as buttons and
 * a tap writes the review immediately — two taps, which is fewer than
 * `ReviewsView` ever managed and the reason ratings started getting written at
 * all. This wizard is what somebody opens when they want to say *more* than a
 * number, and it amends a review that already exists.
 *
 * `review.edit_window_minutes` is what makes that legal: `ReviewService.edit`
 * replaces the whole review inside the window and before the pair reveals, so
 * the rating already given is carried back in unchanged and only the tags and
 * the comment move.
 *
 * ── Five tags, not one (v0.8.1) ─────────────────────────────────────────────
 *
 * The contract allows up to five and this asked for exactly one, on the argument
 * that "selecting several would mean a step that loops back into itself,
 * accumulating into an array, with a «تمام» to leave — and a loop is the one
 * shape `progressOf` cannot count". The argument was right about the shape and
 * wrong about the consequence: a `multi` step does loop back into itself, and it
 * is still **one** step, so `progressOf` counts it once and «گام ۱ از ۲» stays
 * true however many times it is redrawn. `StepUi` has the kind now, and the
 * machine — not this file — knows that a multi-select does not advance.
 *
 * So a review can say «سر وقت آمد» *and* «خوش‌برخورد», which is what a review of
 * a person usually has to say. Forcing a choice between them was asking the
 * reviewer to throw away the half of their opinion that did not fit.
 *
 * ── Why the tags come before the comment ────────────────────────────────────
 *
 * Because most people write no comment. Tags are two taps and a comment is a
 * paragraph, so the step order decides whether the structured half of a review
 * gets filled in at all — and a reviewer who skips the writing must still have
 * been offered, and still be able to answer, the part that is a keyboard.
 */

export interface WriteReviewForm {
  /**
   * Up to `MAX_REVIEW_TAGS` of them, in the order they were tapped.
   *
   * An array from v0.8.1, where it was a single `tag`. Drafts written by the
   * previous build hold the old key and are read by nobody: `handle` clears a
   * conversation whose step key no longer exists, and `submitReviewDetail`
   * treats an absent `tags` as "no tags were chosen" — which for a seven-day
   * draft is both true and harmless.
   */
  tags?: ReviewTag[];
  comment?: string;
}

/**
 * The contract's own ceiling, restated where the buttons are.
 *
 * `submitReviewRequest` caps `tags` at five, and a refusal from Zod at the
 * service boundary reaches the user as «اطلاعات نامعتبر» with no field named —
 * so the step refuses the sixth tap itself, in a sentence about tags. The two
 * numbers must agree; this one exists so the *message* can.
 */
export const MAX_REVIEW_TAGS = 5;

const TAGS = reviewTag.options;

/**
 * The closed list, in the language the reviewer reads.
 *
 * Ordered warm-first because the common review is a good one, and a list that
 * opens with «دیر آمد» invites a reading nobody meant. The two negatives stay —
 * a review vocabulary with no way to say something went wrong is a vocabulary
 * that flatters.
 */
const TAG_FA: Record<ReviewTag, string> = {
  PUNCTUAL: '⏰ سر وقت آمد',
  FRIENDLY: '😊 خوش‌برخورد',
  GOOD_CONVERSATION: '💬 هم‌صحبت خوب',
  WELL_ORGANISED: '📋 برنامه‌ریزی خوب',
  AS_DESCRIBED: '✅ مطابق توضیحات',
  WOULD_MEET_AGAIN: '🔁 دوباره شرکت می‌کنم',
  LATE: '🐢 دیر آمد',
  UNCOMMUNICATIVE: '🔇 کم‌پاسخ بود',
};

const steps: WizardStep<WriteReviewForm>[] = [
  {
    key: 'tag',
    ui: 'multi',
    optional: true,
    prompt: () =>
      'کدام موردها به این تجربه می‌خورد؟ هر تعداد که می‌خواهید انتخاب کنید، بعد «تمام» را بزنید.',
    load: () => Promise.resolve(TAGS.map((value) => ({ value, label: TAG_FA[value] }))),
    selectedOf: (form) => form.tags ?? [],
    accept: (input: WizardInput, form: WriteReviewForm) => {
      /**
       * Typed text, on the step before the one that wants it.
       *
       * The likeliest thing somebody types here is their comment — the next
       * question — and the generic «یکی از گزینه‌ها را انتخاب کنید» would refuse
       * it without saying that the way forward is «تمام». A multi-select is the
       * one step kind where "answer it" and "leave it" are different gestures,
       * so the refusal has to name the second one.
       */
      if (input.kind === 'text') {
        return {
          ok: false,
          error:
            'برای انتخاب برچسب‌ها از دکمه‌های زیر استفاده کنید. ' +
            'اگر می‌خواهید توضیح بنویسید، اول «تمام» را بزنید.',
        };
      }

      const value = TAGS.find((candidate) => candidate === input.value);
      if (value === undefined) return { ok: false, error: 'یکی از گزینه‌ها را انتخاب کنید.' };

      const current = form.tags ?? [];
      // A second tap removes it. One control for both directions, and the tick
      // in the label says which the next tap will be.
      if (current.includes(value)) {
        return { ok: true, patch: { tags: current.filter((tag) => tag !== value) } };
      }
      if (current.length >= MAX_REVIEW_TAGS) {
        return {
          ok: false,
          error:
            `حداکثر ${toPersianDigits(String(MAX_REVIEW_TAGS))} مورد می‌توانید انتخاب کنید. ` +
            `برای انتخاب این یکی، اول یکی از موردهای تیک‌خورده را بردارید.`,
        };
      }
      return { ok: true, patch: { tags: [...current, value] } };
    },
  },
  {
    key: 'comment',
    ui: 'text',
    optional: true,
    prompt: () => 'اگر توضیحی دارید بنویسید. برای رد شدن، «رد کردن» را بزنید.',
    accept: (input: WizardInput) => {
      if (input.kind !== 'text') return { ok: false, error: 'توضیح را بنویسید و بفرستید.' };
      const value = input.value.trim();
      // The contract's own bounds, restated because a refusal from Zod at the
      // service boundary would reach the user as «اطلاعات نامعتبر» with no field.
      if (value.length === 0) return { ok: false, error: 'توضیح خالی است.' };
      if (value.length > 500) return { ok: false, error: 'توضیح باید حداکثر ۵۰۰ نویسه باشد.' };
      return { ok: true, patch: { comment: value } };
    },
  },
];

export const writeReviewWizard: WizardDefinition<WriteReviewForm> = {
  steps,
  empty: () => ({}),
};

/**
 * The Persian label for a tag, so a summary renders what the buttons offered.
 *
 * Takes a `string` rather than a `ReviewTag`: `review.tags` is `String[]` in the
 * database, and a tag written by a newer deploy should render as itself rather
 * than crash the digest that lists it. The narrow type is what the wizard emits;
 * the wide one is what a read comes back as.
 */
export function reviewTagLabel(value: string): string {
  return TAG_FA[value as ReviewTag] ?? value;
}
