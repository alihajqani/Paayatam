import { describe, expect, it } from 'vitest';
import { apply, nextStep, stepByKey } from '../wizard';
import { editProfileWizard, type EditProfileForm } from './edit-profile';

const UUID = '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f';

function accept(
  key: string,
  value: string,
  form: EditProfileForm = {},
  kind: 'text' | 'callback' = 'text',
) {
  const step = stepByKey(editProfileWizard, key);
  if (step === null) throw new Error(`no step ${key}`);
  return apply(step, { kind, value }, form);
}

describe('every step is skippable', () => {
  /**
   * A profile already exists; an edit changes some of it. Skipping means "leave
   * this alone", which is why `UpdateProfileInput` takes a partial.
   */
  it('lets any step be skipped, changing nothing', () => {
    for (const step of editProfileWizard.steps) {
      expect(apply(step, { kind: 'callback', action: 'skip', value: '' }, {})).toEqual({
        ok: true,
        patch: {},
      });
    }
  });

  /** Nothing here is conditional, so the flow is a straight line. */
  it('has no conditional steps', () => {
    expect(editProfileWizard.steps.every((step) => step.when === undefined)).toBe(true);
  });
});

describe('display name', () => {
  it('accepts and trims a name', () => {
    expect(accept('name', '  علی  ')).toEqual({ ok: true, patch: { displayName: 'علی' } });
  });

  it('refuses one that is too short or too long', () => {
    expect(accept('name', 'ا').ok).toBe(false);
    expect(accept('name', 'ا'.repeat(41)).ok).toBe(false);
  });
});

/**
 * The question is asked in Jalali and the answer is stored in Gregorian.
 *
 * This inverted in v0.6.5. The form used to ask for a Gregorian year and refuse
 * ۱۳۷۰ with an explanation of how to convert it — which is the product asking a
 * Persian user to do arithmetic it could do itself, three screens after a date
 * picker that renders «۱۵ شهریور ۱۴۰۵» for exactly the opposite reason.
 *
 * The **column is unchanged**: `birth_year` is Gregorian in the schema, in
 * `completeProfileRequest` and in `ageFromBirthYear`, and the conversion happens
 * here at the boundary. So every assertion below reads "Jalali in, Gregorian
 * out".
 */
describe('birth year', () => {
  it('takes a Jalali year and stores the Gregorian one', () => {
    expect(accept('birth', '۱۳۷۰')).toEqual({ ok: true, patch: { birthYear: 1991 } });
  });

  it('reads Latin digits too', () => {
    expect(accept('birth', '1370')).toEqual({ ok: true, patch: { birthYear: 1991 } });
  });

  /** Arabic-Indic, which is what several Android keyboards emit. */
  it('reads Arabic-Indic digits', () => {
    expect(accept('birth', '١٣٧٠')).toEqual({ ok: true, patch: { birthYear: 1991 } });
  });

  /**
   * The mistake the change itself creates: somebody who learned the old form, or
   * who simply thinks in Gregorian, types ۱۹۹۱. «سال تولد معتبر نیست» would be
   * true, unhelpful, and identical to what a typo produces — so the refusal says
   * what the question is now and what their own answer is in it.
   */
  it('recognises a Gregorian year and gives back the Jalali one', () => {
    const result = accept('birth', '۱۹۹۱');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('شمسی');
      expect(result.error).toContain('۱۳۷۰');
    }
  });

  it('refuses something that is not a four-digit year', () => {
    expect(accept('birth', '91').ok).toBe(false);
    expect(accept('birth', 'پارسال').ok).toBe(false);
  });

  /** A typo, not a claim: nobody is 130 and nobody is unborn. */
  it('refuses a year outside a plausible lifetime', () => {
    expect(accept('birth', '۱۲۰۰').ok).toBe(false);
    expect(accept('birth', '۱۴۵۰').ok).toBe(false);
  });
});

describe('gender', () => {
  it('accepts each of the three values', () => {
    for (const value of ['MALE', 'FEMALE', 'PREFER_NOT_SAY']) {
      expect(accept('gender', value, {}, 'callback').ok).toBe(true);
    }
  });

  it('refuses anything else', () => {
    expect(accept('gender', 'OTHER', {}, 'callback').ok).toBe(false);
  });
});

describe('province and city', () => {
  it('clears the city when the province changes', () => {
    expect(accept('prov', UUID, { cityId: 'old' }, 'callback')).toEqual({
      ok: true,
      patch: { provinceId: UUID, cityId: undefined, districtId: undefined },
    });
  });

  it('walks straight through', () => {
    expect(nextStep(editProfileWizard, 'prov', {})?.key).toBe('city');
  });
});

describe('bio', () => {
  it('accepts a short introduction', () => {
    expect(accept('bio', 'کوهنورد و کتاب‌خوان.')).toMatchObject({ ok: true });
  });

  it('refuses one over the limit', () => {
    expect(accept('bio', 'ا'.repeat(501)).ok).toBe(false);
  });
});
