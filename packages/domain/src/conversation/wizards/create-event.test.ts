import { describe, expect, it } from 'vitest';
import { UNLIMITED_CAPACITY } from '@payetam/shared';
import { apply, nextStep, progressOf, stepByKey } from '../wizard';
import { categoryChoice, createEventWizard, type CreateEventForm } from './create-event';

const UUID = '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f';

function accept(
  key: string,
  value: string,
  form: CreateEventForm = {},
  kind: 'text' | 'callback' = 'text',
) {
  const step = stepByKey(createEventWizard, key);
  if (step === null) throw new Error(`no step ${key}`);
  return apply(step, { kind, value }, form);
}

describe('title', () => {
  it('accepts a reasonable name', () => {
    expect(accept('title', ' کوهنوردی درکه ')).toEqual({
      ok: true,
      patch: { title: 'کوهنوردی درکه' },
    });
  });

  /**
   * The bound is stated, and stated in **Persian digits** — this asserted the
   * Latin `3` until the walkthrough showed «باید دست‌کم 3 نویسه باشد» rendered
   * beside «گام ۱ از ۱۱». Every other number this product shows a user is
   * Persian; a validation message is not the place to make an exception.
   */
  it('says how short is too short, in Persian digits', () => {
    const result = accept('title', 'ab');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('۳');
      expect(result.error).not.toMatch(/[0-9]/);
    }
  });

  it('states a range in Persian digits too', () => {
    const result = accept('cap', '9999');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toMatch(/[0-9]/);
  });

  it('refuses one that is too long', () => {
    expect(accept('title', 'ا'.repeat(81)).ok).toBe(false);
  });

  /** A tapped button where text was asked for. */
  it('refuses a callback', () => {
    expect(accept('title', 'x', {}, 'callback').ok).toBe(false);
  });
});

describe('category', () => {
  it('reads the id out of the button', () => {
    const choice = categoryChoice(UUID, 'کوهنوردی');

    expect(choice.value).toBe(UUID);
    expect(accept('cat', choice.value, {}, 'callback')).toEqual({
      ok: true,
      patch: { categoryId: UUID },
    });
  });

  it('refuses anything that is not an id, and quotes it back', () => {
    const result = accept('cat', 'not-a-uuid', {}, 'callback');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('«not-a-uuid»');
  });

  /**
   * The «سایر» escape hatch is gone (v0.6.7): choosing a category no longer
   * leads anywhere but the province. The `.L` suffix that carried the flag went
   * with it, and migration 0039 turned the flag off on the rows — a category
   * that still allowed a label with no step to answer it would be refused at
   * submit by `CUSTOM_LABEL_REQUIRED`.
   */
  it('goes straight from the category to the province', () => {
    expect(nextStep(createEventWizard, 'cat', {})?.key).toBe('prov');
  });
});

describe('province and city', () => {
  /**
   * A city belongs to the province it was chosen under. Changing the province
   * and keeping the city would publish an event in a city the host did not pick.
   */
  it('clears the city and district when the province changes', () => {
    const result = accept('prov', UUID, { cityId: 'old', districtId: 'older' }, 'callback');

    expect(result).toEqual({
      ok: true,
      patch: { provinceId: UUID, cityId: undefined, districtId: undefined },
    });
  });

  it('clears the district when the city changes', () => {
    const result = accept('city', UUID, { districtId: 'old' }, 'callback');

    expect(result).toEqual({ ok: true, patch: { cityId: UUID, districtId: undefined } });
  });
});

describe('day', () => {
  it('accepts a day from the calendar', () => {
    expect(accept('day', '2026-09-06', {}, 'callback')).toEqual({
      ok: true,
      patch: { day: '2026-09-06' },
    });
  });

  /** Callback values are untrusted. */
  it('refuses anything that is not a day', () => {
    expect(accept('day', 'tomorrow', {}, 'callback').ok).toBe(false);
    expect(accept('day', '2026-9-6', {}, 'callback').ok).toBe(false);
  });
});

