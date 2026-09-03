import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import { CURRENT_KEY_VERSION, MessageCipher } from './message-cipher';

/**
 * The properties worth asserting about the cipher are the ones that fail
 * silently when they break: a nonce that repeats, a tamper that decrypts anyway,
 * and a key length that is wrong in a way AES does not complain about.
 */

const KEY = randomBytes(32).toString('base64');

function cipherWith(key: string | undefined): MessageCipher {
  return new MessageCipher({ CHAT_ENCRYPTION_KEY: key } as unknown as Env);
}

const cipher = cipherWith(KEY);

/** Corrupts one byte in place. Read/write rather than index assignment, because
 * indexed access into a Buffer is `number | undefined` under this repo's
 * `noUncheckedIndexedAccess`. */
function flipByte(buffer: Buffer, at: number): void {
  buffer.writeUInt8(buffer.readUInt8(at) ^ 0xff, at);
}

describe('round-tripping', () => {
  it.each([
    ['Persian text', 'سلام، ساعت ۵ می‌بینمت'],
    ['mixed scripts', 'Cafe Vali-Asr — کافه ولیعصر'],
    ['emoji', 'باشه 👍🏽 می‌بینمت'],
    ['a single character', 'ب'],
    ['a long message', 'سلام '.repeat(500)],
  ])('recovers %s exactly', (_label, plaintext) => {
    expect(cipher.decrypt(cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it('stamps the current key version', () => {
    expect(cipher.encrypt('سلام').keyVersion).toBe(CURRENT_KEY_VERSION);
  });

  it('produces a 12-byte nonce', () => {
    expect(cipher.encrypt('سلام').nonce).toHaveLength(12);
  });
});

describe('the ciphertext tells you nothing', () => {
  it('does not contain the plaintext', () => {
    const plaintext = 'شماره من 09121234567 است';
    const { ciphertext } = cipher.encrypt(plaintext);

    expect(ciphertext.toString('utf8')).not.toContain('09121234567');
    expect(ciphertext.toString('latin1')).not.toContain('09121234567');
  });

  /**
   * The nonce is fresh per message, so encrypting the same text twice must not
   * produce the same bytes. If it did, an attacker with the database could tell
   * that two people sent the identical message — and under GCM a repeated nonce
   * leaks far more than that.
   */
  it('encrypts the same text differently every time', () => {
    const results = Array.from({ length: 50 }, () => cipher.encrypt('سلام'));
    const nonces = new Set(results.map((r) => r.nonce.toString('base64')));
    const bodies = new Set(results.map((r) => r.ciphertext.toString('base64')));

    expect(nonces.size).toBe(50);
    expect(bodies.size).toBe(50);
  });
});

describe('decryption fails closed', () => {
  it('refuses a body whose ciphertext was altered', () => {
    const encrypted = cipher.encrypt('سلام، ساعت ۵');
    flipByte(encrypted.ciphertext, 0);

    expect(() => cipher.decrypt(encrypted)).toThrowError();
  });

  it('refuses a body whose authentication tag was altered', () => {
    const encrypted = cipher.encrypt('سلام، ساعت ۵');
    flipByte(encrypted.ciphertext, encrypted.ciphertext.length - 1);

    expect(() => cipher.decrypt(encrypted)).toThrowError();
  });

  it('refuses a body whose nonce was swapped', () => {
    const encrypted = cipher.encrypt('سلام، ساعت ۵');

    expect(() => cipher.decrypt({ ...encrypted, nonce: randomBytes(12) })).toThrowError();
  });

  it('refuses a body encrypted under a different key', () => {
    const other = cipherWith(randomBytes(32).toString('base64'));

    expect(() => cipher.decrypt(other.encrypt('سلام'))).toThrowError();
  });

  it('refuses a truncated body rather than returning a prefix', () => {
    const encrypted = cipher.encrypt('سلام، ساعت ۵ می‌بینمت');
    encrypted.ciphertext = encrypted.ciphertext.subarray(0, 8);

    expect(() => cipher.decrypt(encrypted)).toThrowError(/too short|unable/i);
  });

  it('names key rotation when the version does not match', () => {
    const encrypted = cipher.encrypt('سلام');

    expect(() => cipher.decrypt({ ...encrypted, keyVersion: 2 })).toThrowError(/key version/i);
  });
});

describe('configuration', () => {
  it('refuses to start without a key rather than storing messages in the clear', () => {
    expect(() => cipherWith(undefined)).toThrowError(/CHAT_ENCRYPTION_KEY/);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => cipherWith(randomBytes(16).toString('base64'))).toThrowError(/32 bytes/);
  });
});
