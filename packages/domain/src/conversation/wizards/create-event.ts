import { costType, genderPreference, type CostType, type GenderPreference } from '@payetam/shared';
import { parseIsoDay, toJalali, toPersianDigits, type Choice } from '@payetam/telegram';
import type { WizardDefinition, WizardInput, WizardStep } from '../wizard';

/**
 * Creating an event, as a conversation (ADR-0017).
 *
 * ── The shape of the flow, and why it is not sixteen questions ───────────────
 *
 * `CreateEventView` has sixteen fields. Asked one per turn that is sixteen round
 * trips, and the brief's own target — *a full event in under two minutes* — does
 * not survive it. Nine of the sixteen are genuinely optional: rules, a cost note,
 * a gender preference, an age range, an external link.
 *
 * So the flow is **core, then confirm, then extras on request**. Everything the
 * server requires is asked (title, description, category, where, when, how many,
 * what it costs); then the summary appears with «ثبت فعالیت» beside «افزودن
 * جزئیات بیشتر». Somebody who wants a simple event is done in eight taps and two
 * short texts. Somebody who wants an age range presses one more button and is
 * asked. The optional steps are not removed — they are moved off the critical
 * path, which is the difference between a form and an interrogation.
 *
 * ── Where validation lives ──────────────────────────────────────────────────
 *
 * Twice, deliberately, and they are not duplicates. Each step validates *its own
 * answer* so the error appears next to the question that caused it — a length, a
 * range, a date in the past. The assembled form is then validated by
 * `createEventRequest` and created by `EventService.create`, which is the same
 * path the API uses. No rule about what an event may be lives in this file; a
 * rule enforced on one surface protects one surface.
 *
 * The one cross-field rule that shows up here is `costAmount`, and it shows up
 * as a **`when`** rather than as a refusal: the amount step is asked only for
 * FIXED and APPROX. Not asking is a better expression of "not allowed for FREE"
 * than asking and then rejecting.
 */

export interface CreateEventForm {
  title?: string;
  description?: string;
  categoryId?: string;
  /** Set from the category button, so `when` stays pure. See `categoryChoice`. */
  categoryAllowsLabel?: boolean;
  customCategoryLabel?: string;
  provinceId?: string;
  cityId?: string;
  districtId?: string;
  /** Gregorian ISO day, as the calendar's buttons carry it. */
  day?: string;
  hour?: number;
  durationHours?: number;
  capacity?: number;
  costType?: CostType;
  costAmount?: number;
  /** Set by «افزودن جزئیات بیشتر» on the summary; gates every optional step. */
  wantsDetails?: boolean;
  costNote?: string;
  rules?: string;
  genderPreference?: GenderPreference;
  minAge?: number;
  maxAge?: number;
  externalLink?: string;
}

/**
 * A category button's value, carrying whether that category invites a custom
 * label.
 *
 * `<uuid>.L` versus `<uuid>`, which is fifty bytes at its widest — inside the
 * codec's sixty-four. The alternative is for the *step* to look the category up,
 * and steps are pure functions; the alternative to *that* is a form field the
 * service fills in behind the step's back, which is worse than a suffix because
 * it is invisible at the point that reads it.
 */
export function categoryChoice(id: string, nameFa: string, allowsCustomLabel: boolean): Choice {
  return { value: allowsCustomLabel ? `${id}.L` : id, label: nameFa };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chosenId(input: WizardInput): string | null {
  const value = input.value.endsWith('.L') ? input.value.slice(0, -2) : input.value;
  return UUID.test(value) ? value : null;
}

/**
 * Free text, trimmed and bounded, with the bound stated in the refusal.
 *
 * Returns the value rather than a patch, because the caller knows which field it
 * is filling and this helper does not. A discriminated union rather than an
 * optional `value`, so the success branch cannot be read without narrowing.
 */
type TextResult = { ok: true; value: string } | { ok: false; error: string };

function text(input: WizardInput, min: number, max: number, what: string): TextResult {
  if (input.kind !== 'text') {
    return { ok: false, error: `${what} را بنویسید و بفرستید.` };
  }
  const value = input.value.trim();
  if (value.length < min) {
    return { ok: false, error: `${what} باید دست‌کم ${toPersianDigits(String(min))} نویسه باشد.` };
  }
  if (value.length > max) {
    return { ok: false, error: `${what} نباید بیش از ${toPersianDigits(String(max))} نویسه باشد.` };
  }
  return { ok: true, value };
}

/** An integer from typed text or a tapped button, within bounds. */
function integer(input: WizardInput, min: number, max: number, what: string): number | string {
  const raw = input.value.trim().replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  if (!/^\d{1,9}$/.test(raw)) return `${what} را با عدد بنویسید.`;

  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    return `${what} باید بین ${toPersianDigits(String(min))} و ${toPersianDigits(String(max))} باشد.`;
  }
  return value;
}

const COST_TYPES = costType.options;
const GENDER_PREFERENCES = genderPreference.options;

