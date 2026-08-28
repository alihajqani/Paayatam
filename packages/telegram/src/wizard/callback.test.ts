import { describe, expect, it } from 'vitest';
import { encodeWizardCallback, isWizardControl, parseWizardCallback } from './callback';

const UUID = '0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e6f';

describe('wizard callback', () => {
  it('round-trips a step value', () => {
    const encoded = encodeWizardCallback({ action: 'city', value: UUID });

    expect(parseWizardCallback(encoded)).toEqual({ action: 'city', value: UUID });
  });

  it('round-trips a control with no value', () => {
    expect(parseWizardCallback(encodeWizardCallback({ action: 'back', value: '' }))).toEqual({
      action: 'back',
      value: '',
    });
  });

  /** The widest thing this protocol emits, and Telegram's hard limit is 64. */
  it('keeps the widest callback inside Telegram’s 64 bytes', () => {
    const encoded = encodeWizardCallback({ action: 'city', value: UUID });

    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('throws rather than emit something Telegram would refuse', () => {
    expect(() => encodeWizardCallback({ action: 'city', value: 'a'.repeat(60) })).toThrow();
    // A colon in the value would make the decode ambiguous.
    expect(() => encodeWizardCallback({ action: 'city', value: 'a:b' })).toThrow();
    expect(() => encodeWizardCallback({ action: 'NotAToken', value: '' })).toThrow();
  });

  /** The chat protocol's buttons arrive at the same handler. */
  it('returns null for another protocol’s button', () => {
    expect(parseWizardCallback('chat:accept:abcd')).toBeNull();
  });

  it('returns null for anything malformed or tampered', () => {
    expect(parseWizardCallback('wz:city')).toBeNull();
    expect(parseWizardCallback('wz:city:a:b')).toBeNull();
    expect(parseWizardCallback('wz:CITY:x')).toBeNull();
    expect(parseWizardCallback('wz:city:../../etc/passwd')).toBeNull();
    expect(parseWizardCallback('')).toBeNull();
  });

  it('tells a control apart from a step key', () => {
    expect(isWizardControl('back')).toBe(true);
    expect(isWizardControl('confirm')).toBe(true);
    expect(isWizardControl('city')).toBe(false);
  });
});
