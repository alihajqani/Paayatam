import { describe, expect, it } from 'vitest';
import {
  apply,
  firstStep,
  nextStep,
  previousStep,
  progressOf,
  stepByKey,
  type WizardDefinition,
  type WizardStep,
} from './wizard';

interface Form {
  a?: string;
  b?: string;
  c?: string;
  gate?: boolean;
}

function step(key: string, over: Partial<WizardStep<Form>> = {}): WizardStep<Form> {
  return {
    key,
    ui: 'text',
    prompt: () => key,
    accept: (input) => ({ ok: true, patch: { [key]: input.value } as Partial<Form> }),
    ...over,
  };
}

const definition: WizardDefinition<Form> = {
  steps: [
    step('a'),
    step('b', { when: (form) => form.gate === true }),
    step('c', { optional: true }),
  ],
  empty: () => ({}),
};

describe('stepByKey', () => {
  it('finds a step', () => {
    expect(stepByKey(definition, 'b')?.key).toBe('b');
  });

  /** A key from an older build, or a tampered one. */
  it('is null for a key it does not have', () => {
    expect(stepByKey(definition, 'zzz')).toBeNull();
  });
});

describe('nextStep', () => {
  it('skips a step whose condition does not hold', () => {
    expect(nextStep(definition, 'a', {})?.key).toBe('c');
  });

  it('includes it once the condition holds', () => {
    expect(nextStep(definition, 'a', { gate: true })?.key).toBe('b');
  });

  it('is null at the end, which is the confirmation screen', () => {
    expect(nextStep(definition, 'c', {})).toBeNull();
  });

  /**
   * Re-evaluated on every move rather than decided once: answering «رایگان»
   * after «مبلغ مشخص» has to remove the amount step even though it was already
   * visited. A chain of successors gets this wrong.
   */
  it('re-evaluates conditions rather than remembering a path', () => {
    expect(nextStep(definition, 'a', { gate: true })?.key).toBe('b');
    expect(nextStep(definition, 'a', { gate: false })?.key).toBe('c');
  });
});

describe('previousStep', () => {
  it('walks back over a skipped step', () => {
    expect(previousStep(definition, 'c', {})?.key).toBe('a');
  });

  it('stops at the first step', () => {
    expect(previousStep(definition, 'a', {})).toBeNull();
  });
});

describe('firstStep', () => {
  it('is the first applicable one', () => {
    expect(firstStep(definition, {})?.key).toBe('a');
  });
});

describe('progressOf', () => {
  /** «گام ۱ از ۲» must count the steps this form will actually be asked. */
  it('counts only applicable steps', () => {
    expect(progressOf(definition, 'a', {})).toEqual({ position: 1, total: 2 });
    expect(progressOf(definition, 'a', { gate: true })).toEqual({ position: 1, total: 3 });
    expect(progressOf(definition, 'c', { gate: true })).toEqual({ position: 3, total: 3 });
  });
});

describe('apply', () => {
  it('passes an answer to the step', () => {
    const result = apply(step('a'), { kind: 'text', value: 'x' }, {});

    expect(result).toEqual({ ok: true, patch: { a: 'x' } });
  });

  it('lets an optional step be skipped, changing nothing', () => {
    const result = apply(
      step('c', { optional: true }),
      { kind: 'callback', action: 'skip', value: '' },
      {},
    );

    expect(result).toEqual({ ok: true, patch: {} });
  });

  /** «رد کردن» is not rendered on a required step, but the button is untrusted. */
  it('refuses to skip a required step', () => {
    const result = apply(step('a'), { kind: 'callback', action: 'skip', value: '' }, {});

    expect(result.ok).toBe(false);
  });
});
