import { describe, expect, it } from 'vitest';
import { foundingBadge, foundingTierName } from './founding';

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

describe('foundingBadge', () => {
  it('is empty for somebody who is not a member', () => {
    expect(foundingBadge(null)).toBe('');
  });

  it('leads with a space so it concatenates onto a name', () => {
    expect(foundingBadge(1)).toBe(' 🎟 بنیان‌گذار');
    expect(`سارا${foundingBadge(2)}`).toBe('سارا 🎟 پیشگام');
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
