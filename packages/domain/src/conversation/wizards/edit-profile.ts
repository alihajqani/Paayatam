import { gender, type Gender } from '@payetam/shared';
import type { Choice } from '@payetam/telegram';
import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * Editing a profile, as a conversation (ADR-0017).
 *
 * ── Why this one comes before the others ────────────────────────────────────
 *
 * ADR-0017 leads with a sequencing constraint: the Mini App cannot be retired
 * until the bot can complete a profile, because a user who never reaches
 * `PROFILE_COMPLETE` cannot do anything at all. `EditEventView` is a
 * convenience; this is a gate.
 *
 * ── Every step is optional, and that is the difference from creating ────────
 *
 * `CreateEventForm` starts empty and has to be filled. A profile **already
 * exists**, and an edit is a change to some of it — so every step here can be
 * skipped, and a skipped step means *leave that field alone* rather than clear
 * it. `UpdateProfileInput` takes a partial for exactly this reason, and the
 * caller sends only the keys the user actually answered.
 *
 * That is why there is no `when` anywhere in this file: nothing here is
 * conditional on anything else, and the flow is a straight line somebody can
 * step out of at any point by pressing «رد کردن».
 */

export interface EditProfileForm {
  displayName?: string;
  gender?: Gender;
  birthYear?: number;
  provinceId?: string;
  cityId?: string;
  districtId?: string;
  bio?: string;
}

const GENDERS = gender.options;

const GENDER_FA: Record<Gender, string> = {
  MALE: 'آقا',
  FEMALE: 'خانم',
  PREFER_NOT_SAY: 'ترجیح می‌دهم نگویم',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chosenId(input: WizardInput): string | null {
  return UUID.test(input.value) ? input.value : null;
}

/**
 * A Gregorian birth year, from Persian or Latin digits.
 *
 * **Gregorian, and the prompt says so.** `birthYear` is Gregorian in the
 * contract and in the column, and a Persian speaker asked for «سال تولد» in a
 * bot that has just shown them a Jalali calendar will reasonably type ۱۳۷۰. The
 * range check catches it — 1370 is outside 1900–2200 — but a refusal that only
 * says "out of range" leaves them retyping the same number, so the question
 * names the calendar it wants.
 */
function birthYearOf(input: WizardInput): number | string {
  const raw = input.value.trim().replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  if (!/^\d{4}$/.test(raw)) return 'سال تولد را با چهار رقم بنویسید.';

  const year = Number.parseInt(raw, 10);
  if (year >= 1300 && year <= 1450) {
    return 'سال تولد را به میلادی بنویسید. برای نمونه ۱۳۷۰ شمسی می‌شود ۱۹۹۱.';
  }
  if (year < 1900 || year > 2200) return 'سال تولد معتبر نیست.';
  return year;
}

const steps: WizardStep<EditProfileForm>[] = [
  {
    key: 'name',
    ui: 'text',
    optional: true,
    prompt: () => 'نام نمایشی‌تان چه باشد؟ برای تغییر ندادن، «رد کردن» را بزنید.',
    accept: (input) => {
      if (input.kind !== 'text') return { ok: false, error: 'نام را بنویسید و بفرستید.' };
      const value = input.value.trim();
      if (value.length < 2 || value.length > 40) {
        return { ok: false, error: 'نام نمایشی باید بین ۲ تا ۴۰ نویسه باشد.' };
      }
      return { ok: true, patch: { displayName: value } };
    },
  },
  {
    key: 'gender',
    ui: 'choice',
    optional: true,
    prompt: () => 'جنسیت؟',
    load: () => Promise.resolve(GENDERS.map((value) => ({ value, label: GENDER_FA[value] }))),
    accept: (input) => {
      const value = GENDERS.find((candidate) => candidate === input.value);
      if (value === undefined) return { ok: false, error: 'یکی از گزینه‌ها را انتخاب کنید.' };
      return { ok: true, patch: { gender: value } };
    },
  },
  {
    key: 'birth',
    ui: 'text',
    optional: true,
    prompt: () => 'سال تولد، به میلادی. برای نمونه: ۱۹۹۱',
    accept: (input) => {
      const value = birthYearOf(input);
      if (typeof value === 'string') return { ok: false, error: value };
      return { ok: true, patch: { birthYear: value } };
    },
  },
  {
    key: 'prov',
    ui: 'choice',
    optional: true,
    prompt: () => 'در کدام استان هستید؟',
    load: (_form, deps) => deps.provinces(),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) return { ok: false, error: 'یکی از استان‌ها را انتخاب کنید.' };
      // The city belonged to the old province; keeping it would put somebody in
      // a city they did not choose.
      return { ok: true, patch: { provinceId: id, cityId: undefined, districtId: undefined } };
    },
  },
  {
    key: 'city',
    ui: 'choice',
    optional: true,
    prompt: () => 'کدام شهر؟',
    load: (form, deps) => deps.citiesOf(form.provinceId ?? ''),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) return { ok: false, error: 'یکی از شهرها را انتخاب کنید.' };
      return { ok: true, patch: { cityId: id, districtId: undefined } };
    },
  },
  {
    key: 'bio',
    ui: 'text',
    optional: true,
    prompt: () => 'یکی دو جمله دربارهٔ خودتان.',
    accept: (input) => {
      if (input.kind !== 'text') return { ok: false, error: 'متن را بنویسید و بفرستید.' };
      const value = input.value.trim();
      if (value.length > 500) return { ok: false, error: 'معرفی نباید بیش از ۵۰۰ نویسه باشد.' };
      return { ok: true, patch: { bio: value } };
    },
  },
];

export const editProfileWizard: WizardDefinition<EditProfileForm> = {
  steps,
  empty: () => ({}),
};

/** The Persian label for a gender, for the summary. */
export function genderLabel(value: Gender): string {
  return GENDER_FA[value];
}

/** Unused by the machine; exported so a caller can render the same options. */
export const GENDER_CHOICES: readonly Choice[] = GENDERS.map((value) => ({
  value,
  label: GENDER_FA[value],
}));