const COST_TYPE_FA: Record<CostType, string> = {
  FREE: 'رایگان',
  FIXED: 'مبلغ مشخص',
  APPROX: 'تقریبی',
  SPLIT: 'دنگی',
};

/**
 * Two values, not three. «فرقی ندارد» is not a `GenderPreference` — it is the
 * *absence* of one, which is why this step is `optional` and «رد کردن» is how a
 * host says it. Adding an `ANY` member here would put a third state in the
 * database for something the contract expresses with null.
 */
const GENDER_FA: Record<GenderPreference, string> = {
  MALE_ONLY: 'فقط آقایان',
  FEMALE_ONLY: 'فقط بانوان',
};

/** Slots a gathering plausibly starts at. Twenty-four buttons is a wall. */
const HOURS = [8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const;
const DURATIONS = [1, 2, 3, 4, 6, 8] as const;
const CAPACITIES = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50] as const;

const steps: WizardStep<CreateEventForm>[] = [
  {
    key: 'title',
    ui: 'text',
    prompt: () => 'نام فعالیت را بنویسید.\nمثال: «کوهنوردی صبح جمعه — درکه»',
    accept: (input) => {
      const result = text(input, 3, 80, 'نام فعالیت');
      return result.ok ? { ok: true, patch: { title: result.value } } : result;
    },
  },
  {
    key: 'desc',
    ui: 'text',
    prompt: () => 'کمی درباره‌اش بنویسید — چه می‌کنید، چه چیزی لازم است، برای چه کسانی مناسب است.',
    accept: (input) => {
      const result = text(input, 10, 2000, 'توضیح');
      return result.ok ? { ok: true, patch: { description: result.value } } : result;
    },
  },
  {
    key: 'cat',
    ui: 'choice',
    prompt: () => 'این فعالیت در کدام دسته می‌گنجد؟',
    load: (_form, deps) => deps.categories(),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) return { ok: false, error: 'یکی از دسته‌ها را انتخاب کنید.' };
      return {
        ok: true,
        patch: { categoryId: id, categoryAllowsLabel: input.value.endsWith('.L') },
      };
    },
  },
  {
    key: 'catlabel',
    ui: 'text',
    when: (form) => form.categoryAllowsLabel === true,
    prompt: () => 'خودتان چه نامی روی این فعالیت می‌گذارید؟',
    accept: (input) => {
      const result = text(input, 2, 60, 'عنوان دسته');
      return result.ok ? { ok: true, patch: { customCategoryLabel: result.value } } : result;
    },
  },
  {
    key: 'prov',
    ui: 'choice',
    prompt: () => 'در کدام استان برگزار می‌شود؟',
    load: (_form, deps) => deps.provinces(),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) return { ok: false, error: 'یکی از استان‌ها را انتخاب کنید.' };
      // The city and district are cleared: they belonged to the old province,
      // and leaving them would publish an event in a city the host did not pick.
      return { ok: true, patch: { provinceId: id, cityId: undefined, districtId: undefined } };
    },
  },
  {
    key: 'city',
    ui: 'choice',
    prompt: () => 'کدام شهر؟',
    load: (form, deps) => deps.citiesOf(form.provinceId ?? ''),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) return { ok: false, error: 'یکی از شهرها را انتخاب کنید.' };
      return { ok: true, patch: { cityId: id, districtId: undefined } };
    },
  },
  {
    key: 'dist',
    ui: 'choice',
    optional: true,
    prompt: () => 'کدام محله؟ اگر مهم نیست، «رد کردن» را بزنید.',
    load: (form, deps) => deps.districtsOf(form.cityId ?? ''),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) return { ok: false, error: 'یکی از محله‌ها را انتخاب کنید یا رد کنید.' };
      return { ok: true, patch: { districtId: id } };
    },
  },
  {
    key: 'day',
    ui: 'calendar',
    prompt: () => 'چه روزی؟',
    accept: (input) => {
      const day = parseIsoDay(input.value);
      if (day === null) return { ok: false, error: 'یکی از روزهای تقویم را انتخاب کنید.' };
      return { ok: true, patch: { day: input.value } };
    },
  },
  {
    key: 'hour',
    ui: 'time',
    prompt: () => 'ساعت شروع؟',
    load: () =>
      Promise.resolve(
        HOURS.map((hour) => ({
          value: String(hour),
          label: `${toPersianDigits(String(hour).padStart(2, '0'))}:۰۰`,
        })),
      ),
    accept: (input) => {
      const value = integer(input, 0, 23, 'ساعت');
      if (typeof value === 'string') return { ok: false, error: value };
      return { ok: true, patch: { hour: value } };
    },
  },
  {
    key: 'dur',
    ui: 'choice',
    prompt: () => 'چند ساعت طول می‌کشد؟',
    load: () =>
      Promise.resolve(
        DURATIONS.map((hours) => ({ value: String(hours), label: `${String(hours)} ساعت` })),
      ),
    accept: (input) => {
      const value = integer(input, 1, 24, 'مدت');
      if (typeof value === 'string') return { ok: false, error: value };
      return { ok: true, patch: { durationHours: value } };
    },
  },
  {
    key: 'cap',
    ui: 'choice',
    prompt: () => 'چند نفر جا دارید؟ (بدون احتساب خودتان)',
    load: () => Promise.resolve(CAPACITIES.map((n) => ({ value: String(n), label: String(n) }))),
    accept: (input) => {
      const value = integer(input, 1, 50, 'ظرفیت');
      if (typeof value === 'string') return { ok: false, error: value };
      return { ok: true, patch: { capacity: value } };
    },
  },
  {
    key: 'cost',
    ui: 'choice',
    prompt: () => 'هزینه چطور است؟',
    load: () =>
      Promise.resolve(COST_TYPES.map((type) => ({ value: type, label: COST_TYPE_FA[type] }))),
    accept: (input) => {
      const type = COST_TYPES.find((candidate) => candidate === input.value);
      if (type === undefined) return { ok: false, error: 'یکی از گزینه‌ها را انتخاب کنید.' };
      // Clearing the amount is what makes «رایگان» after «مبلغ مشخص» valid: the
      // contract refuses a costAmount on a FREE event, and a stale one would be
      // rejected by the server after the user thought they had fixed it.
      return { ok: true, patch: { costType: type, costAmount: undefined } };
    },
  },
  {
    key: 'amount',
    ui: 'text',
    when: (form) => form.costType === 'FIXED' || form.costType === 'APPROX',
    prompt: () => 'مبلغ به تومان، فقط عدد.',
    accept: (input) => {
      const value = integer(input, 0, 100_000_000, 'مبلغ');
      if (typeof value === 'string') return { ok: false, error: value };
      return { ok: true, patch: { costAmount: value } };
    },
  },

  // ── Beyond here is the optional half, reached from the summary ─────────────
  {
    key: 'gender',
    ui: 'choice',
    optional: true,
    when: (form) => form.wantsDetails === true,
    prompt: () => 'برای چه کسانی است؟ اگر فرقی ندارد، «رد کردن» را بزنید.',
    load: () =>
      Promise.resolve(GENDER_PREFERENCES.map((value) => ({ value, label: GENDER_FA[value] }))),
    accept: (input) => {
      const value = GENDER_PREFERENCES.find((candidate) => candidate === input.value);
      if (value === undefined) return { ok: false, error: 'یکی از گزینه‌ها را انتخاب کنید.' };
      return { ok: true, patch: { genderPreference: value } };
    },
  },
  {
    key: 'minage',
    ui: 'text',
    optional: true,
    when: (form) => form.wantsDetails === true,
    prompt: () => 'کمترین سن؟ فقط عدد، یا «رد کردن».',
    accept: (input) => {
      const value = integer(input, 18, 120, 'سن');
      if (typeof value === 'string') return { ok: false, error: value };
      return { ok: true, patch: { minAge: value } };
    },
  },
  {
    key: 'maxage',
    ui: 'text',
    optional: true,
    when: (form) => form.wantsDetails === true,
    prompt: () => 'بیشترین سن؟ فقط عدد، یا «رد کردن».',
    accept: (input, form) => {
      const value = integer(input, 18, 120, 'سن');
      if (typeof value === 'string') return { ok: false, error: value };
      // The one cross-field rule that has to be checked here rather than skipped
      // around: both ends are numbers and the user is looking at the second one.
      if (form.minAge !== undefined && value < form.minAge) {
        return { ok: false, error: 'بیشترین سن نمی‌تواند از کمترین سن کمتر باشد.' };
      }
      return { ok: true, patch: { maxAge: value } };
    },
  },
  {
    key: 'rules',
    ui: 'text',
    optional: true,
    when: (form) => form.wantsDetails === true,
    prompt: () => 'قاعده‌ای هست که شرکت‌کننده‌ها باید بدانند؟',
    accept: (input) => {
      const result = text(input, 1, 1000, 'قواعد');
      return result.ok ? { ok: true, patch: { rules: result.value } } : result;
    },
  },
  {
    key: 'link',
    ui: 'text',
    optional: true,
    when: (form) => form.wantsDetails === true,
    prompt: () => 'اگر لینکی دارید (کانال، فرم، نقشه) بفرستید.',
    accept: (input) => {
      const value = input.value.trim();
      if (!/^https:\/\/\S+$/.test(value)) {
        return { ok: false, error: 'لینک باید با https:// شروع شود.' };
      }
      return { ok: true, patch: { externalLink: value } };
    },
  },
];

export const createEventWizard: WizardDefinition<CreateEventForm> = {
  steps,
  empty: () => ({}),
};

/** «۱۵ شهریور» for the summary, without re-deriving the conversion. */
export function formDay(
  form: CreateEventForm,
): { year: number; month: number; day: number } | null {
  const parsed = form.day === undefined ? null : parseIsoDay(form.day);
  return parsed === null ? null : toJalali(parsed);
}