describe('numbers', () => {
  it('reads Persian digits, which is what a Persian keyboard produces', () => {
    expect(accept('cap', '۱۲')).toEqual({ ok: true, patch: { capacity: 12 } });
  });

  it('refuses a capacity outside what an event may hold', () => {
    expect(accept('cap', '0').ok).toBe(false);
    expect(accept('cap', '1001').ok).toBe(false);
  });

  /**
   * One is a real answer, and the step could not give it.
   *
   * The buttons started at two and the prompt did not say typing was allowed, so
   * a host looking for a single companion had nothing to press.
   */
  it('accepts one, which the old button list could not offer', () => {
    expect(accept('cap', '1')).toEqual({ ok: true, patch: { capacity: 1 } });
  });

  /**
   * «بدون محدودیت» sends a letter, so it cannot be confused with a typed number
   * — and it resolves to a real capacity the seat arithmetic keeps working
   * against, rather than to a null the whole stack would have to special-case.
   */
  it('turns the unlimited button into the sentinel capacity', () => {
    expect(accept('cap', 'u', {}, 'callback')).toEqual({
      ok: true,
      patch: { capacity: UNLIMITED_CAPACITY },
    });
  });

  /** A host who types the sentinel meant a number, and gets one. It is the same value. */
  it('accepts the sentinel typed as a number', () => {
    expect(accept('cap', '1000')).toEqual({ ok: true, patch: { capacity: 1000 } });
  });

  it('refuses text where a number belongs', () => {
    expect(accept('cap', 'چند نفر').ok).toBe(false);
  });
});

describe('cost', () => {
  it('accepts a cost type', () => {
    expect(accept('cost', 'FIXED', {}, 'callback')).toMatchObject({
      ok: true,
      patch: { costType: 'FIXED' },
    });
  });

  /**
   * The cross-field rule, expressed as *not asking* rather than as refusing.
   * `createEventRequest` rejects a costAmount on a FREE event, so the amount
   * step must not be reachable for one.
   */
  it('asks for an amount only for FIXED and APPROX', () => {
    expect(nextStep(createEventWizard, 'cost', { costType: 'FIXED' })?.key).toBe('amount');
    expect(nextStep(createEventWizard, 'cost', { costType: 'APPROX' })?.key).toBe('amount');
    expect(nextStep(createEventWizard, 'cost', { costType: 'FREE' })).toBeNull();
    expect(nextStep(createEventWizard, 'cost', { costType: 'SPLIT' })).toBeNull();
  });

  /**
   * Choosing «رایگان» after «مبلغ مشخص» must unset the amount, or the server
   * refuses an event the user believes they have just corrected.
   */
  it('clears a stale amount when the cost type changes', () => {
    const result = accept('cost', 'FREE', { costAmount: 50_000 }, 'callback');

    expect(result).toEqual({ ok: true, patch: { costType: 'FREE', costAmount: undefined } });
  });
});

