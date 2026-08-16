import { describe, expect, it } from 'vitest';
import { HOST_ALIAS, HOST_ALIAS_INDEX, guestAlias, toPersianDigits } from './alias';

/**
 * The property under test is not "the string looks right". It is that an alias
 * is a **function of the chat's position, and of nothing about the person**
 * (ADR-0009, layer 3). Everything below is an attempt to state that as something
 * a future change can fail.
 */

describe('guest aliases', () => {
  it.each([
    [1, 'میهمان ۱'],
    [2, 'میهمان ۲'],
    [7, 'میهمان ۷'],
    [10, 'میهمان ۱۰'],
    [42, 'میهمان ۴۲'],
  ])('numbers %i as %s', (index, expected) => {
    expect(guestAlias(index)).toBe(expected);
  });

  /**
   * The whole anti-correlation argument in one assertion: the function takes a
   * position and nothing else, so two different people at the same position get
   * the same alias and one person at two positions gets two. An alias therefore
   * carries no information about identity — not "less information", none.
   */
  it('depends on position alone', () => {
    expect(guestAlias(3)).toBe(guestAlias(3));
    expect(guestAlias(3)).not.toBe(guestAlias(4));
  });

  it('refuses an index that is not a position', () => {
    expect(() => guestAlias(0)).toThrow(/positive integer/);
    expect(() => guestAlias(-1)).toThrow(/positive integer/);
    expect(() => guestAlias(1.5)).toThrow(/positive integer/);
  });
});

describe('the host', () => {
  /**
   * Unnumbered, because there is exactly one per event (plan §2.6). Numbering
   * them would imply a second host somewhere, and index 0 is what keeps
   * `UNIQUE (chat_id, alias_index)` true for a chat whose guest is the event's
   * first.
   */
  it('is «میزبان» at index 0', () => {
    expect(HOST_ALIAS).toBe('میزبان');
    expect(HOST_ALIAS_INDEX).toBe(0);
    expect(HOST_ALIAS).not.toContain('۰');
  });
});

describe('Persian digits', () => {
  it.each([
    [0, '۰'],
    [5, '۵'],
    [1405, '۱۴۰۵'],
    [1234567890, '۱۲۳۴۵۶۷۸۹۰'],
  ])('renders %i as %s', (value, expected) => {
    expect(toPersianDigits(value)).toBe(expected);
  });

  /** The stored alias is display text; arithmetic uses `alias_index` (glossary §5). */
  it('leaves no Latin digit behind', () => {
    expect(toPersianDigits(2026)).not.toMatch(/\d/);
  });
});
