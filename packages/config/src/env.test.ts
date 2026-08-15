import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from './env';

/** A base64 key of exactly 32 bytes. Test-only value; never used outside tests. */
const KEY_32 = Buffer.alloc(32, 7).toString('base64');
const SECRET_32 = 'x'.repeat(32);

const minimalEnv = {
  DATABASE_URL: 'postgresql://user:pw@localhost:5432/payetam?schema=public',
  REDIS_URL: 'redis://localhost:6379',
} satisfies NodeJS.ProcessEnv;

const productionEnv = {
  ...minimalEnv,
  NODE_ENV: 'production',
  TELEGRAM_MODE: 'webhook',
  TELEGRAM_BOT_TOKEN: '1234567890:AAaaBBbbCCccDDddEEeeFFffGGgghhhh1234',
  TELEGRAM_WEBHOOK_SECRET_PATH: 'a'.repeat(48),
  TELEGRAM_WEBHOOK_SECRET_TOKEN: 'b'.repeat(64),
  CHAT_ENCRYPTION_KEY: KEY_32,
  PII_HASH_PEPPER: KEY_32,
  JWT_ACCESS_SECRET: SECRET_32,
  JWT_REFRESH_SECRET: SECRET_32,
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('accepts a minimal development environment and applies defaults', () => {
    const env = loadEnv(minimalEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3000);
    // ADR-0008: business timezone default.
    expect(env.APP_TIMEZONE).toBe('Asia/Tehran');
    expect(env.TELEGRAM_MODE).toBe('polling');
    expect(env.ALLOW_PROD_SEED).toBe(false);
  });

  it('throws when a required variable is missing', () => {
    expect(() => loadEnv({ REDIS_URL: 'redis://localhost:6379' })).toThrow(EnvValidationError);
  });

  it('reports every problem at once rather than only the first', () => {
    let problems: string[] = [];
    try {
      loadEnv({ DATABASE_URL: 'not-a-url', REDIS_URL: 'also-not-a-url', API_PORT: '70000' });
    } catch (error) {
      problems = (error as EnvValidationError).problems;
    }

    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/REDIS_URL/);
    expect(problems.join('\n')).toMatch(/API_PORT/);
  });

  it('treats a blank value as absent rather than as an invalid one', () => {
    // .env.example ships optional variables blank (e.g. TELEGRAM_CHANNEL_ID=), and
    // `make setup` blanks TELEGRAM_BOT_TOKEN. A blank must not fail format checks.
    const env = loadEnv({ ...minimalEnv, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHANNEL_ID: '   ' });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_CHANNEL_ID).toBeUndefined();
  });

  it('still applies defaults when a defaulted variable is blank', () => {
    const env = loadEnv({ ...minimalEnv, APP_TIMEZONE: '', API_PORT: '' });
    expect(env.APP_TIMEZONE).toBe('Asia/Tehran');
    expect(env.API_PORT).toBe(3000);
  });

  it('rejects a database URL with the wrong scheme', () => {
    expect(() => loadEnv({ ...minimalEnv, DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an encryption key that is not exactly 32 bytes', () => {
    const tooShort = Buffer.alloc(16, 1).toString('base64');
    expect(() => loadEnv({ ...productionEnv, CHAT_ENCRYPTION_KEY: tooShort })).toThrow(
      /CHAT_ENCRYPTION_KEY/,
    );
  });

  it('rejects an invalid IANA timezone', () => {
    expect(() => loadEnv({ ...minimalEnv, APP_TIMEZONE: 'Mars/Olympus_Mons' })).toThrow(
      /APP_TIMEZONE/,
    );
  });

  // ADR-0004: polling is development-only.
  it('refuses polling mode in production', () => {
    expect(() => loadEnv({ ...productionEnv, TELEGRAM_MODE: 'polling' })).toThrow(/TELEGRAM_MODE/);
  });

  // M17 safety rail.
  it('refuses ALLOW_PROD_SEED in production', () => {
    expect(() => loadEnv({ ...productionEnv, ALLOW_PROD_SEED: '1' })).toThrow(/ALLOW_PROD_SEED/);
  });

  it('requires telegram and crypto variables in production', () => {
    const { CHAT_ENCRYPTION_KEY: _omitted, ...withoutKey } = productionEnv;

    let problems: string[] = [];
    try {
      loadEnv(withoutKey);
    } catch (error) {
      problems = (error as EnvValidationError).problems;
    }

    expect(problems.join('\n')).toMatch(
      /CHAT_ENCRYPTION_KEY: is required when NODE_ENV=production/,
    );
  });

  it('accepts a complete production environment', () => {
    const env = loadEnv(productionEnv);
    expect(env.NODE_ENV).toBe('production');
    expect(env.TELEGRAM_MODE).toBe('webhook');
  });

  it('does not leak values into the error message', () => {
    const secret = 'super-secret-value-that-must-never-be-printed';
    let message = '';
    try {
      loadEnv({ ...minimalEnv, DATABASE_URL: secret });
    } catch (error) {
      message = (error as Error).message;
    }

    // ADR-0009 / T15: config errors name the variable, never its value.
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain(secret);
  });
});
