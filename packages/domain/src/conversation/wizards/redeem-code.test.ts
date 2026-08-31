import { describe, expect, it } from 'vitest';
import { apply, firstStep, nextStep, stepByKey } from '../wizard';
import { isCodeKind, redeemCodeWizard, type RedeemCodeForm } from './redeem-code';

function accept(value: string, form: RedeemCodeForm = { codeKind: 'gift' }) {
  const step = stepByKey(redeemCodeWizard, 'code');
  if (step === null) throw new Error('no step code');
  return apply(step, { kind: 'text', value }, form);
}

describe('the code step', () => {
  it('takes a code as typed, trimmed', () => {
    expect(accept('  ABCD1234 ')).toEqual({ ok: true, patch: { code: 'ABCD1234' } });
  });

  /**
   * The services upper-case and strip separators before the lookup, so a code
   * copied faithfully as «summer-24» must not be refused by the form that is
   * asking for it. This is the assertion that keeps the validation length-only.
   */
  it.each(['summer-24', 'SUMMER 24', 'aBcD-1234'])('does not second-guess %s', (typed) => {
    expect(accept(typed)).toEqual({ ok: true, patch: { code: typed } });
  });

  it('refuses something too short to be a code', () => {
    expect(accept('AB')).toMatchObject({ ok: false });
  });

  it('refuses a sentence with a code somewhere in it', () => {
    expect(accept(`سلام، کد من این است: ${'A'.repeat(40)}`)).toMatchObject({ ok: false });
  });

  it('refuses a tap where a typed code belongs', () => {
    const step = stepByKey(redeemCodeWizard, 'code');
    if (step === null) throw new Error('no step code');
    expect(apply(step, { kind: 'callback', action: 'code', value: 'x' }, {})).toMatchObject({
      ok: false,
    });
  });

  /** «رد کردن» would submit an empty form; «انصراف» is what leaving looks like. */
  it('cannot be skipped', () => {
    const step = stepByKey(redeemCodeWizard, 'code');
    if (step === null) throw new Error('no step code');
    expect(apply(step, { kind: 'callback', action: 'skip', value: '' }, {})).toMatchObject({
      ok: false,
    });
  });
});

describe('the shape of the form', () => {
  /**
   * One step, so answering it ends the wizard — which is what lets `BotService`
   * treat the summary as the submission rather than asking somebody to confirm
   * eight characters still on their screen.
   */
  it('has exactly one step, and nothing after it', () => {
    expect(redeemCodeWizard.steps).toHaveLength(1);
    expect(nextStep(redeemCodeWizard, 'code', {})).toBeNull();
  });

  it('starts at the code step whether or not a kind was seeded', () => {
    expect(firstStep(redeemCodeWizard, {})?.key).toBe('code');
    expect(firstStep(redeemCodeWizard, { codeKind: 'referral' })?.key).toBe('code');
  });

  /** The prompt is the only thing the seeded kind changes. */
  it('asks for the right code', () => {
    const step = stepByKey(redeemCodeWizard, 'code');
    if (step === null) throw new Error('no step code');
    expect(step.prompt({ codeKind: 'gift' })).toContain('هدیه');
    expect(step.prompt({ codeKind: 'referral' })).toContain('معرفی');
  });
});

describe('isCodeKind', () => {
  it('accepts the two kinds and nothing else', () => {
    expect(isCodeKind('gift')).toBe(true);
    expect(isCodeKind('referral')).toBe(true);
    expect(isCodeKind('coupon')).toBe(false);
    expect(isCodeKind(undefined)).toBe(false);
  });
});
