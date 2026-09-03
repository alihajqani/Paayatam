import { describe, expect, it } from 'vitest';
import { formatDirectMessage } from './direct';
import { TEMPLATES, render } from './templates';

/**
 * The message a recipient opens, and the button that answers it (v0.8.0).
 *
 * The rendering was never the problem. `BOT_NOTICE` was: it drops any keyboard in
 * its payload and returns the menu opener, so the «پاسخ» row the bot builds on a
 * «مشاهده» tap was assembled and then discarded, in both directions. These tests
 * hold the passthrough that fixed it, because the failure is invisible from the
 * call site — the button is built correctly and simply never arrives.
 */
describe('a direct message, opened', () => {
  it('names the sender and the activity, and warns about contact details', () => {
    const text = formatDirectMessage({
      senderDisplayName: 'علی رضایی',
      eventTitle: 'سفر شمال',
      body: 'سلام، ماشین دارید؟',
      createdAt: new Date('2026-09-03T10:00:00Z'),
    });

    expect(text).toContain('سفر شمال');
    expect(text).toContain('علی رضایی');
    expect(text).toContain('سلام، ماشین دارید؟');
    expect(text).toContain('مسئولیت');
  });

  it('escapes a body that is trying to be markup', () => {
    const text = formatDirectMessage({
      senderDisplayName: '<b>مهاجم</b>',
      eventTitle: '<i>عنوان</i>',
      body: '<a href="http://example.com">اینجا</a>',
      createdAt: new Date('2026-09-03T10:00:00Z'),
    });

    expect(text).not.toContain('<a href');
    expect(text).not.toContain('<b>مهاجم</b>');
    expect(text).toContain('&lt;');
  });
});

describe('the direct-message screen', () => {
  const keyboard = JSON.stringify([[{ text: '✍️ پاسخ به این پیام', callbackData: 'dm:reply:x' }]]);

  it('carries the reply button through to the message', () => {
    const message = render(TEMPLATES.BOT_DIRECT_MESSAGE, { text: 'سلام', keyboard });

    expect(message?.text).toBe('سلام');
    expect(message?.keyboard?.[0]?.[0]?.text).toBe('✍️ پاسخ به این پیام');
  });

  it('is what `BOT_NOTICE` would have thrown away', () => {
    // The regression, stated as the two renderers disagreeing: the same payload
    // through `BOT_NOTICE` comes back with the menu opener and no reply button.
    const notice = render(TEMPLATES.BOT_NOTICE, { text: 'سلام', keyboard });

    expect(notice?.keyboard?.[0]?.[0]?.text).not.toBe('✍️ پاسخ به این پیام');
  });

  it('falls back to the menu when there is nothing to answer', () => {
    // A sender reading their own message back: no reply button, and a message
    // with no way forward gets the same opener every other one-line answer has.
    const message = render(TEMPLATES.BOT_DIRECT_MESSAGE, { text: 'سلام' });

    expect(message?.text).toBe('سلام');
    expect(message?.keyboard?.length).toBeGreaterThan(0);
  });
});
