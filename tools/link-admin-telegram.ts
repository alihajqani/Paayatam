import { createInterface } from 'node:readline/promises';
import { loadEnv } from '@payetam/config';
import { PrismaService } from '@payetam/db';
import {
  AdminAccessService,
  AdminCredentials,
  AdminTelegramService,
  AuditService,
  BOT_PERMISSIONS,
  permissionsFor,
  type RoleKey,
} from '@payetam/domain';
import { RedisService, SystemClock } from '@payetam/platform';

/**
 * Give a moderator the bot's queue, or take it away (v0.6.3, ADR-0018).
 *
 *   pnpm link-admin-telegram --by boss@example.com \
 *     --email mod@example.com --telegram 573914882 \
 *     --reason 'on-call moderation from a phone'
 *   pnpm link-admin-telegram --by boss@example.com \
 *     --email mod@example.com --revoke --reason 'left the team'
 *
 * `--by` is the admin granting it and must hold `role.manage`; `--email` is the
 * moderator being granted. **Two people, never one**: this is a capability
 * grant, and ADR-0010's fourth rule is that nobody grants themselves one.
 *
 * ── Why this is a script and not a screen ────────────────────────────────────
 *
 * The same reason `create-admin` is. This grants a Telegram account the ability
 * to act as staff, and ADR-0010's second decision — *"admin access does not
 * follow from a staff member's personal Telegram being taken over"* — is exactly
 * what it qualifies. A capability of that shape should be **hard to grant and
 * easy to audit**, and a script somebody has to run on a server with the
 * database URL in front of them is both. A panel button would make it a
 * two-click action for anybody who has a session open on a shared machine.
 *
 * It is also the surface with the least to leak. `telegram_user_id` is invariant
 * 7's column: it never appears in an API response, a log line or a frontend
 * bundle, and adding an admin endpoint that took one as a parameter would put it
 * in request logs, browser history and a Vue bundle at once.
 *
 * ── What the link actually buys, in full ─────────────────────────────────────
 *
 * The linked Telegram account can open the moderation queue in the bot and
 * decide cases. Nothing else: `BOT_PERMISSIONS` is a hard-coded allowlist, and
 * the session the bot builds is the admin's real permissions **intersected**
 * with it. A `SUPER_ADMIN` on the bot is a moderator and no more — no coin
 * adjustment, no Trust Score, no chat unseal, no role change, no ban, no
 * setting.
 *
 * Revocation takes effect on the moderator's very next tap: the session is
 * derived per update and there is nothing cached to outlive the delete.
 *
 * ── Why the services are constructed by hand ─────────────────────────────────
 *
 * `tsx` transpiles with esbuild, which does not emit `emitDecoratorMetadata`, so
 * Nest's constructor injection yields `undefined` for every parameter — the
 * failure ADR-0013 records, and the reason nothing in this repository runs a
 * Nest app under `tsx`. Same workaround as `create-admin.ts`, same four lines.
 */

interface Args {
  /** The moderator being granted or revoked. */
  email: string;
  /** The admin doing it, who must hold `role.manage`. */
  by: string;
  telegramUserId: bigint | null;
  reason: string;
  revoke: boolean;
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  let email = '';
  let by = '';
  let telegram = '';
  let reason = '';
  let revoke = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--email':
        email = value ?? '';
        i += 1;
        break;
      case '--by':
        by = value ?? '';
        i += 1;
        break;
      case '--telegram':
        telegram = value ?? '';
        i += 1;
        break;
      case '--reason':
        reason = value ?? '';
        i += 1;
        break;
      case '--revoke':
        revoke = true;
        break;
      default:
        if (flag !== undefined && flag.startsWith('--')) fail(`unknown argument: ${flag}`);
    }
  }

  if (email === '' || !email.includes('@')) fail('--email is required, and must be an address');
  if (by === '' || !by.includes('@')) {
    fail('--by is required: the admin granting this, who must hold role.manage.');
  }
  // Nobody grants themselves a capability. ADR-0010's fourth rule, applied to a
  // grant that is not a role change but is exactly the same kind of decision.
  if (by.trim().toLowerCase() === email.trim().toLowerCase()) {
    fail('--by and --email must be two different accounts.');
  }
  // The same bar the service sets, restated so the refusal arrives before the
  // connection rather than after it.
  if (reason.trim().length < 3) {
    fail('--reason is required. A capability nobody explained is not reviewable later.');
  }

  if (revoke) return { email, by, telegramUserId: null, reason, revoke };

  if (!/^\d{1,19}$/.test(telegram)) {
    fail('--telegram is required, and is the numeric Telegram user id (not a @username).');
  }
  return { email, by, telegramUserId: BigInt(telegram), reason, revoke };
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
 * The production rail, the same one every other write script goes through.
 *
 * A yes/no prompt is answered reflexively; the mistake worth catching is
 * somebody who does mean to grant this but is pointed at the wrong database.
 */
