import { describe, expect, it } from 'vitest';
import { parseChatCallback } from './callback-data';
import { chatKeyboard, hostDecisionKeyboard, openAppButton } from './keyboards';

const CHAT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BOT = 'payetam_bot';

/**
 * The keyboards, and one property that is easy to lose: **contact sharing is only
 * offered on an accepted conversation** (report 6).
 *
 * `ChatService.shareContact` is OPEN-only — before acceptance there is no meeting
 * to arrange, and an anonymous stage that can be switched off on request is not an
 * anonymous stage (ADR-0009). So a share button under an anonymous chat is a
 * control the product already knows will answer «گفتگو باز نیست», and the payload
 * flag that gates it defaults to false: a message queued by an older deploy
 * carries no `chatOpen`, and the safe reading of "we do not know" is to leave the
 * button off.
 */
describe('the chat keyboard', () => {
  it('offers reply and close on every live conversation', () => {
    const rows = chatKeyboard(CHAT_ID, BOT, `chats/${CHAT_ID}`);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]?.url).toContain(BOT);
    expect(parseChatCallback(rows[0]?.[1]?.callbackData ?? '')).toEqual({
      action: 'close',
      id: CHAT_ID,
    });
  });

  it('offers contact sharing once the conversation is open', () => {
    const rows = chatKeyboard(CHAT_ID, BOT, `chats/${CHAT_ID}`, true);

    expect(rows).toHaveLength(2);
    expect(parseChatCallback(rows[1]?.[0]?.callbackData ?? '')).toEqual({
      action: 'share',
      id: CHAT_ID,
    });
  });

  /**
   * `share` asks; `shareyes` does. The button on the *message* must be the asking
   * one — a keyboard that jumped straight to the act would make an unbidden
   * message one tap away from a disclosure that cannot be undone.
   */
  it('offers the question, never the act', () => {
    const rows = chatKeyboard(CHAT_ID, BOT, `chats/${CHAT_ID}`, true);

    expect(parseChatCallback(rows[1]?.[0]?.callbackData ?? '')?.action).not.toBe('shareyes');
  });

  it('leaves it off when the payload does not say the chat is open', () => {
    // An older deploy's payload has no `chatOpen`, which reaches this as `false`.
    expect(chatKeyboard(CHAT_ID, BOT, `chats/${CHAT_ID}`, false)).toHaveLength(1);
    expect(chatKeyboard(CHAT_ID, BOT, `chats/${CHAT_ID}`)).toHaveLength(1);
  });

  /** Its own row: it sits beside a destructive button and cannot be undone. */
  it('keeps sharing on a row of its own', () => {
    const rows = chatKeyboard(CHAT_ID, BOT, `chats/${CHAT_ID}`, true);

    expect(rows[1]).toHaveLength(1);
  });
});

describe('the host decision keyboard', () => {
  it('puts both decisions one tap away, with the conversation under them', () => {
    const rows = hostDecisionKeyboard(CHAT_ID, BOT, `participants/${CHAT_ID}`);

    expect(parseChatCallback(rows[0]?.[0]?.callbackData ?? '')?.action).toBe('accept');
    expect(parseChatCallback(rows[0]?.[1]?.callbackData ?? '')?.action).toBe('reject');
    expect(rows[1]?.[0]?.url).toContain(BOT);
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
