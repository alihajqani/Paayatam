import { describe, expect, it } from 'vitest';
import { escapeHtml, toPersianDigits } from './escape';
import { TEMPLATES, render } from './templates';

/**
 * T9's unit test: "bot HTML templates pass every user value through a
 * unit-tested `escapeHtml()`".
 *
 * The threat is concrete. Telegram's `parse_mode: 'HTML'` is what gives the bot
 * bold text and links, and it is also what turns an event title into markup. A
 * host who names their event `<a href="http://evil">tap here</a>` would otherwise
 * have the platform send that link, in a message the recipient has every reason to
 * trust.
 */
describe('escapeHtml', () => {
  it.each([
    ['<b>bold</b>', '&lt;b&gt;bold&lt;/b&gt;'],
    ['a & b', 'a &amp; b'],
    ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['5 > 3', '5 &gt; 3'],
  ])('escapes %o', (input, expected) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  /** Ampersand first, or the escapes escape each other into nonsense. */
  it('does not double-escape its own output', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves Persian text alone', () => {
    expect(escapeHtml('شب بازی رومیزی')).toBe('شب بازی رومیزی');
  });
});

describe('toPersianDigits', () => {
  it('converts digits and leaves everything else', () => {
    expect(toPersianDigits(2026)).toBe('۲۰۲۶');
    expect(toPersianDigits('۷ روز')).toBe('۷ روز');
    expect(toPersianDigits('3 روز')).toBe('۳ روز');
  });
});

/**
 * The property that matters more than any single template: **no user-authored
 * value reaches a message body as markup**.
 *
 * Asserted by feeding a tag into every interpolated field of every template and
 * checking that no template emits a tag it did not write itself. The escaped text
 * still *reads* as `<img src=x onerror=…>` — that is the point, the recipient sees
 * what was written rather than having it rendered — so the assertion is about the
 * angle brackets, not about the words between them.
 */
describe('no template emits injected markup', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>';
  const FIELDS = {
    eventTitle: HOSTILE,
    senderAlias: HOSTILE,
    text: HOSTILE,
    participantPublicId: HOSTILE,
    chatPublicId: HOSTILE,
    daysLeft: 7,
  };

  it.each(Object.values(TEMPLATES))('%s', (templateKey) => {
    const message = render(templateKey, FIELDS);

    expect(message).not.toBeNull();
    expect(message?.text).not.toContain('<img');
    // Every tag in the output is one the template itself wrote. `<b>` is the only
    // markup any of them uses.
    const tags = message?.text.match(/<[^>]*>/g) ?? [];
    expect(tags.every((tag) => tag === '<b>' || tag === '</b>')).toBe(true);
  });

  /** And the escaped form really is present where a value was interpolated. */
  it('escapes the value rather than dropping it', () => {
    const message = render(TEMPLATES.PARTICIPATION_ACCEPTED, FIELDS);
    expect(message?.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

/**
 * A notification queued by a newer deploy and processed by an older one.
 *
 * Returning null rather than throwing is what keeps a rollout from stalling the
 * whole queue behind one unknown template.
 */
describe('an unknown template', () => {
  it('renders nothing rather than throwing', () => {
    expect(render('something.from.the.future', {})).toBeNull();
  });
});

/**
 * The relayed chat message is the one template where a mistake breaks the
 * product's central promise, so it gets its own assertion.
 */
describe('the chat relay template', () => {
  it('carries the alias and the text, and nothing else', () => {
    const message = render(TEMPLATES.CHAT_MESSAGE, {
      senderAlias: 'میهمان ۱',
      text: 'ساعت هفت جلوی کافه',
      chatPublicId: 'abc',
      // Fields a caller might wrongly include. The template reads neither.
      telegramUserId: '573914882',
      username: 'leaky_handle',
    });

    expect(message?.text).toContain('میهمان ۱');
    expect(message?.text).toContain('ساعت هفت جلوی کافه');
    expect(message?.text).not.toContain('573914882');
    expect(message?.text).not.toContain('leaky_handle');
  });
});