async function confirm(isProduction: boolean, word: string): Promise<void> {
  if (!isProduction || !process.stdin.isTTY) return;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`  Type '${word}' to continue: `);
    if (answer.trim() !== word) fail('Aborted. Nothing was written.');
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();

  const prisma = new PrismaService(env);
  const clock = new SystemClock();
  const redis = new RedisService(env);
  const credentials = new AdminCredentials(env);
  const audit = new AuditService(prisma, clock);
  const access = new AdminAccessService(prisma, clock, redis, credentials, audit);
  const links = new AdminTelegramService(prisma, access, audit);

  try {
    await prisma.$connect();

    const subject = await prisma.adminUser.findUnique({
      where: { email: args.email.trim() },
      select: {
        id: true,
        displayName: true,
        status: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });
    if (!subject) fail(`No staff account with the address ${args.email}.`);

    /**
     * The granter, built into a real session.
     *
     * `link` asserts `role.manage` in the service layer — invariant 12, and the
     * reason it is asserted *there* rather than here is that the check has to
     * hold for every caller, including this one. Running the script on a server
     * with the database URL is the authentication; the permission check is what
     * makes the authorisation the same rule the panel obeys, and the audit row
     * then names a real staff account rather than a synthetic one.
     *
     * The granter is **not** asked for a password or a TOTP code, and that is
     * the honest boundary of this script: whoever can run it already holds the
     * database. What it buys over a raw `INSERT` is the permission check, the
     * audit row, the uniqueness refusals and the reason — every one of which a
     * hand-written statement would skip.
     */
    const granter = await prisma.adminUser.findUnique({
      where: { email: args.by.trim() },
      select: {
        id: true,
        displayName: true,
        status: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });
    if (!granter) fail(`No staff account with the address ${args.by}.`);
    if (granter.status !== 'ACTIVE') fail(`${args.by} is not an active account.`);

    const granterRoles = granter.roles.map((row) => row.role.key as RoleKey);
    const session = {
      adminUserId: granter.id,
      email: args.by,
      displayName: granter.displayName,
      roles: granterRoles,
      permissions: permissionsFor(granterRoles),
    };

    const roles = subject.roles.map((row) => row.role.key as RoleKey);
    const permissions = permissionsFor(roles);

    const target = describeTarget(env.DATABASE_URL);

    if (args.revoke) {
      console.error(`\n  Revoking the bot moderation queue on ${target}`);
      console.error(`    account : ${args.email}`);
      console.error(`    by      : ${args.by}\n`);
      await confirm(env.NODE_ENV === 'production', 'revoke');

      await links.unlink(session, subject.id, args.reason);
      console.log(
        [
          '',
          '  ✓ Link removed.',
          '    It stops working on their next tap — the session is derived per',
          '    update and nothing is cached.',
          '',
        ].join('\n'),
      );
      return;
    }

    console.error(`\n  Granting the bot moderation queue on ${target}`);
    console.error(`    account : ${args.email} (${subject.displayName})`);
    console.error(`    roles   : ${roles.join(', ') || '(none)'}`);
    console.error(`    by      : ${args.by}\n`);
    console.error('  What this grants in the bot, and nothing more:');
    for (const permission of BOT_PERMISSIONS) {
      console.error(
        `    · ${permission}${permissions.includes(permission) ? '' : '  (not held — no effect)'}`,
      );
    }
    console.error('');

    await confirm(env.NODE_ENV === 'production', 'link');

    await links.link(session, {
      adminUserId: subject.id,
      telegramUserId: args.telegramUserId ?? 0n,
      reason: args.reason,
    });

    console.log(
      [
        '',
        '  ✓ Linked.',
        '    The moderation button appears on their persistent menu the next time',
        '    the bot sends them a message; /moderate works immediately.',
        '',
        '  The Telegram id is not printed back, and is not in the audit row:',
        '  invariant 7 has no exception for a log line.',
        '',
      ].join('\n'),
    );
  } finally {
    await prisma.$disconnect();
    redis.client.disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
