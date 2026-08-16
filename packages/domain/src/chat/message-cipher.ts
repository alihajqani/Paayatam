import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';

/**
 * Message body encryption (ADR-0009).
 *
 * AES-256-GCM. The nonce is 12 random bytes per message — never derived, never
 * reused, because a repeated nonce under the same key in GCM does not merely
 * weaken the ciphertext, it leaks the XOR of two plaintexts and destroys the
 * authentication guarantee outright.
 *
 * The 16-byte authentication tag is appended to the ciphertext rather than given
 * a column of its own: §4.4 specifies `body_ciphertext` and `body_nonce` and
 * nothing else, and a tag stored apart from the bytes it authenticates is a tag
 * somebody eventually forgets to check. Appending makes decryption fail closed —
 * a tampered or truncated row throws rather than returning plausible text.
 *
 * **The honest limitation, which ADR-0009 insists is never overstated:** this
 * protects database dumps, backups and a stolen disk. It does *not* protect
 * against a compromised application server, which by design holds the key. This
 * is not end-to-end encryption and must never be described as such to a user.
 */

/** GCM's recommended nonce length. 12 bytes, not 16 — longer nonces are re-hashed. */
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * The version stamped on everything written today.
 *
 * `key_version` exists from day one so that rotation is a background re-encrypt
 * job rather than a schema change under pressure. Rows carry the version that
 * encrypted them, so a future registry can decrypt old rows while writing new
 * ones under a new key.
 */
export const CURRENT_KEY_VERSION = 1;

export interface EncryptedBody {
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

@Injectable()
export class MessageCipher {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    const configured = env.CHAT_ENCRYPTION_KEY;
    if (configured === undefined) {
      // `packages/config` already requires this in production. Failing loudly
      // here covers the development case, where the alternative is storing chat
      // messages in the clear and finding out much later.
      throw new Error(
        'CHAT_ENCRYPTION_KEY is not set. Chat cannot start without it — generate one with ' +
          '`openssl rand -base64 32`.',
      );
    }

    this.key = Buffer.from(configured, 'base64');
    if (this.key.length !== 32) {
      throw new Error(
        `CHAT_ENCRYPTION_KEY must decode to 32 bytes, got ${String(this.key.length)}`,
      );
    }
  }

  encrypt(plaintext: string): EncryptedBody {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);

    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    // Tag last, so `decrypt` can split from the end regardless of body length.
    return {
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
      nonce,
      keyVersion: CURRENT_KEY_VERSION,
    };
  }

  /**
   * Decrypts, or throws.
   *
   * There is deliberately no "return null on failure" path. A body that will not
   * decrypt means the row was tampered with, truncated, or encrypted under a key
   * this process does not have — and every one of those is a fact a caller must
   * not be able to paper over by rendering an empty message.
   */
  decrypt(body: EncryptedBody): string {
    if (body.keyVersion !== CURRENT_KEY_VERSION) {
      throw new Error(
        `chat_message was encrypted with key version ${String(body.keyVersion)}, but this process ` +
          `holds version ${String(CURRENT_KEY_VERSION)}. Key rotation needs a re-encrypt job.`,
      );
    }
    if (body.ciphertext.length < TAG_BYTES) {
      throw new Error('chat_message ciphertext is too short to contain an authentication tag');
    }

    const tagAt = body.ciphertext.length - TAG_BYTES;
    const decipher = createDecipheriv('aes-256-gcm', this.key, body.nonce);
    decipher.setAuthTag(body.ciphertext.subarray(tagAt));

    return Buffer.concat([
      decipher.update(body.ciphertext.subarray(0, tagAt)),
      decipher.final(),
    ]).toString('utf8');
  }
}
