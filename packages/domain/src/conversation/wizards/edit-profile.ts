import { gender, type Gender } from '@payetam/shared';
import { toPersianDigits, type Choice } from '@payetam/telegram';
import { acceptText, quoted, toAsciiDigits } from './answers';
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
 * The offset between a Jalali year and the Gregorian year it begins in.
 *
 * Farvardin 1 of year `jy` falls on 20–21 March of `jy + 621`, every year,
 * without exception — the two calendars' new years are fixed relative to each
 * other even though their leap rules differ. So for a *year*, and only for a
 * year, the conversion is addition.
 *
 * ── Why this is not `Intl`, when the calendar picker is ─────────────────────
 *
 * `wizard/jalali.ts` converts Gregorian → Jalali through ICU and refuses to go
 * the other way, because Jalali → Gregorian for a *date* is where hand-written
 * implementations get leap years wrong. That argument does not reach here: a
 * birth year carries no month and no day, so there is no leap year to get
 * wrong. There is one genuine ambiguity and it is inherent rather than
 * introduced — someone born in Esfand ۱۳۷۰ was born in early 1992, not 1991 —
 * and it is the same off-by-one the product already accepts by storing a year
 * instead of a date (`ageFromBirthYear` says so at length).
 */
const JALALI_EPOCH_OFFSET = 621;

/** ۱۳۷۰ → 1991. The direction the form stores in. */
export function jalaliYearToGregorian(jalaliYear: number): number {
  return jalaliYear + JALALI_EPOCH_OFFSET;
}

/** 1991 → ۱۳۷۰. The direction every screen renders in. */
export function gregorianYearToJalali(gregorianYear: number): number {
  return gregorianYear - JALALI_EPOCH_OFFSET;
}

/**
 * The oldest and youngest birth years the form will take, **in Jalali**.
 *
 * A window rather than an open range, because the failure this catches is a typo
 * and not a claim: ۱۲۷۰ is a hundred and thirty years old and ۱۴۲۰ is not born
 * yet. The 18+ rule is *not* enforced here — `ProfileService.complete` owns it,
 * against `profile.min_age_years` and the server clock, and a second copy of a
 * legal threshold in a wizard step is a second copy that will drift.
 */
const MIN_JALALI_BIRTH_YEAR = 1280;
const MAX_JALALI_BIRTH_YEAR = 1420;

/**
 * A birth year, asked and answered in **Jalali**, stored as Gregorian.
 *
 * ── What changed ────────────────────────────────────────────────────────────
 *
 * This used to ask for a Gregorian year, and said so in the prompt, and refused
 * ۱۳۷۰ with a sentence explaining that ۱۳۷۰ شمسی is ۱۹۹۱. That is the product
 * asking a Persian user to do a calendar conversion by hand, in the one form
 * where they are least likely to want to — and doing it three screens after a
 * date picker that renders «۱۵ شهریور ۱۴۰۵» for exactly the opposite reason.
 * `wizard/jalali.ts` already argues the case: *"asking somebody to choose «6
 * September» for an event they think of as «۱۵ شهریور» is asking them to do the
 * conversion the software refused to."*
 *
 * The **column is unchanged**. `birth_year` is Gregorian in the schema, in
 * `completeProfileRequest`, and in `ageFromBirthYear`'s arithmetic; converting
 * at the boundary rather than migrating a column keeps one calendar inside the
 * system and one in front of the user, which is the same rule ADR-0008 sets for
 * timestamps.
 *
 * ── A Gregorian year is still recognised, and corrected ─────────────────────
 *
 * Somebody who typed ۱۹۹۱ into the old form and is retyping it into the new one
 * gets told what the new question is and what their answer would be in it —
 * rather than «سال تولد معتبر نیست», which is true, unhelpful, and identical to
 * what a genuine typo produces.
 */
function birthYearOf(input: WizardInput): number | string {
  const raw = toAsciiDigits(input.value.trim());
  if (!/^\d{4}$/.test(raw)) {
    return (
      `سال تولد را به شمسی و با چهار رقم بنویسید — برای نمونه ۱۳۷۰. ` +
      `${quoted(input.value)} چهار رقم نبود.`
    );
  }

  const year = Number.parseInt(raw, 10);

  if (year >= 1900 && year <= 2200) {
    const asJalali = gregorianYearToJalali(year);
    return (
      `سال تولد را به شمسی بنویسید. ` +
      `${String(year)} میلادی می‌شود ${toPersianDigits(String(asJalali))} شمسی.`
    );
  }
  if (year < MIN_JALALI_BIRTH_YEAR || year > MAX_JALALI_BIRTH_YEAR) {
    return (
      `سال تولد باید بین ${toPersianDigits(String(MIN_JALALI_BIRTH_YEAR))} و ` +
      `${toPersianDigits(String(MAX_JALALI_BIRTH_YEAR))} شمسی باشد — ` +
      `${toPersianDigits(String(year))} فرستادید.`
    );
  }

  return jalaliYearToGregorian(year);
}

const steps: WizardStep<EditProfileForm>[] = [
  {
    key: 'name',
    ui: 'text',
    optional: true,
    prompt: () => 'نام نمایشی‌تان چه باشد؟ برای تغییر ندادن، «رد کردن» را بزنید.',
    accept: (input) => {
      const result = acceptText(input, 2, 40, 'نام نمایشی');
      return result.ok ? { ok: true, patch: { displayName: result.value } } : result;
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
      if (value === undefined) {
        return {
          ok: false,
          error:
            `یکی از دکمه‌های زیر را بزنید، یا «رد کردن» برای تغییر ندادن — ` +
            `${quoted(input.value)} گزینهٔ این مرحله نیست.`,
        };
      }
      return { ok: true, patch: { gender: value } };
    },
  },
  {
    key: 'birth',
    ui: 'text',
    optional: true,
    prompt: () => 'سال تولد شما به شمسی؟ برای نمونه: ۱۳۷۰',
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
      if (id === null) {
        return {
          ok: false,
          error: `استان را از دکمه‌های زیر انتخاب کنید — ${quoted(input.value)} یکی از آن‌ها نیست.`,
        };
      }
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
      if (id === null) {
        return {
          ok: false,
          error:
            `شهر را از دکمه‌های زیر انتخاب کنید — ${quoted(input.value)} یکی از آن‌ها نیست. ` +
            `اگر شهرتان در فهرست نیست، با «بازگشت» استان دیگری را امتحان کنید.`,
        };
      }
      return { ok: true, patch: { cityId: id, districtId: undefined } };
    },
  },
  {
    key: 'bio',
    ui: 'text',
    optional: true,
    prompt: () => 'یکی دو جمله دربارهٔ خودتان.',
    accept: (input) => {
      // One character is a legitimate bio; the floor is only "you sent something".
      const result = acceptText(input, 1, 500, 'معرفی');
      return result.ok ? { ok: true, patch: { bio: result.value } } : result;
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
