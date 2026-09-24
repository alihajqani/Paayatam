import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * «من حاضر بودم», «میزبان نیامد», and a host's answer — one question (plan 08).
 *
 * ── One form for three claims ───────────────────────────────────────────────
 *
 * All three are one person saying, in a sentence, what happened at one evening,
 * and all three land on a moderation case. What differs is which service call
 * the answer goes to and what the question says — so `mode` arrives seeded by
 * the button, exactly as `DIRECT_MESSAGE`'s does: a participant public id and an
 * event public id are both UUIDs, and only the button knows which one this is.
 *
 * ── Why the bounds are here as well as in the service and the table ─────────
 *
 * `NoShowClaimService` refuses outside 10 to 500 characters and a CHECK refuses
 * it again. Restating the bound here is what lets the refusal name the problem —
 * «کمی بیشتر بنویسید» — rather than arrive at submit as «اطلاعات نامعتبر» after the
 * form has closed.
 */

export const NO_SHOW_CLAIM_MODES = ['dispute', 'absent', 'response'] as const;
export type NoShowClaimMode = (typeof NO_SHOW_CLAIM_MODES)[number];

export interface NoShowClaimForm {
  /** Seeded by the button that opened the form. Never asked. */
  mode?: NoShowClaimMode;
  statement?: string;
}

const MIN_LENGTH = 10;
const MAX_LENGTH = 500;

const steps: WizardStep<NoShowClaimForm>[] = [
  {
    key: 'statement',
    ui: 'text',
    prompt: (form) =>
      (form.mode === 'response'
        ? 'گزارش شده که شما به این رویداد نیامده‌اید. توضیح خودتان را بنویسید: کِی رسیدید، ' +
          'چه کسانی آنجا بودند، و هر چیزی که به داور کمک می‌کند.'
        : form.mode === 'absent'
          ? 'بنویسید چه شد: کِی رسیدید، چه مدت منتظر ماندید، و اینکه میزبان را دیدید یا نه.'
          : 'بنویسید که حاضر بودید: کِی رسیدید، و چه کسانی آنجا بودند.') +
      '\n\n' +
      'یک داور نوشتهٔ هر دو طرف را می‌خواند و تصمیم می‌گیرد. تا آن وقت هیچ سکه‌ای جابه‌جا نمی‌شود.',
    accept: (input: WizardInput) => {
      if (input.kind === 'photo') {
        return { ok: false, error: 'فعلاً فقط متن پذیرفته می‌شود. ماجرا را بنویسید.' };
      }
      if (input.kind !== 'text') return { ok: false, error: 'ماجرا را بنویسید و بفرستید.' };

      const value = input.value.trim();
      if (value.length < MIN_LENGTH) {
        return { ok: false, error: 'کمی بیشتر بنویسید تا داور بتواند قضاوت کند.' };
      }
      if (value.length > MAX_LENGTH) {
        return { ok: false, error: 'نوشته خیلی بلند است. آن را در ۵۰۰ نویسه خلاصه کنید.' };
      }
      return { ok: true, patch: { statement: value } };
    },
  },
];

export const noShowClaimWizard: WizardDefinition<NoShowClaimForm> = {
  steps,
  empty: () => ({}),
};

/** Whether a value carried in a form is one of the three modes. */
export function isNoShowClaimMode(value: unknown): value is NoShowClaimMode {
  return NO_SHOW_CLAIM_MODES.some((candidate) => candidate === value);
}
