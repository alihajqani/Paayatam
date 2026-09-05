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

  /**
   * Nothing is conditional on an **answer**, so the ordinary flow is a straight
   * line.
   *
   * This asserted `when === undefined` on every step until v0.8.1, when
   * `/interests` gave the six ordinary steps one — and the property the old
   * assertion was protecting was never "no step has a `when`". It was that
   * somebody filling in this form cannot have a question disappear because of
   * something they typed three screens earlier, which is a real hazard in
   * `CREATE_EVENT` (where «رایگان» removes the amount step) and would be
   * bewildering here.
   *
   * `onlyInterests` is set by the *caller* before the first screen and never
   * changes afterwards, so it cannot do that. The test says so by walking the
   * whole form with every step answered and checking the shape does not move.
   */
  it('does not let an answer remove a question', () => {
    const answered: EditProfileForm = {
      displayName: 'علی',
      gender: 'MALE',
      birthYear: 1991,
      provinceId: UUID,
      cityId: UUID,
      bio: 'کوهنورد.',
      interestIds: [UUID],
    };

    const applicable = (form: EditProfileForm) =>
      editProfileWizard.steps.filter((step) => step.when === undefined || step.when(form));

    expect(applicable(answered).map((step) => step.key)).toEqual(
      applicable({}).map((step) => step.key),
    );
  });

  /**
   * `/interests` opens this same wizard at its last step (v0.8.1).
   *
   * A second `ConversationKind` would have been a migration, a duplicate
   * interests step and — because `conversation_state.user_id` is UNIQUE — two
   * forms that evict each other anyway. One flag, and `progressOf` then says
   * «گام ۱ از ۱», which is what somebody who asked for their interests should
   * see rather than «گام ۷ از ۷» on a form they never filled in.
   */
  it('shows only the interests when the caller asks for them', () => {
    const form: EditProfileForm = { onlyInterests: true };
    const applicable = editProfileWizard.steps.filter(
      (step) => step.when === undefined || step.when(form),
    );

    expect(applicable.map((step) => step.key)).toEqual(['tags']);
  });
});

/**
 * The interests, which the bot could not set at all until v0.8.1.
 *
 * `user_interest` has existed since M3 and `CompleteProfileView` had checkboxes
 * for it; ADR-0017 retired the view and the wizard that replaced it had no step,
 * so every profile the bot created carried no interests — on a product whose
 * discovery ranking reads them.
 */
describe('interests', () => {
  const OTHER = '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e70';

  it('adds a tap to the selection', () => {
    expect(accept('tags', UUID, {}, 'callback')).toEqual({
      ok: true,
      patch: { interestIds: [UUID] },
    });
  });

  it('keeps what was already chosen', () => {
    expect(accept('tags', OTHER, { interestIds: [UUID] }, 'callback')).toEqual({
      ok: true,
      patch: { interestIds: [UUID, OTHER] },
    });
  });

  /** The same button removes it — one control, and the tick says which way. */
  it('removes one that is already chosen', () => {
    expect(accept('tags', UUID, { interestIds: [UUID, OTHER] }, 'callback')).toEqual({
      ok: true,
      patch: { interestIds: [OTHER] },
    });
  });

  it('refuses anything that is not one of the offered ids', () => {
    expect(accept('tags', 'board-games', {}, 'callback').ok).toBe(false);
  });

  /**
   * The keyboard is drawn from the draft, so the ticks and the answer cannot
   * disagree. Without this the multi-select would open blank over a profile that
   * already has interests, and «تمام» would clear them.
   */
  it('reports what is already selected, for the ticks', () => {
    const step = stepByKey(editProfileWizard, 'tags');
    expect(step?.selectedOf?.({ interestIds: [UUID] })).toEqual([UUID]);
    expect(step?.selectedOf?.({})).toEqual([]);
  });

  /** A multi-select is drawn by the kind, and the machine reads the kind. */
  it('is a multi-select step', () => {
    expect(stepByKey(editProfileWizard, 'tags')?.ui).toBe('multi');
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

/**
 * Editing one field at a time (v0.9.1).
 *
 * The property that matters is not that a scoped form has one step — it is that
 * it has the *right* one, and that the unscoped form still has all seven. A
 * `when` that was slightly wrong would either strand somebody on a question they
 * did not ask for, or silently drop a step from profile completion, which is the
 * gate a new user cannot get past.
 */
describe('editProfileWizard — one field at a time', () => {
  function stepsFor(form: EditProfileForm): string[] {
    return editProfileWizard.steps
      .filter((step) => step.when === undefined || step.when(form))
      .map((step) => step.key);
  }

  it('asks all seven questions when no field is named', () => {
    expect(stepsFor({})).toEqual(['name', 'gender', 'birth', 'prov', 'city', 'bio', 'tags']);
  });

  it.each([
    ['name', ['name']],
    ['gender', ['gender']],
    ['birth', ['birth']],
    ['bio', ['bio']],
    ['tags', ['tags']],
  ])('asks only about %s', (field, expected) => {
    expect(stepsFor({ field } as EditProfileForm)).toEqual(expected);
  });

  /**
   * Province and city are one button and two steps. Splitting them would let
   * somebody change the province and keep the old city — a city in a province
   * they no longer live in, which the province step's own `accept` clears for
   * exactly this reason.
   */
  it('asks province and city together, because they are one decision', () => {
    expect(stepsFor({ field: 'loc' })).toEqual(['prov', 'city']);
  });

  /**
   * `/interests` predates the field selector and seeds the older flag. A
   * conversation that was already open when v0.9.1 shipped carries it, so it has
   * to keep meaning what it meant.
   */
  it('still honours onlyInterests, for a form that was already in flight', () => {
    expect(stepsFor({ onlyInterests: true })).toEqual(['tags']);
  });
});

describe('the province prompt', () => {
  const prov = editProfileWizard.steps.find((step) => step.key === 'prov');

  it('says nothing extra by default', () => {
    expect(prov?.prompt({})).toBe('در کدام استان هستید؟');
  });

  /**
   * The sentence is the whole point of the flag: two buttons and no explanation
   * reads as a broken product rather than a deliberate one.
   */
  it('explains the two open cities when the caller asks it to', () => {
    const text = prov?.prompt({ locationNotice: true }) ?? '';

    expect(text).toContain('در کدام استان هستید؟');
    expect(text).toContain('تهران و مشهد');
    expect(text).toContain('عمدی');
  });
});
