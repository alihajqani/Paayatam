import { describe, expect, it } from 'vitest';
import { parseChatCallback } from './callback-data';
import { hostDecisionKeyboard, openAppButton } from './keyboards';

const CHAT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BOT = 'payetam_bot';

/**
 * The host's two decisions, and the only keyboard left under the `chat:` prefix.
 *
 * The namespace outlived the product it was named for: v0.8.0 removed the
 * anonymous conversation, and `chat:close`, `chat:share` and `chat:shareyes`
 * went with it. `accept` and `reject` stay, because they never carried a chat id
 * — they carry a **participant** one, and they are how a host answers a request
 * from the notification rather than from a screen.
 *
 * The prefix is deliberately not renamed. Every host decision button already
 * sitting in somebody's Telegram history encodes `chat:accept:<id>`, and a
 * rename would turn each of them into «این دکمه دیگر کار نمی‌کند» on a request
 * that expires in twenty-four hours.
 */
describe('the host decision keyboard', () => {
  it('puts both decisions one tap away, and only those', () => {
    const rows = hostDecisionKeyboard(CHAT_ID);

    expect(rows).toHaveLength(1);
    expect(parseChatCallback(rows[0]?.[0]?.callbackData ?? '')?.action).toBe('accept');
    expect(parseChatCallback(rows[0]?.[1]?.callbackData ?? '')?.action).toBe('reject');
  });

  /**
   * The open-app button is gone from every keyboard the bot sends. It was under
   * almost every message, which is what made it noise — and it is what kept the
   * persistent menu off them, since `reply_markup` holds one thing.
   */
  it('carries no link out of Telegram', () => {
    for (const button of hostDecisionKeyboard(CHAT_ID).flat()) {
      expect(button.url).toBeUndefined();
    }
  });
});

describe('the open-app button', () => {
  it('carries a deep link Telegram will accept', () => {
    expect(openAppButton('x', BOT, `event_${CHAT_ID}`).url).toBe(
      `https://t.me/${BOT}?startapp=event_${CHAT_ID}`,
    );
  });

  /**
   * A payload outside Telegram's `[A-Za-z0-9_-]` charset degrades to the bot's own
   * link rather than being sent broken: a button that lands somewhere wrong is
   * worse than one that only opens the app.
   */
  it('falls back to the bot when the payload will not fit', () => {
    expect(openAppButton('x', BOT, 'چیزی که نمی‌شود').url).toBe(`https://t.me/${BOT}`);
    expect(openAppButton('x', BOT).url).toBe(`https://t.me/${BOT}`);
  });

  /** A button with both a URL and callback data is a Telegram 400. */
  it('never carries both a url and callback data', () => {
    const button = openAppButton('x', BOT, `event_${CHAT_ID}`);

    expect(button.callbackData).toBeUndefined();
  });
});
