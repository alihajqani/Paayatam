import { createInterface } from 'node:readline/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@payetam/db';

/**
 * The production rail every seed script passes through (plan §9 M17).
 *
 * The plan states it precisely: *"the seed script refuses to run when
 * `NODE_ENV=production` unless `ALLOW_PROD_SEED=1` **AND** an interactive typed
 * confirmation is given, and it writes an audit row"*. All three parts matter and
 * each defends against a different mistake:
 *
 *  - **The flag** stops a seed that runs by accident — a deploy script that calls
 *    `pnpm seed` because staging needed it once.
 *  - **The typed confirmation** stops a seed that runs *on purpose against the wrong
 *    database*. It is the only control here that requires a human to have read
 *    which database they are pointed at, which is the actual failure: `DATABASE_URL`
 *    left over in a shell from an hour ago.
 *  - **The audit row** makes it answerable afterwards. Seeded data that appears in
 *    production with nothing recording how is indistinguishable from a compromise,
 *    and somebody will have to prove which it was.
 *
 * Until M17 each of the four seed scripts carried its own half of this: a flag check,
 * no confirmation, no audit row. One shared gate rather than five copies, because a
 * rail that has to be remembered per script is a rail the fifth script will not have.
 *
 * **`loadEnv()` is deliberately not used here.** `env.ts` *refuses* the combination
 * `NODE_ENV=production` + `ALLOW_PROD_SEED=1`, which is right for the API and the
 * worker — a flag baked into a production image defeats the first control above, and
 * a flag left set after a seed then fails the next deploy loudly instead of sitting
 * there enabled. That refusal must not extend to the seed itself, so this reads
 * `process.env` directly. The asymmetry is the design, not an oversight.
 */

export interface SeedContext {
  prisma: PrismaClient;
  /** What to record in the audit row, e.g. `seed.events`. */
  action: string;
  /** Released by `finish`. */
  finish: (summary: Record<string, unknown>) => Promise<void>;
}

export interface SeedOptions {
  /**
   * Skip the flag and the confirmation, keeping the audit row.
   *
   * For seeds that are **deploy steps** rather than content: `seed-rbac` derives
   * `role` and `permission` from a catalogue in code, has to run on every deploy, and
   * an interactive prompt in front of it would either break the deploy or teach
   * somebody to pipe an answer at it. The audit row still matters — changing what
   * staff can do in production without a record is precisely what invariant 12
   * exists to prevent — so this drops two of the three controls and keeps that one.
   *
   * Nothing that writes user-visible content may use this.
   */
  unattended?: boolean;
}

/**
 * Open a seeded-database session, or exit.
 *
 * Returns a Prisma client and a `finish` that writes the audit row and disconnects.
 * The audit row is written at the **end**, with a summary of what was actually
 * created — a row written up front would record an intent rather than an outcome,
 * and the interesting case is a seed that half-succeeded.
 */
export async function openSeed(
  action: string,
  describe: string,
  options: SeedOptions = {},
): Promise<SeedContext> {
  const isProduction = process.env['NODE_ENV'] === 'production';
  const connectionString = process.env['DATABASE_URL'];

  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  if (isProduction && options.unattended !== true) {
    if (process.env['ALLOW_PROD_SEED'] !== '1') {
      console.error(
        `Refusing to run ${action} in production.\n` +
          `${describe}\n` +
          'Set ALLOW_PROD_SEED=1 for the duration of this command if you really mean it.',
      );
      process.exit(1);
    }
    await confirmInteractively(action, connectionString);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  return {
    prisma,
    action,
    finish: async (summary: Record<string, unknown>) => {
      await writeAuditRow(prisma, action, summary, isProduction);
      await prisma.$disconnect();
    },
  };
}

/**
 * Require the operator to type the database name.
 *
 * Not `y/n`. A yes/no prompt is answered reflexively, and the mistake this exists to
 * catch is somebody who *does* mean to seed but is pointed at the wrong database —
 * a `DATABASE_URL` still exported in a shell from an hour ago. Typing the name is
 * the cheapest way to make them read it.
 *
 * Refuses outright when stdin is not a TTY, which is what makes "interactive" true:
 * `yes | pnpm seed:events` and a CI job with no terminal both fail here rather than
 * sailing through. That is the whole point of the word in the plan.
 */
async function confirmInteractively(action: string, connectionString: string): Promise<void> {
  const database = databaseNameOf(connectionString);

  if (!process.stdin.isTTY) {
    console.error(
      `Refusing to run ${action}: production seeding needs an interactive terminal.\n` +
        'Piping a confirmation is not a confirmation.',
    );
    process.exit(1);
  }

  console.warn(
    `\nAbout to run ${action} against a PRODUCTION database.\n` +
      `  database: ${database}\n` +
      `  host:     ${hostOf(connectionString)}\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Type the database name (${database}) to continue: `);
    if (answer.trim() !== database) {
      console.error('Confirmation did not match. Nothing was written.');
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

/**
 * The audit row.
 *
 * `actorType: 'SYSTEM'` with the operating user in the payload, because `actor_id`
 * references `admin_user` and whoever runs a seed from a shell has no row there.
 * Recording the shell user in `after` is weaker evidence than an admin id and it is
 * what is actually available; claiming more precision than exists would be worse.
 *
 * A failure to write this is **fatal**, not a warning. The row is a requirement of
 * the rail, so a seed that ran without one has not satisfied the rail — and the
 * operator needs to know that now rather than during an incident review.
 */
async function writeAuditRow(
  prisma: PrismaClient,
  action: string,
  summary: Record<string, unknown>,
  isProduction: boolean,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action,
      targetType: 'database',
      after: {
        ...summary,
        environment: isProduction ? 'production' : (process.env['NODE_ENV'] ?? 'development'),
        // `USER`/`USERNAME` rather than anything cleverer: this is provenance, not
        // authentication, and it is the only identity a shell hands us.
        operator: process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown',
        seededAt: new Date().toISOString(),
      },
    },
  });
}

/** `postgresql://user:pw@host:5432/payetam?schema=public` → `payetam`. */
export function databaseNameOf(connectionString: string): string {
  try {
    const path = new URL(connectionString).pathname;
    return path.startsWith('/') ? path.slice(1) : path;
  } catch {
    return '(unparseable)';
  }
}

/** Host and port, for the confirmation prompt. Never the password. */
export function hostOf(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  } catch {
    return '(unparseable)';
  }
}
