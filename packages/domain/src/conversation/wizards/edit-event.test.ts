import { describe, expect, it } from 'vitest';
import { apply, nextStep, stepByKey } from '../wizard';
import { createEventWizard } from './create-event';
import { editEventWizard, eventChoice } from './edit-event';

const UUID = '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f';

describe('editEventWizard', () => {
  it('picks an event first', () => {
    expect(editEventWizard.steps[0]?.key).toBe('pick');
  });

  it('accepts a public id and refuses anything else', () => {
    const pick = stepByKey(editEventWizard, 'pick');

    expect(apply(pick!, { kind: 'callback', value: UUID }, {})).toEqual({
      ok: true,
      patch: { eventPublicId: UUID },
    });
    expect(apply(pick!, { kind: 'callback', value: 'nope' }, {}).ok).toBe(false);
  });

  /**
   * The point of the file: the sixteen validators are the create wizard's, not a
   * second copy. When its rules change they change here, because there is
   * nothing here to forget to update.
   */
  it('reuses the create wizard’s steps rather than redefining them', () => {
    const created = createEventWizard.steps.map((step) => step.key);
    const edited = editEventWizard.steps.map((step) => step.key);

    expect(edited).toEqual(['pick', ...created]);
  });

  it('makes every editable step skippable', () => {
    for (const step of editEventWizard.steps.slice(1)) {
      expect(step.optional).toBe(true);
      expect(apply(step, { kind: 'callback', action: 'skip', value: '' }, {})).toEqual({
        ok: true,
        patch: {},
      });
    }
  });

  /**
   * `optional` decides whether a reached step can be left unanswered; `when`
   * decides whether it is reached at all. Making everything skippable must not
   * have flattened the conditionals.
   */
  it('keeps the cost-amount condition', () => {
    expect(nextStep(editEventWizard, 'cost', { costType: 'FIXED' })?.key).toBe('amount');
    expect(nextStep(editEventWizard, 'cost', { costType: 'FREE' })).toBeNull();
  });

  it('keeps the custom-label condition', () => {
    expect(nextStep(editEventWizard, 'cat', { categoryAllowsLabel: true })?.key).toBe('catlabel');
    expect(nextStep(editEventWizard, 'cat', { categoryAllowsLabel: false })?.key).toBe('prov');
  });

  /** Validation is still the create wizard's. */
  it('still refuses a title that is too short', () => {
    const title = stepByKey(editEventWizard, 'title');

    expect(apply(title!, { kind: 'text', value: 'ab' }, {}).ok).toBe(false);
  });
});

describe('eventChoice', () => {
  it('carries the public id', () => {
    expect(eventChoice(UUID, 'کوهنوردی').value).toBe(UUID);
  });

  /** A long label disappears in the middle on a phone; truncation is honest. */
  it('truncates a long title', () => {
    const label = eventChoice(UUID, 'ا'.repeat(60)).label;

    expect(label.length).toBeLessThanOrEqual(30);
    expect(label.endsWith('…')).toBe(true);
  });

  it('leaves a short title alone', () => {
    expect(eventChoice(UUID, 'کوهنوردی').label).toBe('کوهنوردی');
  });
});
