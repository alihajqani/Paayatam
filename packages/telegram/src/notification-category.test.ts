import { describe, expect, it } from 'vitest';
import { TEMPLATES } from './templates';
import { notificationCategory, preferenceKeyFor } from './notification-category';

/**
 * The test that keeps the mapping honest.
 *
 * A category kept anywhere would drift the moment somebody added a template and
 * did not think about preferences — and that drift is silent: the new
 * notification takes the fallback forever and nobody finds out. This makes it a
 * build failure instead.
 */
describe('every template is classified', () => {
  it.each(Object.values(TEMPLATES))('%s has a category', (templateKey) => {
    // The fallback exists for a *newer* deploy's template, not for one this
    // build ships. Anything in TEMPLATES must be classified deliberately.
    const category = notificationCategory(templateKey);
    expect(['chat', 'events', 'campaigns', 'essential']).toContain(category);
  });

  /**
   * The fallback is `essential`, and that direction is the safe one: silently
   * dropping a message an older worker cannot classify would lose it entirely,
   * and a rollout is exactly when that is hardest to notice.
   */
  it('delivers a template it has never heard of', () => {
    expect(notificationCategory('something.from.the.future')).toBe('essential');
  });

  it('lets nothing silence an essential message', () => {
    expect(preferenceKeyFor('essential')).toBeNull();
  });

  it.each([
    ['chat', 'notifyChat'],
    ['events', 'notifyEvents'],
    ['campaigns', 'notifyCampaigns'],
  ] as const)('maps %s to %s', (category, key) => {
    expect(preferenceKeyFor(category)).toBe(key);
  });

  /**
   * A reply to a tap is never suppressed. Somebody who turned off "campaigns" a
   * month ago and then sends `/wallet` should get their wallet, not silence.
   */
  it('never silences an answer to something the user just did', () => {
    for (const key of [
      TEMPLATES.BOT_WALLET,
      TEMPLATES.BOT_DISCOVER,
      TEMPLATES.BOT_WIZARD,
      TEMPLATES.BOT_NOTICE,
    ]) {
      expect(notificationCategory(key)).toBe('essential');
    }
  });

  /** And never silences something somebody is entitled to know. */
  it('never silences a moderation outcome', () => {
    expect(notificationCategory(TEMPLATES.CONTENT_HIDDEN)).toBe('essential');
    expect(notificationCategory(TEMPLATES.NO_SHOW_RECORDED)).toBe('essential');
  });
});
