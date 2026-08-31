import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * A code somebody was given, typed into the bot (v0.6.4).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * The product has two codes a person can be *handed*: a gift or campaign code,
 * and somebody else's referral code. Until this wizard, the bot could take
 * neither of them from a screen.
 *
 * A gift code was `/gift ABCD1234` — a command, with an argument, typed exactly
 * right, by somebody who had to know the command existed. A referral code was
 * worse: it could only arrive as `?start=<code>` on a link, so a code read out
 * loud, written on a flyer or forwarded as plain text had **no way in at all**.
 * `HomeView` had a field for it and v0.4.6 removed the last button that opened
 * the app.
 *
 * ── Why one wizard and not two ──────────────────────────────────────────────
 *
 * Because the form is identical — one field, four to thirty-two characters —
 * and what differs is only which service the answer is handed to. Two
 * definitions would be two copies of the same validation, drifting apart at the
 * first change to either code's bounds.
 *
 * Which kind of code this is arrives through `start`'s `initialForm`, exactly as
 * `FILE_REPORT`'s target does and for the same reason: the button that was
 * tapped knows, the user does not need to be asked something the product already
 * has the answer to, and a step that asked would be a question with one right
 * answer already on screen.
 *
 * ── Why the code is not pattern-matched here ────────────────────────────────
 *
 * `redeemGiftCodeRequest` and `claimReferralRequest` are both length-bounded
 * rather than pattern-matched, deliberately: the server upper-cases and strips
 * spaces and dashes before looking a code up, so somebody who types «summer-24»
 * is not told they were wrong about something they copied correctly. A stricter
 * check here would reintroduce exactly that refusal one layer earlier — and the
 * alphabet a code is drawn from is `ReferralService`'s, not this form's.
 */

/** Which code is being typed. Seeded by the caller; never asked. */
export const CODE_KINDS = ['gift', 'referral'] as const;
export type CodeKind = (typeof CODE_KINDS)[number];

export interface RedeemCodeForm {
  /** `gift` or `referral` — seeded by the button that opened the form. */
  codeKind?: CodeKind;
  code?: string;
}

/** The contract's own bounds, restated so a refusal names the field. */
const MIN_LENGTH = 4;
const MAX_LENGTH = 32;

const steps: WizardStep<RedeemCodeForm>[] = [
  {
    key: 'code',
    ui: 'text',
    /**
     * Not optional, and there is nothing else in the form: a code wizard with a
     * «رد کردن» would submit nothing, which is what «انصراف» is for.
     */
    prompt: (form) =>
      form.codeKind === 'referral'
        ? 'کد معرفی کسی که شما را دعوت کرده بفرستید.\n\n' +
          'بعد از شرکت در نخستین فعالیت، هم شما و هم او سکه می‌گیرید.'
        : 'کد هدیه را بفرستید.\n\n' +
          'همان‌طور که دریافت کرده‌اید بنویسید؛ بزرگی و کوچکی حروف و خط تیره مهم نیست.',
    accept: (input: WizardInput) => {
      if (input.kind !== 'text') return { ok: false, error: 'کد را بنویسید و بفرستید.' };
      const value = input.value.trim();

      // Two sentences rather than one, because the two mistakes have different
      // fixes: a short answer is usually half a code, and a long one is usually
      // a whole sentence pasted around it.
      if (value.length < MIN_LENGTH) {
        return { ok: false, error: 'این کد کوتاه‌تر از آن است که درست باشد. دوباره نگاه کنید.' };
      }
      if (value.length > MAX_LENGTH) {
        return { ok: false, error: 'فقط خودِ کد را بفرستید، بدون توضیح دیگری.' };
      }

      return { ok: true, patch: { code: value } };
    },
  },
];

export const redeemCodeWizard: WizardDefinition<RedeemCodeForm> = {
  steps,
  empty: () => ({}),
};

/** Whether a value carried in a form is one of the two kinds. */
export function isCodeKind(value: unknown): value is CodeKind {
  return CODE_KINDS.some((candidate) => candidate === value);
}
