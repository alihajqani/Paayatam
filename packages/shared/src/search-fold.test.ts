import { describe, expect, it } from 'vitest';
import { foldedIncludes, foldForSearch } from './search-fold';

/**
 * The folding a city picker relies on (M22).
 *
 * Every case here is a real thing a person types on a real keyboard, not a
 * synthetic edge: an Arabic-keyboard `ي`, a name whose canonical spelling carries
 * a half-space nobody reproduces, and the Latin an English keyboard leaves behind.
 */
describe('foldForSearch', () => {
  it('folds the Arabic letters an Arabic keyboard produces', () => {
    expect(foldForSearch('قايم')).toBe(foldForSearch('قائم'));
    expect(foldForSearch('كرج')).toBe('کرج');
    expect(foldForSearch('مكه')).toBe(foldForSearch('مکه'));
  });

  it('treats a half-space as a space, because a search box has no half-space key', () => {
    expect(foldForSearch('قائم‌شهر')).toBe('قایم شهر');
    expect(foldForSearch('قائم شهر')).toBe('قایم شهر');
  });

  it('removes the invisible characters a paste leaves behind', () => {
    expect(foldForSearch('تهران​')).toBe('تهران');
    expect(foldForSearch('‎تهران‏')).toBe('تهران');
  });

  it('collapses whitespace and trims', () => {
    expect(foldForSearch('  بندر   عباس  ')).toBe('بندر عباس');
  });

  it('lower-cases the Latin some names carry', () => {
    expect(foldForSearch('Tehran')).toBe('tehran');
  });

  /**
   * Idempotence is load-bearing: `city.name_normalized` is stored folded and the
   * query is folded on the way in, so a second pass over stored data must be a
   * no-op or the two sides stop agreeing.
   */
  it('is idempotent', () => {
    for (const name of ['قائم‌شهر', 'كرج', '  بندر   عباس  ', 'Tehran']) {
      expect(foldForSearch(foldForSearch(name))).toBe(foldForSearch(name));
    }
  });

  /**
   * Deliberately *not* ADR-0012's pipeline: repetition and diacritics survive,
   * because collapsing them is right for a blacklist and wrong for a place name.
   */
  it('leaves repeated letters alone, unlike the moderation normalizer', () => {
    expect(foldForSearch('سسسنندج')).toBe('سسسنندج');
  });
});

describe('foldedIncludes', () => {
  it('matches across the folding', () => {
    expect(foldedIncludes('قائم‌شهر', 'قايم شهر')).toBe(true);
    expect(foldedIncludes('کرج', 'كر')).toBe(true);
  });

  it('does not match an unrelated name', () => {
    expect(foldedIncludes('تهران', 'شیراز')).toBe(false);
  });

  it('matches everything on an empty query, so a cleared box shows the list again', () => {
    expect(foldedIncludes('تهران', '')).toBe(true);
    expect(foldedIncludes('تهران', '   ')).toBe(true);
  });
});
