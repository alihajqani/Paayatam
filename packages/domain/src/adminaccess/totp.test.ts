import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, totpCode, verifyTotp } from './totp';

/**
 * RFC 6238's own test vectors, which is the only way to know an implementation of
 * a standard is the standard rather than something that merely looks like it.
 *
 * The published vectors use the ASCII secret `12345678901234567890` and an
 * 8-digit code; this implementation emits six digits, which is what authenticator
 * apps use, so the expectations below are the last six of each published value.
 */
const RFC_SECRET = Buffer.from('12345678901234567890', 'utf8');

describe('TOTP against RFC 6238', () => {
  it.each([
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
  ])('produces the published code at %i ms', (atMs, expected) => {
    expect(totpCode(RFC_SECRET, atMs)).toBe(expected);
  });
});

describe('base32', () => {
  it('round-trips a secret', () => {
    const secret = Buffer.from('12345678901234567890', 'utf8');
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
  });

  it('accepts the spacing and padding an authenticator app shows', () => {
    const encoded = base32Encode(RFC_SECRET);
    const withNoise = `${encoded.slice(0, 4)} ${encoded.slice(4, 8)}-${encoded.slice(8)}==`;
    expect(base32Decode(withNoise)).toEqual(RFC_SECRET);
  });

  it('refuses something that is not base32 rather than decoding it to nonsense', () => {
    expect(() => base32Decode('not-base32!')).toThrow(/invalid base32/);
  });
});

describe('verification', () => {
  const now = 1_700_000_000_000;

  it('accepts the current code', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(true);
  });

  /**
   * Phone clocks drift, and somebody thirty seconds out should not be locked out
   * of the panel. One step either way accepts a ninety-second span in total —
   * short enough that a shoulder-surfed code is stale before it is useful.
   */
  it('accepts one step either side of now', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), now)).toBe(true);
  });

  it('refuses a code two steps away', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 90_000), now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 90_000), now)).toBe(false);
  });

  it('refuses a code from a different secret', () => {
    const other = Buffer.from('09876543210987654321', 'utf8');
    expect(verifyTotp(RFC_SECRET, totpCode(other, now), now)).toBe(false);
  });

  /** Anything that is not six digits is rejected before any HMAC is computed. */
  it.each(['', '12345', '1234567', 'abcdef', '12 34 56'])('refuses %o', (code) => {
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(false);
  });
});
