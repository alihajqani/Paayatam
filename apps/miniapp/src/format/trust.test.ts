import { describe, expect, it } from 'vitest';
import { isKnownTrustScore } from './trust';

/**
 * The fallback is the whole point of this predicate, so most of what is asserted
 * here is what must *not* render as a number.
 */
describe('isKnownTrustScore', () => {
  it('accepts the range the contract allows, including both bounds', () => {
    expect(isKnownTrustScore(0)).toBe(true);
    expect(isKnownTrustScore(50)).toBe(true);
    expect(isKnownTrustScore(100)).toBe(true);
  });

  it('treats a missing score as unknown rather than as zero', () => {
    // The case that matters: a host who has never been judged has no
    // `trust_score` row, and «۰ از ۱۰۰» would be a claim about them that is false.
    expect(isKnownTrustScore(null)).toBe(false);
    expect(isKnownTrustScore(undefined)).toBe(false);
  });

  it('treats an out-of-range or non-integer score as unknown, never clamped', () => {
    expect(isKnownTrustScore(-1)).toBe(false);
    expect(isKnownTrustScore(101)).toBe(false);
    expect(isKnownTrustScore(72.5)).toBe(false);
    expect(isKnownTrustScore(Number.NaN)).toBe(false);
  });
});
