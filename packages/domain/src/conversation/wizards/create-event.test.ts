import { describe, expect, it } from 'vitest';
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
    const result = accept('cap', '99');

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
  it('reads the id out of a plain button', () => {
    expect(accept('cat', UUID, {}, 'callback')).toEqual({
      ok: true,
      patch: { categoryId: UUID, categoryAllowsLabel: false },
    });
  });

  /** The `.L` suffix is how a pure step learns the category invites a label. */
  it('reads the label flag out of a suffixed button', () => {
    const choice = categoryChoice(UUID, 'سایر', true);

    expect(choice.value).toBe(`${UUID}.L`);
    expect(accept('cat', choice.value, {}, 'callback')).toEqual({
      ok: true,
      patch: { categoryId: UUID, categoryAllowsLabel: true },
    });
  });

  it('refuses anything that is not an id', () => {
    expect(accept('cat', 'not-a-uuid', {}, 'callback').ok).toBe(false);
  });

  it('asks for a custom label only when the category invites one', () => {
    expect(nextStep(createEventWizard, 'cat', { categoryAllowsLabel: true })?.key).toBe('catlabel');
    expect(nextStep(createEventWizard, 'cat', { categoryAllowsLabel: false })?.key).toBe('prov');
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
    expect(accept('cap', '51').ok).toBe(false);
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
