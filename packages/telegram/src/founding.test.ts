import { describe, expect, it } from 'vitest';
import { foundingBadge, foundingTierMedal, foundingTierName } from './founding';

describe('foundingTierName', () => {
  it('names the three shipped tiers', () => {
    expect(foundingTierName(1)).toBe('بنیان‌گذار');
    expect(foundingTierName(2)).toBe('پیشگام');
    expect(foundingTierName(3)).toBe('همراه نخست');
  });

  /**
   * The campaign can be reconfigured with more waves than there is copy for. A
   * member holding a tier this file has never heard of must still be named —
   * rendering a bare number, or worse `undefined`, on somebody's profile is a
   * worse outcome than calling them an early member, which is true of all of them.
   */
  it('falls back rather than rendering a number nobody chose', () => {
    expect(foundingTierName(4)).toBe('همراه نخست');
    expect(foundingTierName(0)).toBe('همراه نخست');
  });
});

/**
 * The three waves are a podium, so they wear Telegram's own medals.
 *
 * One ticket for all three said "member" and nothing about which wave; a medal
 * says both at a glance, in a roster where the tier is all a stranger is shown.
 */
describe('foundingTierMedal', () => {
  it('gives each shipped tier its own medal', () => {
    expect(foundingTierMedal(1)).toBe('🥇');
    expect(foundingTierMedal(2)).toBe('🥈');
    expect(foundingTierMedal(3)).toBe('🥉');
  });

  /** The same fallback as the name, so a medal and its label never disagree. */
  it('falls back to the medal of the name it falls back to', () => {
    expect(foundingTierMedal(4)).toBe(foundingTierMedal(3));
    expect(foundingTierMedal(0)).toBe(foundingTierMedal(3));
  });
});

describe('foundingBadge', () => {
  it('is empty for somebody who is not a member', () => {
    expect(foundingBadge(null)).toBe('');
  });

  it('leads with a space so it concatenates onto a name', () => {
    expect(foundingBadge(1)).toBe(' 🥇 بنیان‌گذار');
    expect(`سارا${foundingBadge(2)}`).toBe('سارا 🥈 پیشگام');
    expect(foundingBadge(3)).toBe(' 🥉 همراه نخست');
  });

  /**
   * The rule the roster depends on. A line there already numbers two things —
   * the button index and the waitlist position — and a third number meaning
   * "joined early" would make «نفر ۳» ambiguous on a screen a host acts from.
   */
  it('never contains a rank', () => {
    for (const tier of [1, 2, 3]) {
      expect(foundingBadge(tier)).not.toMatch(/\d|[۰-۹]/u);
    }
  });
});
