import { describe, expect, it } from 'vitest';
import { DEV_GIFT_CODE_PREFIX, maySeedGiftCodes } from './gift-code-fixtures';

/**
 * The gate on the one seed that writes money.
 *
 * Tested as a pure function rather than by running the script, because what
 * matters is the *shape* of the rule: it is an allowlist, and an allowlist fails
 * in the safe direction for every input nobody thought of. A `!== 'production'`
 * check would pass all of these and refuse none of them, which is exactly the
 * bug that ships a live promotional code with the repository.
 */
describe('who may seed development gift codes', () => {
  it('allows development and test', () => {
    expect(maySeedGiftCodes('development')).toBe(true);
    expect(maySeedGiftCodes('test')).toBe(true);
  });

  it('refuses production', () => {
    expect(maySeedGiftCodes('production')).toBe(false);
  });

  /**
   * Every one of these passes a `!== 'production'` check. That is the whole
   * argument for the allowlist: an unset variable is the most common of them, and
   * it is the case where somebody is running a command in a shell they did not
   * set up.
   */
  it('refuses anything it was not told about, including nothing at all', () => {
    for (const value of [undefined, '', 'Production', 'PRODUCTION', 'prod', 'staging', 'ci']) {
      expect(maySeedGiftCodes(value)).toBe(false);
    }
  });

  it('marks its codes so a human reading a row knows what they are', () => {
    expect(DEV_GIFT_CODE_PREFIX).toBe('DEV');
  });
});