describe('age range', () => {
  it('refuses a maximum below the minimum', () => {
    const result = accept('maxage', '25', { minAge: 30, wantsDetails: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('کمتر');
  });

  it('accepts a maximum at or above it', () => {
    expect(accept('maxage', '30', { minAge: 30, wantsDetails: true })).toEqual({
      ok: true,
      patch: { maxAge: 30 },
    });
  });

  it('refuses an age below eighteen', () => {
    expect(accept('minage', '15', { wantsDetails: true }).ok).toBe(false);
  });
});

describe('external link', () => {
  it('requires https', () => {
    expect(accept('link', 'http://example.com', { wantsDetails: true }).ok).toBe(false);
    expect(accept('link', 'https://example.com', { wantsDetails: true }).ok).toBe(true);
  });
});

describe('the flow as a whole', () => {
  /**
   * The point of the design: everything the server requires, and nothing else,
   * before the summary. The brief's target is a full event in under two minutes.
   */
  it('keeps the optional half off the critical path', () => {
    const core: CreateEventForm = { costType: 'FREE' };
    const optional: CreateEventForm = { costType: 'FREE', wantsDetails: true };

    expect(progressOf(createEventWizard, 'title', core).total).toBe(11);
    expect(progressOf(createEventWizard, 'title', optional).total).toBe(16);
  });

  it('walks the core path end to end without reaching an optional step', () => {
    const form: CreateEventForm = { costType: 'FREE' };
    const visited: string[] = ['title'];

    let key: string | null = 'title';
    while (key !== null) {
      const next: { key: string } | null = nextStep(createEventWizard, key, form);
      key = next?.key ?? null;
      if (key !== null) visited.push(key);
    }

    expect(visited).toEqual([
      'title',
      'desc',
      'cat',
      'prov',
      'city',
      'dist',
      'day',
      'hour',
      'dur',
      'cap',
      'cost',
    ]);
  });
});

describe('digits, in every system a Persian keyboard produces', () => {
  /**
   * Three reach this product: ASCII, Persian `۰-۹` (U+06F0) and Arabic-Indic
   * `٠-٩` (U+0660). iOS emits the second, several Android keyboards the third.
   * Handling only Persian — which this did — refuses a number the user can see
   * on their own screen.
   */
  it('accepts ASCII, Persian and Arabic-Indic digits alike', () => {
    expect(accept('cap', '12')).toEqual({ ok: true, patch: { capacity: 12 } });
    expect(accept('cap', '۱۲')).toEqual({ ok: true, patch: { capacity: 12 } });
    expect(accept('cap', '١٢')).toEqual({ ok: true, patch: { capacity: 12 } });
  });

  /** «۵۰,۰۰۰» and «۵۰٬۰۰۰» are how a price is written by hand. */
  it('accepts thousands separators of either kind', () => {
    expect(accept('amount', '۵۰,۰۰۰', { costType: 'FIXED' })).toEqual({
      ok: true,
      patch: { costAmount: 50_000 },
    });
    expect(accept('amount', '۵۰٬۰۰۰', { costType: 'FIXED' })).toEqual({
      ok: true,
      patch: { costAmount: 50_000 },
    });
  });
});

describe('hours', () => {
  /**
   * This offered fourteen "plausible" slots, so an event at 23:00 or 06:00 could
   * not be expressed at all — and nothing said the gap was a choice.
   */
  it('offers all twenty-four', async () => {
    const step = stepByKey(createEventWizard, 'hour');
    const choices = await step!.load!({}, {} as never);

    expect(choices).toHaveLength(24);
    expect(choices.map((c) => c.value)).toContain('0');
    expect(choices.map((c) => c.value)).toContain('23');
  });
});

describe('duration', () => {
  it('accepts a number of hours', () => {
    expect(accept('dur', '3')).toEqual({ ok: true, patch: { durationHours: 3 } });
    expect(accept('dur', '۳ ساعت')).toEqual({ ok: true, patch: { durationHours: 3 } });
  });

  /** «تمام روز» is how an all-day outing is said; «۱۲ ساعت» is not. */
  it('accepts a named duration', () => {
    expect(accept('dur', 'تمام روز')).toEqual({ ok: true, patch: { durationHours: 12 } });
    expect(accept('dur', 'all day')).toEqual({ ok: true, patch: { durationHours: 12 } });
    expect(accept('dur', 'نیم روز')).toEqual({ ok: true, patch: { durationHours: 4 } });
  });

  it('reads days as days', () => {
    expect(accept('dur', '۲ روز')).toEqual({ ok: true, patch: { durationHours: 24 } });
  });

  it('refuses something with no duration in it', () => {
    expect(accept('dur', 'زیاد').ok).toBe(false);
  });
});

describe('cost', () => {
  /**
   * Production reported «Free shows an error asking for an amount». The tap was
   * landing on a different step, but the clearing is what makes FREE safe
   * regardless: the contract refuses a costAmount on a free event.
   */
  it('carries no amount for FREE or SPLIT', () => {
    expect(accept('cost', 'FREE', { costAmount: 99 }, 'callback')).toEqual({
      ok: true,
      patch: { costType: 'FREE', costAmount: undefined },
    });
    expect(accept('cost', 'SPLIT', { costAmount: 99 }, 'callback')).toEqual({
      ok: true,
      patch: { costType: 'SPLIT', costAmount: undefined },
    });
  });
});
