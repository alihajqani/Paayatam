import { describe, expect, it } from 'vitest';
import {
  botStartUrl,
  encodeCampaignPayload,
  encodeStartPayload,
  isStartPayload,
  parseCampaignTag,
  parseStartPayload,
  shareUrl,
  stripReferralPrefix,
} from './deep-link';

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

/**
 * `?start=src_<tag>` — the link an operator puts on an ad.
 *
 * It shares `/start` with the event links and the referral codes, so what these
 * pin is that the three shapes cannot be mistaken for one another, and that a tag
 * written two ways by hand is one campaign.
 */
describe('campaign links', () => {
  it('round-trips a tag, lower-cased', () => {
    expect(encodeCampaignPayload('TgAds_Anon-1')).toBe('src_tgads_anon-1');
    expect(parseCampaignTag('src_tgads_anon-1')).toBe('tgads_anon-1');
    expect(parseCampaignTag('SRC_TgAds_Anon-1')).toBe('tgads_anon-1');
  });

  it('fits the 64 characters Telegram allows, and refuses a tag that would not', () => {
    expect(encodeCampaignPayload('a'.repeat(60))).toHaveLength(64);
    expect(() => encodeCampaignPayload('a'.repeat(61))).toThrow();
    expect(() => encodeCampaignPayload('تبلیغ')).toThrow();
    expect(() => encodeCampaignPayload('')).toThrow();
  });

  it('is never read as an event link or a referral, and neither is read as it', () => {
    expect(parseStartPayload('src_tgads')).toBeNull();
    expect(parseCampaignTag(`event_${ID}`)).toBeNull();
    expect(parseCampaignTag('ABCD2345')).toBeNull();
    expect(parseCampaignTag('ref_ABCD2345')).toBeNull();
  });

  it('names no campaign for a bare prefix or a tag Telegram could not carry', () => {
    expect(parseCampaignTag('src_')).toBeNull();
    expect(parseCampaignTag('src_two words')).toBeNull();
  });
});

describe('isStartPayload', () => {
  it("is Telegram's own rule: 1–64 of A-Za-z0-9_-", () => {
    expect(isStartPayload('ABCD2345')).toBe(true);
    expect(isStartPayload('a'.repeat(64))).toBe(true);
    expect(isStartPayload('a'.repeat(65))).toBe(false);
    expect(isStartPayload('hello there')).toBe(false);
    expect(isStartPayload('')).toBe(false);
  });
});

describe('stripReferralPrefix', () => {
  it('accepts the prefix a link generator adds, in either separator', () => {
    expect(stripReferralPrefix('ref_ABCD2345')).toBe('ABCD2345');
    expect(stripReferralPrefix('REF-ABCD2345')).toBe('ABCD2345');
    expect(stripReferralPrefix('ABCD2345')).toBe('ABCD2345');
  });
});
