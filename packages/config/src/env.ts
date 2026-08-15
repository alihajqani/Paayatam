import { z } from 'zod';

/**
 * Environment validation.
 *
 * Two rules drive the shape of this file:
 *
 * 1. **Fail fast, and fail completely.** The process refuses to start on a bad
 *    config, and reports *every* problem at once rather than one per restart.
 *    A half-configured service that boots is worse than one that does not.
 *
 * 2. **Development may be incomplete; production may not.** Variables belonging
 *    to later milestones are optional so M1 can run with nothing but a database,
 *    but `requireInProduction` below makes them mandatory when NODE_ENV=production.
 *    That way a missing bot token is a local convenience, never a production outage.
 */

/** A base64 string decoding to exactly `bytes` bytes. Used for AES keys and peppers. */
const base64Key = (bytes: number) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    {
      message: `must be base64 decoding to exactly ${bytes} bytes (openssl rand -base64 ${bytes})`,
    },
  );

/** A URL we require a specific scheme for. `z.url()` accepts far more than we want here. */
const urlWithScheme = (schemes: readonly string[], label: string) =>
  z
    .string()
    .min(1)
    .refine((value) => schemes.some((scheme) => value.startsWith(`${scheme}://`)), {
      message: `must be a ${label} URL starting with ${schemes.map((s) => `${s}://`).join(' or ')}`,
    });

/** Validated against the runtime's own tz database rather than a hardcoded list. */
const ianaTimezone = z.string().refine(
  (value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'must be a valid IANA timezone identifier, e.g. Asia/Tehran' },
);

// In zod 4, `.default()` applied after `.transform()` takes the *output* type, so
// callers pass `false` rather than the string '0'.
const booleanFlag = z
  .enum(['0', '1', 'true', 'false'])
  .transform((value) => value === '1' || value === 'true');

export const envSchema = z
  .object({
    // ── Runtime ──────────────────────────────────────────────────────────────
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_API_URL: urlWithScheme(['http', 'https'], 'http(s)').default('http://localhost:3000'),

    // ── Required from M1 ─────────────────────────────────────────────────────
    DATABASE_URL: urlWithScheme(['postgresql', 'postgres'], 'PostgreSQL'),
    REDIS_URL: urlWithScheme(['redis', 'rediss'], 'Redis'),
    QUEUE_PREFIX: z.string().min(1).default('payetam:dev'),

    // ── Localisation (ADR-0008: storage is always UTC; this is policy + display) ──
    APP_TIMEZONE: ianaTimezone.default('Asia/Tehran'),
    APP_LOCALE: z.string().min(2).default('fa-IR'),

    // ── Telegram — required from M2, and always in production (ADR-0004) ──────
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d{6,}:[A-Za-z0-9_-]{30,}$/, 'must look like a BotFather token (<digits>:<secret>)')
      .optional(),
    TELEGRAM_WEBHOOK_SECRET_PATH: z.string().min(16).optional(),
    TELEGRAM_WEBHOOK_SECRET_TOKEN: z.string().min(16).optional(),
    TELEGRAM_MODE: z.enum(['webhook', 'polling']).default('polling'),
    TELEGRAM_CHANNEL_ID: z.string().optional(),

    // ── Cryptography — required from M2/M8, and always in production ──────────
    CHAT_ENCRYPTION_KEY: base64Key(32).optional(),
    PII_HASH_PEPPER: base64Key(32).optional(),
    JWT_ACCESS_SECRET: z.string().min(32).optional(),
    JWT_REFRESH_SECRET: z.string().min(32).optional(),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('7d'),

    // ── Media ────────────────────────────────────────────────────────────────
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./uploads'),
    MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5_242_880),

    // ── Safety rails ─────────────────────────────────────────────────────────
    ALLOW_PROD_SEED: booleanFlag.default(false),
  })

  // ADR-0004: polling is a local-development convenience. In production the bot
  // must be webhook-driven, so this combination is refused outright rather than
  // quietly degrading to a mode nobody intended to deploy.
  .refine((env) => !(env.NODE_ENV === 'production' && env.TELEGRAM_MODE === 'polling'), {
    path: ['TELEGRAM_MODE'],
    message: 'must be "webhook" when NODE_ENV=production (polling is development-only)',
  })

  // M17 seeds production only behind this flag *and* an interactive confirmation.
  // Having the flag on by default in a production image would defeat both.
  .refine((env) => !(env.NODE_ENV === 'production' && env.ALLOW_PROD_SEED), {
    path: ['ALLOW_PROD_SEED'],
    message: 'must not be enabled by default in production; set it only for the duration of a seed',
  });

/**
 * Variables that are optional while developing but mandatory in production.
 * Keeping this as data rather than a wall of `.refine()` calls means adding one
 * in a later milestone is a single line, and the error message stays uniform.
 */
const requireInProduction = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET_PATH',
  'TELEGRAM_WEBHOOK_SECRET_TOKEN',
  'CHAT_ENCRYPTION_KEY',
  'PII_HASH_PEPPER',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const satisfies readonly (keyof z.infer<typeof envSchema>)[];

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      [
        'Invalid environment configuration. The process will not start.',
        ...problems.map((p) => `  - ${p}`),
        '',
        'See .env.example for the expected shape of each variable.',
      ].join('\n'),
    );
    this.name = 'EnvValidationError';
  }
}

/**
 * Parse and validate the environment.
 *
 * Throws {@link EnvValidationError} listing every problem found, so a misconfigured
 * deployment is fixed in one pass instead of one restart per missing variable.
 *
 * Never logs values — only variable names and the reason they were rejected. Several
 * of these are credentials (ADR-0009, T15).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // In a .env file an empty assignment (`TELEGRAM_BOT_TOKEN=`) means "not set", but
  // it reaches us as a present empty string, which would then be validated against
  // the variable's format and fail. Treat blank as absent so optional variables can
  // actually be left blank — which is how .env.example ships them.
  const normalized: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = envSchema.safeParse(normalized);

  const problems: string[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      problems.push(`${name}: ${issue.message}`);
    }
    throw new EnvValidationError(problems);
  }

  const env = result.data;

  if (env.NODE_ENV === 'production') {
    for (const key of requireInProduction) {
      if (env[key] === undefined) {
        problems.push(`${key}: is required when NODE_ENV=production`);
      }
    }
    if (problems.length > 0) {
      throw new EnvValidationError(problems);
    }
  }

  return env;
}
