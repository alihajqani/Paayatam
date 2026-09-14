import { describe, expect, it } from 'vitest';
import { insufficientCoinsNotice } from './notices';
import { TEMPLATES, render } from './templates';

/**
 * Running out of coins, answered with the ways to get more (plan 11, review M6).
 *
 * The refusal said «/referral و /gift» — two commands to type, at exactly the
 * moment the coin-purchase screen (plan 02) was built for. It now arrives with
 * buttons, so the sentence must stop telling anybody to type.
 */
describe('the coins-short message', () => {
  it('renders the sentence escaped and keeps the buttons it was given', () => {
    const keyboard = JSON.stringify([[{ text: '🎁 کد هدیه دارم', callbackData: 'cd:gift:x' }]]);
    const message = render(TEMPLATES.BOT_COINS_SHORT, { text: 'a < b', keyboard });
    expect(message?.text).toBe('a &lt; b');
    expect(message?.keyboard?.flat().map((b) => b.callbackData)).toEqual(['cd:gift:x']);
  });

  it('points at the buttons, not at commands, when it has them', () => {
    const text = insufficientCoinsNotice('ثبت فعالیت', 25, 3, true);
    expect(text).not.toContain('/gift');
    expect(text).not.toContain('/referral');
    expect(text).toContain('دکمه');
    expect(text).toContain('۲۵ سکه');
  });
});
