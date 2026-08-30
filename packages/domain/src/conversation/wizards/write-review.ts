import { reviewTag, type ReviewTag } from '@payetam/shared';
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
 * ── Why one tag and not five ────────────────────────────────────────────────
 *
 * The contract allows up to five and `ReviewsView` renders them as checkboxes.
 * A reply keyboard has no checkbox: selecting several would mean a step that
 * loops back into itself, accumulating into an array, with a «تمام» to leave —
 * and a loop is the one shape `progressOf` cannot count, so the wizard's own
 * «گام ۲ از ۳» would start lying.
 *
 * One tag, and the honest limitation stated: this is the tag that fits best.
 * Multi-select wants a step kind the machine does not have, and inventing one
 * for a field that decorates a rating is the wrong order to build things in.
 */

export interface WriteReviewForm {
  tag?: ReviewTag;
  comment?: string;
}

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
    ui: 'choice',
    optional: true,
    prompt: () => 'کدام مورد بیشتر به این تجربه می‌خورد؟',
    load: () => Promise.resolve(TAGS.map((value) => ({ value, label: TAG_FA[value] }))),
    accept: (input: WizardInput) => {
      const value = TAGS.find((candidate) => candidate === input.value);
      if (value === undefined) return { ok: false, error: 'یکی از گزینه‌ها را انتخاب کنید.' };
      return { ok: true, patch: { tag: value } };
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
