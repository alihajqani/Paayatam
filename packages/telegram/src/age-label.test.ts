import { describe, expect, it } from 'vitest';
import { ageSuffix } from './age-label';

describe('ageSuffix', () => {
  it('writes the age in Persian digits after a comma', () => {
    expect(ageSuffix(31)).toBe('، ۳۱ ساله');
  });

  /** A garbled payload must not put «۰ ساله» or «NaN» next to a real person. */
  it.each([null, undefined, 0, -3, 2.5, 500, '31', Number.NaN])('draws nothing for %s', (age) => {
    expect(ageSuffix(age)).toBe('');
  });
});
