import { loadEnv } from '@payetam/config';
import { BOT_COMMANDS } from '@payetam/telegram';

/**
 * Publish the bot's command list to Telegram (`setMyCommands`).
 *
 *   pnpm set-bot-commands           # register what BOT_COMMANDS says
 *   pnpm set-bot-commands --info    # read back what Telegram currently has
 *   pnpm set-bot-commands --delete  # empty the menu
 *
 * ── Why this is a deploy step and not a boot step ────────────────────────────
 *
 * `setMyCommands` is bot *configuration*, in the same class as `setWebhook` and
 * registered the same way — by a script somebody runs, not by the API on start.
 * Doing it at boot would call Telegram once per container per restart, from a
 * process invariant 11 says makes no direct Telegram calls, to write a value that
 * changes about twice a year. It is also global to the bot rather than per
 * deployment, so two environments sharing a token would fight over it on every
 * rolling restart.
 *
 * ── Why the list is imported rather than written here ────────────────────────
 *
 * `BOT_COMMANDS` is the same array `/help` renders from and `commands.test.ts`
 * checks against the dispatch switch. A copy in this file would be a fourth
 * place to add a command and the first one to be forgotten — which is how the
 * menu came to be empty in the first place.
 *
 * ── The failure that matters ─────────────────────────────────────────────────
 *
 * Telegram validates the whole array and rejects all of it for one bad entry, so
 * a malformed description publishes *nothing* rather than the rest. The shape is
 * asserted in `commands.test.ts`; the response is checked here rather than
 * assumed, because `ok: false` arrives as HTTP 200.
 *
 * The token never reaches a command line — `ps` is world-readable — so this reads
 * it from the environment, exactly as the seeds do.
 */

type Mode = 'set' | 'info' | 'delete';

function parseMode(argv: readonly string[]): Mode {
  if (argv.includes('--info')) return 'info';
  if (argv.includes('--delete')) return 'delete';
  return 'set';
}

interface TelegramResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

async function call(token: string, method: string, body: unknown): Promise<TelegramResponse> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // `ok: false` comes back as HTTP 200 with a description, so the body is what
  // decides — a `response.ok` check here would call a rejected array a success.
  return (await response.json()) as TelegramResponse;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token === '') {
    console.error('TELEGRAM_BOT_TOKEN is not set.');
    process.exitCode = 1;
    return;
  }

  const mode = parseMode(process.argv.slice(2));

  if (mode === 'info') {
    const current = await call(token, 'getMyCommands', {});
    console.log(JSON.stringify(current.result, null, 2));
    return;
  }

  const commands = mode === 'delete' ? [] : BOT_COMMANDS;
  const result = await call(token, 'setMyCommands', { commands });

  if (!result.ok) {
    console.error(`setMyCommands failed: ${result.description ?? 'unknown error'}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    commands.length === 0
      ? 'Command menu cleared.'
      : `Registered ${String(commands.length)} commands: ${commands
          .map((c) => `/${c.command}`)
          .join(' ')}`,
  );
}

void main().catch((error: unknown) => {
  console.error(`setMyCommands failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
