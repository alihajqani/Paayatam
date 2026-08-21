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

  it('leaves TRUST_PROXY unset by default, so nothing is trusted', () => {
    // A process reached directly must not let a client choose its own apparent
    // address by sending X-Forwarded-For. Off is the only safe default.
    expect(loadEnv(minimalEnv).TRUST_PROXY).toBeUndefined();
  });

  it('accepts the shapes proxy-addr understands for TRUST_PROXY', () => {
    expect(loadEnv({ ...minimalEnv, TRUST_PROXY: '172.18.0.0/16' }).TRUST_PROXY).toBe(
      '172.18.0.0/16',
    );
    expect(loadEnv({ ...minimalEnv, TRUST_PROXY: 'loopback' }).TRUST_PROXY).toBe('loopback');
    expect(loadEnv({ ...minimalEnv, TRUST_PROXY: '2' }).TRUST_PROXY).toBe('2');
  });

  it('refuses a TRUST_PROXY that trusts every hop', () => {
    // `true` and `1` both mean "believe whatever X-Forwarded-For says", which
    // hands an attacker the rate limiter and the audit trail at the same time.
    for (const value of ['true', '1']) {
      let problems: string[] = [];
      try {
        loadEnv({ ...minimalEnv, TRUST_PROXY: value });
      } catch (error) {
        problems = (error as EnvValidationError).problems;
      }
      expect(problems.join('\n')).toMatch(/TRUST_PROXY/);
    }
  });

  it('treats monitoring as optional in production and defaults the alert floor', () => {
    // A deployment with no alerting channel is a worse deployment, not a broken
    // one — refusing to boot over it would take the product down for monitoring.
    const env = loadEnv(productionEnv);
    expect(env.MONITORING_CHAT_ID).toBeUndefined();
    expect(env.MONITORING_ALERT_COOLDOWN_SECONDS).toBe(300);
  });

  it('coerces the alert cooldown and allows disabling it', () => {
    expect(
      loadEnv({ ...minimalEnv, MONITORING_ALERT_COOLDOWN_SECONDS: '60' })
        .MONITORING_ALERT_COOLDOWN_SECONDS,
    ).toBe(60);
    expect(
      loadEnv({ ...minimalEnv, MONITORING_ALERT_COOLDOWN_SECONDS: '0' })
        .MONITORING_ALERT_COOLDOWN_SECONDS,
    ).toBe(0);
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
