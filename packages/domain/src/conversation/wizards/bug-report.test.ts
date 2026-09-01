import { describe, expect, it } from 'vitest';
import { bugReportWizard, MAX_SCREENSHOTS, type BugReportForm } from './bug-report';
import { stepByKey } from '../wizard';
import type { WizardInput } from '../wizard';

function accept(
  key: string,
  value: string,
  form: BugReportForm = {},
  kind: WizardInput['kind'] = 'text',
) {
  const step = stepByKey(bugReportWizard, key);
  if (step === null) throw new Error(`no step ${key}`);
  return step.accept({ kind, value }, form);
}

/**
 * The one form in the product that accepts a photo.
 *
 * Everything else answers an image with «این نوع پیام پشتیبانی نمی‌شود», which is
 * right for the chat relay — a forwarded image is a payload nothing can moderate
 * or encrypt — and exactly wrong here, where the screenshot *is* the report.
 */
describe('the description', () => {
  it('is taken, trimmed', () => {
    expect(accept('what', '  دکمه پیوستن کار نمی‌کند  ')).toEqual({
      ok: true,
      patch: { description: 'دکمه پیوستن کار نمی‌کند' },
    });
  });

  it('refuses a sentence too short to act on', () => {
    expect(accept('what', 'خرابه').ok).toBe(false);
  });

  it('refuses one past the bound the column enforces', () => {
    expect(accept('what', 'ا'.repeat(2001)).ok).toBe(false);
  });

  /**
   * The likeliest mis-step, and the reason it is not answered with the generic
   * media refusal: somebody has the screenshot in hand and sends it first.
   * «این نوع پیام پشتیبانی نمی‌شود» would read as "screenshots are not accepted",
   * which is the opposite of what this form is for.
   */
  it('tells somebody who sends the screenshot first which half comes first', () => {
    const result = accept('what', 'file-1', {}, 'photo');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('تصویر');
  });
});

describe('the screenshots', () => {
  it('takes a file id', () => {
    expect(accept('shots', 'file-1', {}, 'photo')).toEqual({
      ok: true,
      patch: { screenshotFileIds: ['file-1'] },
    });
  });

  it('appends rather than replacing, so several can be sent in a row', () => {
    expect(accept('shots', 'file-2', { screenshotFileIds: ['file-1'] }, 'photo')).toEqual({
      ok: true,
      patch: { screenshotFileIds: ['file-1', 'file-2'] },
    });
  });

  /**
   * Telegram gives one bot the same `file_id` for the same file, so a resent
   * screenshot is one picture — not two for a moderator to open.
   */
  it('ignores a repeat of one it already has', () => {
    expect(accept('shots', 'file-1', { screenshotFileIds: ['file-1'] }, 'photo')).toEqual({
      ok: true,
      patch: { screenshotFileIds: ['file-1'] },
    });
  });

  it('refuses past the cap the column also enforces', () => {
    const full = Array.from({ length: MAX_SCREENSHOTS }, (_, index) => `file-${String(index)}`);
    expect(accept('shots', 'one-more', { screenshotFileIds: full }, 'photo').ok).toBe(false);
  });

  it('refuses text, and says what it wanted', () => {
    const result = accept('shots', 'اینم عکسش', { screenshotFileIds: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('تصویر');
  });

  /** «رد کردن» has to file the report, so the step cannot be required. */
  it('is optional', () => {
    expect(stepByKey(bugReportWizard, 'shots')?.optional).toBe(true);
  });

  /**
   * The photo step is **last**, so every picture lands back on the summary with
   * the count one higher rather than advancing anywhere. That is what makes
   * "send five screenshots" five messages and one growing summary.
   */
  it('is the last step, so a photo returns to the summary', () => {
    expect(bugReportWizard.steps.at(-1)?.key).toBe('shots');
  });
});

describe('the empty form', () => {
  it('starts with no screenshots rather than an absent key', () => {
    expect(bugReportWizard.empty()).toEqual({ screenshotFileIds: [] });
  });
});
