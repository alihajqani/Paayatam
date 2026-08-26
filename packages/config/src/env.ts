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
    /**
     * Which release this process is (M22 phase 10).
     *
     * The same variable `docker/docker-compose.prod.yml` already tags every image
     * with, read here so the API can *say* which one it is over `GET
     * /api/v1/version`. Deliberately not validated harder than "a string": the
     * shape rule lives in `resolveVersion()` in `@payetam/shared`, which the two
     * bundles also call — a release string that is legal on the server and refused
     * in the browser would be the worst of both.
     *
     * Never required, in any environment. A deployment that forgot to export it
     * reports `local`, which is a wrong answer to "which release is this" and a
     * far better outcome than an API that will not boot over a label.
     */
    PAYETAM_VERSION: z.string().optional(),

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
    /** Only used to build the deep link in a channel post (M14). */
    TELEGRAM_BOT_USERNAME: z.string().optional(),

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

    // ── Deployment topology (M20) ────────────────────────────────────────────
    /**
     * Which upstream hops may set `X-Forwarded-For`.
     *
     * Unset means "trust nothing", which is correct for a process reached
     * directly and **wrong for every reverse-proxied deployment**: Fastify then
     * reports the proxy's own address as `request.ip`, and three things quietly
     * break at once. The IP rate-limit buckets collapse into one shared bucket,
     * so `AUTH`'s 30-a-minute becomes a global cap that the product's own users
     * exhaust (M20 found this while writing the production compose stack). Every
     * `ip_hash` in `audit_log` becomes the same hash, which is the column that
     * exists to tell one abuser from another. And `/metrics` — which refuses
     * anything that is not a private address — starts seeing a private address
     * on every request, including the ones from the internet.
     *
     * Accepted forms are `proxy-addr`'s, because that is what Fastify hands it to:
     * a hop count (`1`), a comma-separated list of addresses or CIDR blocks
     * (`172.18.0.0/16`), or one of the names `loopback`, `linklocal`, `uniquelocal`.
     *
     * **Never "trust everything".** `true` would believe whatever
     * `X-Forwarded-For` says, which lets any client choose its own apparent
     * address and hands an attacker the rate limiter and the audit trail
     * together. A count is fine — `1` means "the one hop in front of me" — and
     * that is the value refused here, in the spelling that means *all*.
     */
    TRUST_PROXY: z
      .string()
      .min(1)
      .refine((value) => !['true', 'yes', 'on', 'all', '*'].includes(value.trim().toLowerCase()), {
        message:
          'must name the trusted hops — a CIDR list (172.28.0.0/24), a hop count (1), ' +
          'or "loopback". Trusting every hop lets any client forge X-Forwarded-For.',
      })
      .optional(),

    // ── Monitoring (M20) ─────────────────────────────────────────────────────
    /**
     * Chat the worker posts operational alerts to. A group id is negative.
     *
     * Optional everywhere, including production: a deployment with no alerting
     * channel is a worse deployment, not a broken one, and failing to boot over
     * it would take the product down for the sake of its own monitoring.
     */
    MONITORING_CHAT_ID: z.string().optional(),
    /**
     * Shortest gap between two alerts about the same thing.
     *
     * The failure this exists for is a queue that has started failing every job:
     * without a floor, the alerting path becomes the amplifier, and the group
     * fills with the same line until Telegram rate-limits the bot and the *next*
     * incident is the one nobody hears about.
     */
    MONITORING_ALERT_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(300),
    /**
     * The kill switch, separate from "is it configured" (M22 phase 7).
     *
     * `MONITORING_CHAT_ID` being unset means an operator has not set alerting up.
     * This means one has, and wants it off **right now** — during a planned
     * migration, or when a known-noisy incident is already being worked. Two
     * different states with two different fixes, and collapsing them would mean
     * silencing alerts required deleting the destination and remembering to put it
     * back.
     */
    MONITORING_ENABLED: booleanFlag.default(true),
    /**
     * The floor on what reaches Telegram.
     *
     * `warn` by default, so an informational line stays in the structured log
     * where it can be searched without also being an interruption. Set to `error`
     * during a noisy period, or to `info` while commissioning a deployment.
     */
    MONITORING_MIN_LEVEL: z.enum(['info', 'warn', 'error']).default('warn'),
    /**
     * Which environment an alert says it came from.
     *
     * Defaults to `NODE_ENV`. Named separately because two deployments can share a
     * `NODE_ENV` of `production` and be entirely different systems — and an alert
     * that does not say which one it is about is an alert somebody has to guess at.
     */
    MONITORING_ENVIRONMENT: z.string().min(1).optional(),

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
