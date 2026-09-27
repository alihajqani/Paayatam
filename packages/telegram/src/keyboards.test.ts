import { describe, expect, it } from 'vitest';
import { parseChatCallback } from './callback-data';
import { COMMAND_GROUPS } from './commands';
import {
  guestEventKeyboard,
  hostDecisionKeyboard,
  menuGroupKeyboard,
  NEXT_LABEL,
  PREVIOUS_LABEL,
} from './keyboards';

const CHAT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

/**
 * Colour marks the one thing a screen asks for, and what cannot be undone.
 *
 * Asserted here rather than left to the eye because a colour is invisible in
 * every test that reads labels, and a `style` dropped in a refactor would only
 * show up on a phone.
 */
describe('button colours', () => {
  it('makes accepting green and rejecting red', () => {
    expect(hostDecisionKeyboard(CHAT_ID)[0]?.map((button) => button.style)).toEqual([
      'success',
      'danger',
    ]);
  });

  it('greens the message to the host after an acceptance, and leaves the page plain', () => {
    const [row] = guestEventKeyboard('evt_abcdefgh');
    expect(row?.map((button) => button.style)).toEqual(['success', undefined]);
  });

  it('leaves navigation plain', () => {
    for (const group of COMMAND_GROUPS) {
      for (const button of menuGroupKeyboard(group).flat()) {
        expect(button).not.toHaveProperty('style');
      }
    }
  });
});

describe('the menu group buttons', () => {
  it('puts an emoji in front of every command and a back arrow on the way out', () => {
    for (const group of COMMAND_GROUPS) {
      const rows = menuGroupKeyboard(group);
      const back = rows[rows.length - 1]?.[0];

      expect(back?.text).toBe('↩️ بازگشت به منو');
      for (const [button] of rows.slice(0, -1)) {
        expect(button?.text).toMatch(/^\S+ \S/u);
      }
    }
  });
});

/** Every arrow points the way its button sits: see `NEXT_LABEL`. */
describe('the paging labels', () => {
  it('draws «بعدی» with its arrow at the end, and «قبلی» with its arrow first', () => {
    expect(NEXT_LABEL.startsWith('بعدی')).toBe(true);
    expect(PREVIOUS_LABEL.endsWith('قبلی')).toBe(true);
  });
});
