import { describe, expect, it } from 'vitest';
import { botStartUrl, encodeStartPayload, parseStartPayload, shareUrl } from './deep-link';

const ID = '11111111-1111-4111-8111-111111111111';

describe('the bot deep-link protocol', () => {
  it('round-trips both actions', () => {
    for (const action of ['event', 'join'] as const) {
      expect(parseStartPayload(encodeStartPayload(action, ID))).toEqual({ action, id: ID });
    }
  });

  it('stays inside the 64 characters Telegram allows', () => {
    // A UUID is 36 characters including its hyphens, so the longest payload here
    // is `join_` plus one — 41. The check is what keeps a future action honest.
    for (const action of ['event', 'join'] as const) {
      expect(encodeStartPayload(action, ID).length).toBeLessThanOrEqual(64);
    }
  });

  it('refuses an id Telegram would not carry, rather than sending a broken button', () => {
    // A button that fails at send time is a post nobody can act on, found by a
    // reader rather than by us.
    expect(() => encodeStartPayload('join', 'نه')).toThrow();
    expect(() => encodeStartPayload('join', 'a'.repeat(70))).toThrow();
  });

  it('answers null for a referral code, so the caller falls through to the claim', () => {
    // Referral codes are a different alphabet and carry no underscore. Attempting
    // the claim first would log a refusal for every channel tap.
    expect(parseStartPayload('ABC123')).toBeNull();
    expect(parseStartPayload('ref_ABC123')).toBeNull();
  });

  it('refuses a tampered id rather than passing it to a service', () => {
    expect(parseStartPayload('join_not-a-uuid')).toBeNull();
    expect(parseStartPayload('join_')).toBeNull();
    expect(parseStartPayload(`delete_${ID}`)).toBeNull();
    expect(parseStartPayload('')).toBeNull();
  });

  it('builds the link a channel post button carries', () => {
    expect(botStartUrl('payetam_bot', encodeStartPayload('event', ID))).toBe(
      `https://t.me/payetam_bot?start=event_${ID}`,
    );
  });
});

/**
 * Telegram's own share sheet for an activity (plan 11).
 *
 * `t.me/share/url` opens the client's forward dialog with the link pre-filled, so
 * a host can pass their activity to a friend or a group in two taps. The inner
 * link is the bot's `?start=event_`, the same one the channel post carries, and
 * it has to be percent-encoded or its `?` would end the outer query string.
 */
describe('shareUrl', () => {
  it('wraps the activity link for the share sheet', () => {
    expect(shareUrl('payetam_bot', ID)).toBe(
      `https://t.me/share/url?url=https%3A%2F%2Ft.me%2Fpayetam_bot%3Fstart%3Devent_${ID}`,
    );
  });
});
