import { describe, expect, it } from 'vitest';
import { insufficientCoinsNotice } from './notices';

/**
 * `BOT_NOTICE` escapes its body, so a notice that emits markup shows the markup.
 *
 * This is the assertion, and it is deliberately about the *characters* rather
 * than about one tag: `<b>` was the one that shipped, and any of `<i>`, `<a>` or
 * a bare `&` would fail in exactly the same visible way.
 */
describe('a notice body', () => {
  it('carries no markup for the escaper to turn into text', () => {
    const text = insufficientCoinsNotice('ثبت فعالیت', 15, 0);
    expect(text).not.toMatch(/[<>&]/);
  });

  it('names both the price and the balance, in Persian digits', () => {
    const text = insufficientCoinsNotice('ثبت فعالیت', 15, 3);
    expect(text).toContain('۱۵ سکه');
    expect(text).toContain('۳ سکه');
    expect(text).toContain('ثبت فعالیت');
  });
});
