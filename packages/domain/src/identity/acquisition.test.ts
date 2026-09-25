import { describe, expect, it } from 'vitest';
import { acquisitionFor } from './acquisition';

const EVENT = '11111111-1111-4111-8111-111111111111';

describe('acquisitionFor', () => {
  it('calls a bare /start direct', () => {
    expect(acquisitionFor(null)).toEqual({ source: 'DIRECT', ref: null });
    expect(acquisitionFor('   ')).toEqual({ source: 'DIRECT', ref: null });
  });

  it('files an ad link under its tag, one spelling per campaign', () => {
    expect(acquisitionFor('src_tgads_anon1')).toEqual({ source: 'CAMPAIGN', ref: 'tgads_anon1' });
    expect(acquisitionFor('src_TgAds_Anon1')).toEqual({ source: 'CAMPAIGN', ref: 'tgads_anon1' });
  });

  it('files a channel post button or a shared event under the event', () => {
    expect(acquisitionFor(`event_${EVENT}`)).toEqual({ source: 'EVENT_LINK', ref: EVENT });
    expect(acquisitionFor(`join_${EVENT}`)).toEqual({ source: 'EVENT_LINK', ref: EVENT });
  });

  /**
   * By shape, not by whether the code exists: the claim runs after the account
   * is created, and a stale invite is still an invite.
   */
  it('files anything a referral code could be as a referral, with or without the prefix', () => {
    expect(acquisitionFor('ABCD2345')).toEqual({ source: 'REFERRAL', ref: null });
    expect(acquisitionFor('ref_abcd2345')).toEqual({ source: 'REFERRAL', ref: null });
  });

  /**
   * The case this row exists for: an operator who put `?start=tgads1` on an ad.
   * It is not a referral code (wrong length) and not a campaign (no prefix), and
   * it must still be visible under its own name.
   */
  it('keeps an unrecognised payload, so a mis-built ad link is still findable', () => {
    expect(acquisitionFor('tgads1')).toEqual({ source: 'OTHER', ref: 'tgads1' });
    // `O` and `I` are not in the referral alphabet.
    expect(acquisitionFor('NOSUCHCODE')).toEqual({ source: 'OTHER', ref: 'NOSUCHCODE' });
  });

  it('keeps nothing typed after /start that no link could carry', () => {
    expect(acquisitionFor('سلام دوست')).toEqual({ source: 'OTHER', ref: null });
    expect(acquisitionFor('a'.repeat(65))).toEqual({ source: 'OTHER', ref: null });
  });
});
