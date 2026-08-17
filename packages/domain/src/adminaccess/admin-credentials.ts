import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';
import { base32Encode } from './totp';

/**
 * Admin credential primitives (ADR-0010, D11).
 *
 * Two things live here and nothing else does: how a password becomes a hash, and
 * how a TOTP secret is protected at rest. Both are the kind of code that is
 * written once, tested hard, and never inlined at a call site.
 *
 * **argon2id**, not bcrypt and not scrypt. It is memory-hard against GPU attack
 * and side-channel resistant in the hybrid mode, which is what the "id" is; the
 * parameters below are the library's defaults, which track the OWASP guidance.
 * The salt is generated per hash and travels inside the encoded string, so there
 * is no salt column to forget to populate.
 */

/** GCM's recommended nonce length, matching `MessageCipher`. */
const NONCE_BYTES = 12;

/**
 * The minimum a password may be.
 *
 * Length is the only requirement worth enforcing mechanically — composition rules
 * ("one symbol, one digit") push people towards `Password1!` and measurably weaken
 * the result. The common-password check ADR-0010 asks for belongs beside this and
 * is noted as outstanding rather than pretended.
 */
export const MIN_PASSWORD_LENGTH = 12;

@Injectable()
export class AdminCredentials {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    // The same key the chat bodies use. One 32-byte secret protects everything
    // this application encrypts at rest, and `key_version` on the message rows is
    // what makes rotating it a background job rather than a schema change.
    const configured = env.CHAT_ENCRYPTION_KEY;
    if (configured === undefined) {
      throw new Error('CHAT_ENCRYPTION_KEY is not set. Admin TOTP secrets cannot be protected.');
    }
    this.key = Buffer.from(configured, 'base64');
    if (this.key.length !== 32) {
      throw new Error('CHAT_ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
  }

  async hashPassword(password: string): Promise<string> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`admin password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`);
    }
    // `2` is `Algorithm.Argon2id`. Written as the literal because the library
    // exports an ambient const enum, which `isolatedModules` cannot inline —
    // importing it compiles and then fails at runtime with an undefined value.
    return hash(password, { algorithm: 2 });
  }

  /**
   * Whether a password matches.
   *
   * Returns false rather than throwing on a malformed hash: a corrupted row must
   * fail a login, not take the endpoint down with a 500 that tells an attacker
   * they found something interesting.
   */
  async verifyPassword(encoded: string, password: string): Promise<boolean> {
    try {
      return await verify(encoded, password);
    } catch {
      return false;
    }
  }

  /** A fresh 160-bit TOTP secret, base32 for the authenticator app to consume. */
  generateTotpSecret(): string {
    return base32Encode(randomBytes(20));
  }

  /**
   * AES-256-GCM, same construction as the chat bodies: nonce ‖ ciphertext ‖ tag,
   * base64. A TOTP secret in plaintext in the database is a second factor that a
   * database dump defeats, which is no second factor at all.
   */
  encryptTotpSecret(secret: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
  }

  decryptTotpSecret(encoded: string): string {
    const raw = Buffer.from(encoded, 'base64');
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(NONCE_BYTES, raw.length - 16);

    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);
    // Throws on a tampered or truncated value rather than returning plausible
    // bytes — decryption fails closed.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
