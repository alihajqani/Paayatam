import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

/**
 * Three reports hide an *activity*, and only open a case for anything else (review M4).
 *
 * `ReportService.escalate` emits the same event for a reported user and a
 * reported review, and nothing is hidden for either — so «فعالیت شما پنهان شد
 * … کسی نمی‌تواند به آن بپیوندد» told a reported host something false about an
 * activity nobody had touched.
 */
describe('content hidden after reports', () => {
  it('keeps the activity sentence for an activity', () => {
    const text = String(render(TEMPLATES.CONTENT_HIDDEN, { subjectType: 'EVENT' })?.text);
    expect(text).toContain('فعالیت شما');
    expect(text).toContain('پنهان');
  });

  it('does not tell a reported person that an activity was hidden', () => {
    const text = String(render(TEMPLATES.CONTENT_HIDDEN, { subjectType: 'USER' })?.text);
    expect(text).not.toContain('فعالیت');
    expect(text).not.toContain('پنهان');
    expect(text).toContain('حساب');
  });

  it('names a review as a review', () => {
    const text = String(render(TEMPLATES.CONTENT_HIDDEN, { subjectType: 'REVIEW' })?.text);
    expect(text).not.toContain('فعالیت');
    expect(text).not.toContain('پنهان');
    expect(text).toContain('نظر');
  });

  /** Every row written before this change is about an event, but none says so. */
  it('reads an unlabelled payload as the activity it always was', () => {
    expect(render(TEMPLATES.CONTENT_HIDDEN, {})?.text).toContain('فعالیت شما');
  });
});
