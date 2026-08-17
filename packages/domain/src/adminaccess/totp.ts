import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) over HMAC-SHA1, the algorithm every authenticator app
 * implements.
 *
 * Hand-rolled rather than taken from a package, for the reason M2 hand-rolled the
 * `initData` HMAC: it is thirty lines of standard arithmetic, it has published
 * test vectors, and a pure function with no I/O is testable without any
 * infrastructure. A dependency here would be a supply-chain risk on the code path
 * that decides who reaches the moderation panel.
 *
 * SHA-1 is correct here and is not a weakness: RFC 6238 specifies HMAC-SHA1, the
 * secret is 160 bits of entropy, and the construction depends on HMAC's security
 * rather than on collision resistance. Authenticator apps do not offer a choice.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decodes the base32 an authenticator app is provisioned with (RFC 4648, no padding). */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replaceAll(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('invalid base32 in TOTP secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  return Buffer.from(out);
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];

  return out;
}

/** The six-digit code for one time step. */
export function totpCode(secret: Buffer, atMs: number, step = PERIOD_SECONDS): string {
  const counter = Math.floor(atMs / 1000 / step);

  const message = Buffer.alloc(8);
  // A 64-bit counter written as two 32-bit halves: `writeBigUInt64BE` would work
  // too, but this keeps the value in the safe integer range on the way in.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', secret).update(message).digest();
  // Dynamic truncation, RFC 4226 §5.3.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Whether a submitted code is valid at this instant.
 *
 * `window` steps either side, because phone clocks drift and a user who is thirty
 * seconds out should not be locked out of the panel. One step each way is the
 * usual choice: it accepts a 90-second span in total, which is short enough that a
 * shoulder-surfed code is stale before it is useful.
 *
 * Compared in constant time. A timing oracle on six digits is not the most
 * pressing threat in the world, but the comparison is free to do properly and the
 * habit is what matters on an auth path.
 */
export function verifyTotp(secret: Buffer, code: string, atMs: number, window = 1): boolean {
  const submitted = code.trim();
  if (!/^\d{6}$/.test(submitted)) return false;

  const expected = Buffer.from(submitted, 'utf8');
  let matched = false;

  for (let drift = -window; drift <= window; drift += 1) {
    const candidate = Buffer.from(totpCode(secret, atMs + drift * PERIOD_SECONDS * 1000), 'utf8');
    // Not `||=` with a short circuit: every candidate is compared, so the number
    // of comparisons does not depend on which one matched.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }

  return matched;
}
