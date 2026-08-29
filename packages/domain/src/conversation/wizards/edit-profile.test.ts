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

describe('birth year', () => {
  it('accepts a Gregorian year', () => {
    expect(accept('birth', '1991')).toEqual({ ok: true, patch: { birthYear: 1991 } });
  });

  it('reads Persian digits', () => {
    expect(accept('birth', '۱۹۹۱')).toEqual({ ok: true, patch: { birthYear: 1991 } });
  });

  /**
   * The mistake this product will actually see: a Persian speaker in a bot that
   * has just shown them a Jalali calendar types ۱۳۷۰. "Out of range" would leave
   * them retyping it, so the refusal names the conversion.
   */
  it('recognises a Jalali year and says how to convert it', () => {
    const result = accept('birth', '۱۳۷۰');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('میلادی');
      expect(result.error).toContain('۱۹۹۱');
    }
  });

  it('refuses something that is not a four-digit year', () => {
    expect(accept('birth', '91').ok).toBe(false);
    expect(accept('birth', 'پارسال').ok).toBe(false);
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
