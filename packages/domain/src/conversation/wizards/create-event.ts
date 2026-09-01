import { costType, genderPreference, type CostType, type GenderPreference } from '@payetam/shared';
import { parseIsoDay, toJalali, toPersianDigits, type Choice } from '@payetam/telegram';
import { acceptInteger, acceptText, quoted, toAsciiDigits, type TextResult } from './answers';
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
  provinceId?: string;
  cityId?: string;
  districtId?: string;
  /** A neighbourhood the host typed, when the catalogue offers none. See the `dist` step. */
  districtLabel?: string;
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
 * A category button: the id it carries, and the name it shows.
 *
 * It used to carry a `.L` suffix as well, meaning *this category invites a name
 * of your own* — the «سایر» escape hatch. That whole path is gone (v0.6.7): the
 * step that asked for the name did not work, and a category nobody can name is
 * simply a category, so the value is the id and nothing else.
 */
export function categoryChoice(id: string, nameFa: string): Choice {
  return { value: id, label: nameFa };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chosenId(input: WizardInput): string | null {
  return UUID.test(input.value) ? input.value : null;
}

/**
 * Free text, and an integer — both delegated to `answers.ts`.
 *
 * The rules used to live here and said only what the bound was. A refusal that
 * restates a rule at somebody who believes they satisfied it is not a refusal
 * they can act on: it never said that the two spaces they typed were trimmed
 * away, or which of the characters they sent was not a digit. The shared
 * versions echo what actually arrived, and every wizard gets the same treatment
 * rather than the one whose author remembered.
 */
function text(input: WizardInput, min: number, max: number, what: string): TextResult {
  return acceptText(input, min, max, what);
}

function integer(input: WizardInput, min: number, max: number, what: string): number | string {
  return acceptInteger(input, min, max, what);
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

/**
 * Every hour of the day.
 *
 * This was fourteen "plausible" slots, and production found the hole: an event
 * at 23:00 or 06:00 could not be expressed at all, and there was no hint that
 * the missing hours were a choice rather than a bug. Twenty-four buttons at four
 * to a row is six rows — the same height the calendar already occupies, and
 * nobody has to wonder where midnight went.
 */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DURATIONS = [1, 2, 3, 4, 6, 8] as const;

/**
 * Durations people name rather than count.
 *
 * «تمام روز» is the one that matters: an all-day outing is a normal thing to
 * host and «۱۲ ساعت» is not how anybody says it. The values are hours because
 * that is what `endsAt` is built from — the naming is presentation, the storage
 * is not.
 */
const NAMED_DURATIONS: readonly { readonly words: readonly string[]; readonly hours: number }[] = [
  { words: ['نیم روز', 'نیم‌روز', 'half day'], hours: 4 },
  {
    words: ['یک روز', 'تمام روز', 'تمام‌روز', 'کل روز', 'all day', 'one day', 'full day'],
    hours: 12,
  },
  { words: ['یک ساعت', 'one hour'], hours: 1 },
  { words: ['دو ساعت'], hours: 2 },
  { words: ['سه ساعت'], hours: 3 },
];

/**
 * A duration, from a button, a number, or words.
 *
 * Three shapes because all three arrive: `4` from a button, «۳ ساعت» typed with
 * the unit, and «تمام روز» typed as a phrase. Returning the hours keeps the
 * storage a number regardless of how it was said.
 */
function durationHours(input: WizardInput): number | string {
  const raw = toAsciiDigits(input.value.trim().toLowerCase());

  const named = NAMED_DURATIONS.find((entry) => entry.words.some((word) => raw.includes(word)));
  if (named !== undefined) return named.hours;

  const digits = /(\d{1,3})/.exec(raw);
  if (digits === null) {
    return (
      `در ${quoted(input.value)} عددی پیدا نکردم. ` +
      `مدت را به ساعت بنویسید — برای نمونه «۳ ساعت» یا «تمام روز».`
    );
  }

  const hours = Number.parseInt(digits[1] ?? '', 10);
  // Days, when somebody writes «۲ روز».
  const inDays = /روز|day/.test(raw);
  const total = inDays ? hours * 12 : hours;
  if (total < 1 || total > 24) {
    return (
      `مدت باید بین ۱ تا ۲۴ ساعت باشد — ` +
      `${quoted(input.value)} یعنی ${toPersianDigits(String(total))} ساعت.`
    );
  }
  return total;
}
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
      if (id === null) {
        return {
          ok: false,
          error: `دسته را از دکمه‌های زیر انتخاب کنید — ${quoted(input.value)} یکی از آن‌ها نیست.`,
        };
      }
      return { ok: true, patch: { categoryId: id } };
    },
  },
  {
    key: 'prov',
    ui: 'choice',
    prompt: () => 'در کدام استان برگزار می‌شود؟',
    load: (_form, deps) => deps.provinces(),
    accept: (input) => {
      const id = chosenId(input);
      if (id === null) {
        return {
          ok: false,
          error: `استان را از دکمه‌های زیر انتخاب کنید — ${quoted(input.value)} یکی از آن‌ها نیست.`,
        };
      }
      // The city and district are cleared: they belonged to the old province,
      // and leaving them would publish an event in a city the host did not pick.
      return {
        ok: true,
        patch: {
          provinceId: id,
          cityId: undefined,
          districtId: undefined,
          districtLabel: undefined,
        },
      };
    },
  },
  {
    key: 'city',
    ui: 'choice',
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
      return { ok: true, patch: { cityId: id, districtId: undefined, districtLabel: undefined } };
    },
  },
  /**
   * The neighbourhood — **picked when there is a list, typed when there is not.**
   *
   * ── Why this step could not be answered at all ──────────────────────────────
   *
   * `district` is a curated table, `seed-geography.ts` states plainly that *"the
   * dataset has none"*, and the admin panel can deactivate a district but has no
   * screen that creates one. So `deps.districtsOf(cityId)` returns `[]` in every
   * deployment that exists, and this step drew a keyboard with «رد کردن» on it
   * and nothing else. The only answer to «کدام محله؟» was to decline to answer.
   *
   * ── Why both, rather than replacing the list ────────────────────────────────
   *
   * A tapped district is a foreign key: filterable, rankable, renameable in one
   * place, and deactivatable when a neighbourhood stops being served. Typed text
   * is none of those, so throwing the list away would be a downgrade for the day
   * the catalogue is populated. The step therefore keeps `ui: 'choice'` — the
   * buttons appear when there are any — and *also* accepts a typed answer, which
   * the machinery already delivers here: `accept` receives `{ kind: 'text' }`
   * for a message and `{ kind: 'callback' }` for a tap, and this step simply
   * stopped reading the first.
   *
   * `EventService.resolveNeighbourhood` decides between the two when both are
   * somehow present, and a CHECK on the table is the backstop.
   */
  {
    key: 'dist',
    ui: 'choice',
    optional: true,
    prompt: (form) =>
      form.districtLabel === undefined
        ? 'محله را بنویسید — مثلاً «درکه». اگر مهم نیست، «رد کردن» را بزنید.'
        : `محله: ${form.districtLabel}\n\nبرای تغییر، نام تازه را بنویسید.`,
    load: (form, deps) => deps.districtsOf(form.cityId ?? ''),
    accept: (input) => {
      if (input.kind === 'text') {
        const result = text(input, 2, 60, 'محله');
        // The catalogue id is cleared: a host who typed a neighbourhood has
        // replaced the one they tapped, and keeping both would put two answers
        // on one event for the CHECK to refuse at the last possible moment.
        return result.ok
          ? { ok: true, patch: { districtLabel: result.value, districtId: undefined } }
          : result;
      }

      const id = chosenId(input);
      if (id === null) {
        return {
          ok: false,
          error: `محله را بنویسید یا یکی از دکمه‌ها را بزنید — ${quoted(input.value)} محله‌ای نبود.`,
        };
      }
      return { ok: true, patch: { districtId: id, districtLabel: undefined } };
    },
  },
  {
    key: 'day',
    ui: 'calendar',
    prompt: () => 'چه روزی؟',
    accept: (input) => {
      const day = parseIsoDay(input.value);
      if (day === null) {
        return {
          ok: false,
          error:
            'روز را از تقویم زیر انتخاب کنید. تاریخ را دستی ننویسید — ' +
            'اگر ماه دیگری می‌خواهید، «ماه بعد» را بزنید.',
        };
      }
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
    prompt: () => 'چقدر طول می‌کشد؟ یکی را بزنید یا بنویسید — «۳ ساعت»، «تمام روز».',
    load: () =>
      Promise.resolve([
        ...DURATIONS.map((hours) => ({
          value: String(hours),
          label: `${toPersianDigits(String(hours))} ساعت`,
        })),
        { value: '12', label: 'تمام روز' },
      ]),
    accept: (input) => {
      const value = durationHours(input);
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
      if (type === undefined) {
        return {
          ok: false,
          error: `نوع هزینه را از دکمه‌های زیر انتخاب کنید — ${quoted(input.value)} یکی از آن‌ها نیست.`,
        };
      }
      // FREE and SPLIT carry no amount, and the contract refuses one on them.
      if (type === 'FREE' || type === 'SPLIT') {
        return { ok: true, patch: { costType: type, costAmount: undefined } };
      }
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
      if (value === undefined) {
        return {
          ok: false,
          error:
            `یکی از دکمه‌های زیر را بزنید، یا «رد کردن» اگر فرقی ندارد — ` +
            `${quoted(input.value)} گزینهٔ این مرحله نیست.`,
        };
      }
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
        return {
          ok: false,
          error:
            `بیشترین سن نمی‌تواند از کمترین سن کمتر باشد — ` +
            `کمترین سن را ${toPersianDigits(String(form.minAge))} گذاشتید و ` +
            `${toPersianDigits(String(value))} فرستادید.`,
        };
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
        return {
          ok: false,
          error:
            `لینک باید با https:// شروع شود و فاصله نداشته باشد — ` +
            `${quoted(value)} این شکل را ندارد. اگر لینکی ندارید، «رد کردن» را بزنید.`,
        };
      }
      return { ok: true, patch: { externalLink: value } };
    },
  },
];

/**
 * Re-exported from `answers.ts`, where the rule now lives.
 *
 * Kept as a name on this module because `edit-profile.ts` and the tests import
 * it from here, and the digit folding is one rule rather than two.
 */
export { toAsciiDigits };

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
