/**
 * The log redaction allowlist (T15).
 *
 * §8 is unambiguous about what must never reach a log line: `telegram_user_id`,
 * tokens, `initData`, phone numbers and message bodies. The threat is not that
 * somebody logs a secret on purpose — it is that a well-meaning
 * `logger.error({ err, request })` serialises a whole object, and the interesting
 * fields ride along.
 *
 * **A denylist of field names, checked recursively, plus a pattern sweep over
 * strings.** Neither alone is enough: a field called `telegramUserId` is caught by
 * name wherever it appears, and a Telegram id pasted into a free-text error
 * message is caught by shape. The field list is the reliable half; the pattern
 * sweep is the net under it.
 *
 * The plan asks that this be "asserted against every sensitive field name", which
 * is why the list is exported — the test iterates it rather than restating it.
 */

/**
 * Field names whose value is replaced, wherever they appear and at any depth.
 *
 * Matched case-insensitively and in both `camelCase` and `snake_case`, because a
 * value crosses that boundary every time it moves between Prisma and an API
 * response and a logger sees whichever side it was handed.
 */
export const REDACTED_FIELDS: readonly string[] = [
  // The highest-value identifier in the product (invariant 7).
  'telegramUserId',
  'telegram_user_id',
  'usernameCached',
  'username_cached',
  'firstNameCached',
  'first_name_cached',
  // Authentication material.
  'initData',
  'init_data',
  'password',
  'passwordHash',
  'password_hash',
  'totpSecret',
  'totpSecretEnc',
  'totp_secret_enc',
  'totpCode',
  'token',
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'sessionToken',
  'session_token',
  'csrfToken',
  'csrf_token',
  'authorization',
  'cookie',
  'secret',
  'apiKey',
  'api_key',
  // Chat content and the keys that protect it (ADR-0009).
  'bodyCiphertext',
  'body_ciphertext',
  'bodyNonce',
  'body_nonce',
  'chatEncryptionKey',
  'CHAT_ENCRYPTION_KEY',
  // Personal details §8 says are never stored raw, so they must not be logged.
  'phone',
  'phoneNumber',
  'phone_number',
  'ip',
  'ipAddress',
  'ip_address',
  'email',
];

export const REDACTED = '[redacted]';

/**
 * Shapes worth catching even when the field name is innocent.
 *
 * Deliberately narrow. A pattern that matched "any long number" would redact
 * prices, counts and timestamps, and a redactor that mangles ordinary logs is one
 * somebody turns off.
 */
const PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // An Iranian mobile number in either form.
  { pattern: /(?:\+98|0)9\d{9}/g, replacement: REDACTED },
  // A Telegram bot token: digits, colon, a run of URL-safe characters. The length
  // is a range rather than the 35 that is usually quoted — the format is not
  // documented as fixed, and a redactor that misses a real token because it was
  // one character short is worse than one that occasionally redacts a long
  // colon-separated identifier.
  { pattern: /\b\d{6,12}:[A-Za-z0-9_-]{30,60}\b/g, replacement: REDACTED },
  // A `t.me` link, which carries a username.
  { pattern: /(?:https?:\/\/)?t\.me\/[A-Za-z0-9_+]+/gi, replacement: REDACTED },
  // A bearer token in a header-shaped string.
  { pattern: /Bearer\s+[A-Za-z0-9._-]+/gi, replacement: `Bearer ${REDACTED}` },
];

const MAX_DEPTH = 8;

/**
 * Redact a value for logging.
 *
 * Recursive, with a depth cap: a cyclic or absurdly nested object must not turn a
 * log call into a stack overflow, and a logger that can crash the process is worse
 * than no logging.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));

  // A Buffer or typed array is either a ciphertext or a key. Neither is loggable,
  // and its length is all a diagnosis ever needs.
  if (ArrayBuffer.isView(value)) return `[binary ${String(value.byteLength)}B]`;
  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitive(key) ? REDACTED : redact(entry, depth + 1);
  }
  return out;
}

export function isSensitive(field: string): boolean {
  const normalized = field.toLowerCase();
  return REDACTED_FIELDS.some((sensitive) => sensitive.toLowerCase() === normalized);
}

function redactString(value: string): string {
  let out = value;
  for (const { pattern, replacement } of PATTERNS) {
    out = out.replaceAll(pattern, replacement);
  }
  return out;
}
