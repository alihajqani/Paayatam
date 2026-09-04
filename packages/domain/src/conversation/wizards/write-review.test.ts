import { describe, expect, it } from 'vitest';
import { apply, nextStep, progressOf, stepByKey } from '../wizard';
import {
  MAX_REVIEW_TAGS,
  reviewTagLabel,
  writeReviewWizard,
  type WriteReviewForm,
} from './write-review';

function accept(
  key: string,
  value: string,
  form: WriteReviewForm = {},
  kind: 'text' | 'callback' = 'callback',
) {
  const step = stepByKey(writeReviewWizard, key);
  if (step === null) throw new Error(`no step ${key}`);
  return apply(step, { kind, value }, form);
}

/**
 * Several tags, not one (v0.8.1).
 *
 * The contract has allowed five since M12 and this wizard asked for exactly one,
 * on the argument that a step accumulating into an array would have to loop and
 * that «a loop is the one shape `progressOf` cannot count». The shape was right
 * and the conclusion was wrong: a `multi` step loops and is still one step.
 */
describe('review tags', () => {
  it('adds a tap to the selection', () => {
    expect(accept('tag', 'PUNCTUAL')).toEqual({ ok: true, patch: { tags: ['PUNCTUAL'] } });
  });

  it('keeps what was already ticked', () => {
    expect(accept('tag', 'FRIENDLY', { tags: ['PUNCTUAL'] })).toEqual({
      ok: true,
      patch: { tags: ['PUNCTUAL', 'FRIENDLY'] },
    });
  });

  /** The same button removes it — one control for both directions. */
  it('removes one that is already ticked', () => {
    expect(accept('tag', 'PUNCTUAL', { tags: ['PUNCTUAL', 'FRIENDLY'] })).toEqual({
      ok: true,
      patch: { tags: ['FRIENDLY'] },
    });
  });

  /**
   * The contract caps `tags` at five, and a refusal from Zod at the service
   * boundary reaches the user as «اطلاعات نامعتبر» with no field named. The step
   * refuses the sixth itself, in a sentence about tags.
   */
  it('refuses the sixth, and says how to make room', () => {
    const full: WriteReviewForm = {
      tags: ['PUNCTUAL', 'FRIENDLY', 'GOOD_CONVERSATION', 'WELL_ORGANISED', 'AS_DESCRIBED'],
    };
    expect(full.tags).toHaveLength(MAX_REVIEW_TAGS);

    const result = accept('tag', 'WOULD_MEET_AGAIN', full);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('۵');
  });

  /** Removing still works when the selection is full — otherwise it is a dead end. */
  it('still lets one be removed when five are ticked', () => {
    const full: WriteReviewForm = {
      tags: ['PUNCTUAL', 'FRIENDLY', 'GOOD_CONVERSATION', 'WELL_ORGANISED', 'AS_DESCRIBED'],
    };
    expect(accept('tag', 'PUNCTUAL', full).ok).toBe(true);
  });

  it('refuses a value that is not one of the offered tags', () => {
    expect(accept('tag', 'EXCELLENT').ok).toBe(false);
  });

  it('is a multi-select, and reports what is ticked', () => {
    const step = stepByKey(writeReviewWizard, 'tag');
    expect(step?.ui).toBe('multi');
    expect(step?.selectedOf?.({ tags: ['LATE'] })).toEqual(['LATE']);
    expect(step?.selectedOf?.({})).toEqual([]);
  });

  /**
   * The step count does not move however many times the keyboard is redrawn.
   *
   * This is the property the old "one tag" argument doubted, and it is what
   * makes a multi-select expressible here at all: the loop is inside one step,
   * so «گام ۱ از ۲» is true before the first tap and after the fifth.
   */
  it('counts as one step whatever is ticked', () => {
    expect(progressOf(writeReviewWizard, 'tag', {})).toEqual({ position: 1, total: 2 });
    expect(progressOf(writeReviewWizard, 'tag', { tags: ['LATE', 'PUNCTUAL'] })).toEqual({
      position: 1,
      total: 2,
    });
  });
});

/**
 * The tags come first, and that is a decision about who fills them in.
 *
 * Most reviewers write no comment: tags are two taps and a paragraph is a
 * paragraph. Asking for the writing first would put the part almost nobody
 * completes in front of the part almost everybody would.
 */
describe('the order of the two steps', () => {
  it('asks for the tags before the comment', () => {
    expect(writeReviewWizard.steps.map((step) => step.key)).toEqual(['tag', 'comment']);
  });

  it('offers the tags even to somebody who will write nothing', () => {
    expect(nextStep(writeReviewWizard, 'tag', {})?.key).toBe('comment');
    // Both are optional: a rating alone is a complete review, and the wizard is
    // the amendment rather than the review itself.
    expect(writeReviewWizard.steps.every((step) => step.optional === true)).toBe(true);
  });

  it('lets the comment be skipped with the tags kept', () => {
    const step = stepByKey(writeReviewWizard, 'comment');
    expect(
      apply(step!, { kind: 'callback', action: 'skip', value: '' }, { tags: ['PUNCTUAL'] }),
    ).toEqual({ ok: true, patch: {} });
  });
});

describe('the comment', () => {
  it('accepts typed text and trims it', () => {
    expect(accept('comment', '  عالی بود  ', {}, 'text')).toEqual({
      ok: true,
      patch: { comment: 'عالی بود' },
    });
  });

  it('refuses one over the contract bound', () => {
    expect(accept('comment', 'ا'.repeat(501), {}, 'text').ok).toBe(false);
  });

  it('refuses a tap where it wanted words', () => {
    expect(accept('comment', 'PUNCTUAL').ok).toBe(false);
  });
});

describe('reviewTagLabel', () => {
  it('renders a known tag in Persian', () => {
    expect(reviewTagLabel('PUNCTUAL')).toContain('سر وقت');
  });

  /** A tag written by a newer deploy renders as itself rather than vanishing. */
  it('falls back to the raw value', () => {
    expect(reviewTagLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
