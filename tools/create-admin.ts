import { createInterface } from 'node:readline/promises';
import { loadEnv } from '@payetam/config';
import { PrismaService } from '@payetam/db';
import {
  AdminAccessService,
  AdminCredentials,
  AuditService,
  MIN_PASSWORD_LENGTH,
  ROLE_KEYS,
  type RoleKey,
} from '@payetam/domain';
import { RedisService, SystemClock } from '@payetam/platform';

/**
 * Create a staff account (M20).
 *
 *   pnpm create-admin --email you@example.com --name 'Your Name' --roles SUPER_ADMIN
 *
 * There is no self-service sign-up and there is not going to be one: `admin_user`
 * has no foreign key to `user`, and that separation is the security control — a
 * privilege-escalation bug in user-facing code cannot become an admin compromise,
 * and admin access does not follow from a staff member's personal Telegram being
 * taken over (ADR-0010).
 *
 * `docs/admin-panel.md` used to describe this step as *"from a `tsx` script or a
 * REPL, call `createAdmin`"*. That is a description of a thing to write, not a
 * procedure — and it is the first thing anybody has to do on a new deployment.
 * This is that script.
 *
 * ── Why the services are constructed by hand ─────────────────────────────────
 *
 * `AdminAccessService.createAdmin` is called rather than reimplemented: it
 * generates the TOTP secret, hashes the password, creates the row, grants the
 * roles and writes the audit entry **in one transaction**, and a second copy of
 * that would drift from the first.
 *
 * It cannot be resolved from a Nest container here, though. `tsx` transpiles with
 * esbuild, which does not emit `emitDecoratorMetadata`, so Nest's constructor
 * injection yields `undefined` for every parameter — the failure ADR-0013 records,
 * and the reason nothing in this repository runs a Nest app under `tsx`. The
 * decorators are inert when the constructor is called directly, so the five
 * dependencies are built explicitly below. That is the whole of the workaround.
 *
 * ── What it will not do ──────────────────────────────────────────────────────
 *
 * **The password is never an argument.** `ps` is world-readable, and a password on
 * a command line is also in the shell history of whoever typed it. It is read from
 * the terminal, twice, or from stdin when piped.
 *
 * **The TOTP secret is printed exactly once.** It is encrypted at rest under
 * `CHAT_ENCRYPTION_KEY` and no endpoint returns it again. Lose it before it is in
 * an authenticator and the account has to be deleted and made afresh.
 */

interface Args {
  email: string;
  name: string;
  roles: RoleKey[];
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  let email = '';
  let name = '';
  let roles: RoleKey[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--email':
        email = value ?? '';
        i += 1;
        break;
      case '--name':
        name = value ?? '';
        i += 1;
        break;
      case '--roles':
        roles = (value ?? '')
          .split(',')
          .map((role) => role.trim().toUpperCase())
          .filter((role) => role !== '') as RoleKey[];
        i += 1;
        break;
      case '--password':
        fail(
          '--password is refused. A password on a command line is in `ps` and in your shell history; it is asked for on the terminal instead.',
        );
      // eslint-disable-next-line no-fallthrough -- `fail` returns never
      default:
        if (flag !== undefined && flag.startsWith('--')) fail(`unknown argument: ${flag}`);
    }
  }

  if (email === '' || !email.includes('@')) fail('--email is required, and must be an address');
  if (name === '') fail('--name is required — it is what the panel shows beside an action');

  const known = Object.values(ROLE_KEYS);
  if (roles.length === 0) fail(`--roles is required. One or more of: ${known.join(', ')}`);
  for (const role of roles) {
    if (!known.includes(role)) fail(`unknown role '${role}'. Known roles: ${known.join(', ')}`);
  }

  return { email, name, roles };
}

/** Host and database from a connection string, with the credentials left out. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port === '' ? '5432' : parsed.port}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * The confirmation and the password, on one readline interface.
 *
 * One interface and not several: `close()` releases stdin, so a second
 * `createInterface` after a close reads from a stream that is already ended — and
 * a piped invocation then blocks on a prompt nobody is there to answer.
 *
 * Prompts go to **stderr** so that stdout carries only the result. That is what
 * makes `create-admin … > secret.txt` do something sensible.
 */
async function collectSecrets(isProduction: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    // The same rail every production write goes through (tools/seed-guard.ts),
    // and for the same reason: a yes/no prompt is answered reflexively, and the
    // mistake worth catching is somebody who does mean to create an admin but is
    // pointed at the wrong database.
    if (isProduction && process.stdin.isTTY) {
      const answer = await rl.question("  Type 'create' to continue: ");
      if (answer.trim() !== 'create') fail('Aborted. Nothing was written.');
    }

    if (!process.stdin.isTTY) {
      // Piped, for an automated provisioning step. Still not an argument.
      return (await rl.question('')).replace(/\r?\n$/, '');
    }

    const password = await rl.question(`  Password (${MIN_PASSWORD_LENGTH}+ characters): `);
    const again = await rl.question('  Again: ');
    if (password !== again) fail('The two passwords do not match.');
    return password;
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Validates the whole environment, which is what guarantees
  // `CHAT_ENCRYPTION_KEY` is present and decodes to 32 bytes. Without that check
  // here, `AdminCredentials` throws in its own constructor with a message about a
  // variable rather than about what this script was trying to do.
  const env = loadEnv();

  console.error(`\n  Creating a staff account on ${describeTarget(env.DATABASE_URL)}`);
  console.error(`    email : ${args.email}`);
  console.error(`    name  : ${args.name}`);
  console.error(`    roles : ${args.roles.join(', ')}\n`);

  const password = await collectSecrets(env.NODE_ENV === 'production');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`The password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
  }

  const prisma = new PrismaService(env);
  const clock = new SystemClock();
  // Unused by `createAdmin` — it is a constructor dependency of the service, for
  // the session store the login path uses. Built rather than faked, so this file
  // does not encode an assumption about internals that could quietly stop holding.
  const redis = new RedisService(env);
  const credentials = new AdminCredentials(env);
  const audit = new AuditService(prisma, clock);
  const admins = new AdminAccessService(prisma, clock, redis, credentials, audit);

  try {
    await prisma.$connect();

    const { adminUserId, totpSecret } = await admins.createAdmin({
      email: args.email,
      password,
      displayName: args.name,
      roles: args.roles,
    });

    const issuer = 'PayeTam';
    const label = encodeURIComponent(`${issuer}:${args.email}`);
    console.log(
      [
        '',
        '  ✓ Account created.',
        `    id    : ${adminUserId}`,
        `    email : ${args.email}`,
        `    roles : ${args.roles.join(', ')}`,
        '',
        '  ── The TOTP secret. Shown once, and never again ─────────────────────',
        '',
        `    ${totpSecret}`,
        '',
        `    otpauth://totp/${label}?secret=${totpSecret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
        '',
        '  Put it in an authenticator now, and sign in once to confirm it works',
        '  before you close this terminal. It is encrypted at rest and no endpoint',
        '  returns it — losing it means deleting this account and making another.',
        '',
        '  If the panel 403s on a screen these roles should reach, run',
        '  `pnpm seed:rbac`: a role named in code but missing from the table is',
        '  exactly what that looks like.',
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
    // `disconnect`, not the service's `quit`: nothing was sent, and `quit` waits
    // for a connection that may never have been established — which would hang a
    // script that has already done its work.
    redis.client.disconnect();
  }
}

void main().catch((error: unknown) => {
  // The message, never the stack: this runs with a password in memory and an
  // operator watching the terminal.
  console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
