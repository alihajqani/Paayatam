import { describe, expect, it } from 'vitest';
import { formatReferral } from './referral';

const SUMMARY = { code: 'AB12CD', invited: 3, qualified: 1, coinsEarned: 20 };

describe('formatReferral', () => {
  it('links to the bot with the code', () => {
    expect(formatReferral(SUMMARY, 'paayatambot')).toContain(
      'https://t.me/paayatambot?start=AB12CD',
    );
  });

  /** Plan 18 item 9: how many of the founding places are gone, while any are left. */
  it('says how much of the founding campaign is taken', () => {
    const text = formatReferral(SUMMARY, 'paayatambot', { awarded: 612, max: 1000 });
    expect(text).toContain('۶۱۲ از ۱۰۰۰');
  });

  it('says nothing about a campaign that is switched off', () => {
    const text = formatReferral(SUMMARY, 'paayatambot', { awarded: 0, max: 0 });
    expect(text).not.toContain('نفر اول');
  });

  /** A full campaign has nothing left to hurry for, so the line would be a dead promise. */
  it('says nothing once every place is taken', () => {
    const text = formatReferral(SUMMARY, 'paayatambot', { awarded: 1000, max: 1000 });
    expect(text).not.toContain('نفر اول');
  });

  it('renders as before when no progress is passed', () => {
    expect(formatReferral(SUMMARY, 'paayatambot')).not.toContain('نفر اول');
  });
});
