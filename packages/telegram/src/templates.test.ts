import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

/**
 * The two templates v0.8.1 changed, and one it made reachable.
 *
 * Rendering is otherwise covered where the thing being rendered is — `channel`,
 * `direct`, `digest` and the rest each have their own suite. What is here is the
 * copy that moved, tested for the property that moved it.
 */

describe('a rejected request', () => {
  const payload = { eventTitle: 'قهوه و بازی', participantUserPublicId: 'u1' };

  /**
   * Asking costs five coins and a rejection now returns them (v0.8.1). Saying so
   * is not a courtesy: the guest watched a number go down when they asked, and a
   * refund nobody mentions is indistinguishable from no refund.
   */
  it('says how many coins came back', () => {
    const message = render(TEMPLATES.PARTICIPATION_REJECTED, { ...payload, coinsRefunded: 5 });
    expect(message?.text).toContain('۵ سکه');
    expect(message?.text).toContain('بازگشت');
  });

  /**
   * Joining is free in any deployment that has not set a price, and «۰ سکه
   * بازگشت» reads as a bug rather than as a free action.
   */
  it('says nothing about coins when nothing moved', () => {
    for (const coinsRefunded of [0, undefined]) {
      const message = render(TEMPLATES.PARTICIPATION_REJECTED, { ...payload, coinsRefunded });
      expect(message?.text).not.toContain('سکه');
      expect(message?.text).toContain('پذیرفته نشد');
    }
  });

  /** A payload from an older deploy carries no such key, and must still render. */
  it('renders a payload written before the field existed', () => {
    expect(render(TEMPLATES.PARTICIPATION_REJECTED, payload)?.text).toContain('پذیرفته نشد');
  });
});

/**
 * A request that ran out of time (v0.8.1).
 *
 * There was no message for this at all until v0.8.1 — the row went to EXPIRED
 * and nobody was told. It became necessary when the coins started coming back:
 * a refund the payer never hears about arrives as an unexplained balance change.
 */
describe('an expired request', () => {
  const payload = { eventTitle: 'قهوه و بازی', participantUserPublicId: 'u1' };

  it('says the host never answered, not that the guest was refused', () => {
    const text = String(render(TEMPLATES.PARTICIPATION_EXPIRED, payload)?.text);

    expect(text).toContain('پاسخی نداد');
    // «رد شد» would attribute a decision to a host who made none.
    expect(text).not.toContain('رد شد');
  });

  it('names the coins that came back', () => {
    const message = render(TEMPLATES.PARTICIPATION_EXPIRED, { ...payload, coinsRefunded: 5 });
    expect(message?.text).toContain('۵ سکه');
    expect(message?.text).toContain('بازگشت');
  });

  /** Joining is free until an operator prices it, and «۰ سکه» reads as a bug. */
  it('says nothing about coins when nothing moved', () => {
    for (const coinsRefunded of [0, undefined]) {
      const message = render(TEMPLATES.PARTICIPATION_EXPIRED, { ...payload, coinsRefunded });
      expect(message?.text).not.toContain('سکه');
    }
  });
});

/**
 * The profile card names the interests (v0.8.1).
 *
 * A screen that did not mention them could not tell you they were empty — which
 * they were, for every account the bot onboarded, because no surface wrote them.
 */
describe('the profile card', () => {
  const payload = { displayName: 'علی', cityName: 'تهران', trustScore: 50 };

  it('lists them when there are some', () => {
    const message = render(TEMPLATES.BOT_PROFILE, {
      ...payload,
      interests: 'کوه‌نوردی، بازی رومیزی',
    });
    expect(message?.text).toContain('کوه‌نوردی، بازی رومیزی');
  });

  /** Empty is a sentence, not a blank field: the blank reads as a broken screen. */
  it('says so plainly when there are none', () => {
    const message = render(TEMPLATES.BOT_PROFILE, { ...payload, interests: '' });
    expect(message?.text).toContain('هنوز چیزی انتخاب نکرده‌اید');
  });

  it('renders a payload written before the field existed', () => {
    expect(render(TEMPLATES.BOT_PROFILE, payload)?.text).toContain('هنوز چیزی انتخاب نکرده‌اید');
  });

  /** A display name is a stranger's own words under `parse_mode: 'HTML'` (T9). */
  it('escapes the display name', () => {
    const message = render(TEMPLATES.BOT_PROFILE, {
      ...payload,
      displayName: '<b>علی</b>',
      interests: '',
    });
    expect(message?.text).toContain('&lt;b&gt;');
  });
});

/**
 * The reminder that had copy, a category and a renderer since M12 and no
 * producer at all until v0.8.1.
 */
describe('the review window opening', () => {
  it('names the activity and how long is left', () => {
    const message = render(TEMPLATES.REVIEW_WINDOW_OPEN, {
      eventTitle: 'قهوه و بازی',
      daysLeft: 7,
    });

    expect(message?.text).toContain('قهوه و بازی');
    expect(message?.text).toContain('۷');
  });
});
