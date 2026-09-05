import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOT_COMMANDS,
  COMMAND_GROUPS,
  commandGroupFor,
  describeCommand,
  helpCommandLines,
} from './commands';
import { TEMPLATES, render } from './templates';

/**
 * The dispatch `switch` in `BotService.onCommand`, read as text.
 *
 * Reading the source rather than importing the service is deliberate: `BotService`
 * lives in `apps/api` and pulls in Nest, Prisma and the queue, and this package
 * must not depend on any of them to answer a question about a list of strings.
 * The regex is anchored on the `case '<name>':` shape the file has used since the
 * first command, and the test below fails loudly if it ever matches nothing.
 *
 * Resolved from `process.cwd()` — the repo root, where `vitest.config.mts` is —
 * rather than from `import.meta.url`, which this package's CommonJS `module`
 * setting rejects at typecheck even though Vite supplies it at runtime. A wrong
 * cwd is not a silent pass: the empty-set assertion below turns it into a
 * failure.
 */
function dispatchedCommands(): Set<string> {
  const source = readFileSync(
    resolve(process.cwd(), 'apps/api/src/telegram/bot.service.ts'),
    'utf8',
  );
  const body = source.slice(source.indexOf('private async onCommand'));
  const end = body.indexOf('private async onStart');
  const cases = new Set(
    [...body.slice(0, end).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] as string),
  );

  /**
   * `/start` is dispatched a layer earlier and by a different mechanism (v0.9.1).
   *
   * `route()` matches it as a `START` *intent* rather than as a `case` in
   * `onCommand`, because it is the one surface allowed to create an account —
   * every other command requires a user that already exists. So the switch scan
   * above cannot see it, and reading `route()` for the intent is what keeps this
   * test an assertion about real dispatch rather than a hard-coded exception.
   */
  if (/case 'START':\s*\n\s*return this\.onStart\(/.test(source)) cases.add('start');
  return cases;
}

describe('BOT_COMMANDS', () => {
  /** Telegram rejects the whole array for one bad entry, publishing none of them. */
  it('satisfies Telegram’s setMyCommands constraints', () => {
    for (const { command, description } of BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThanOrEqual(3);
      expect(description.length).toBeLessThanOrEqual(256);
    }
  });

  it('lists each command once', () => {
    const names = BOT_COMMANDS.map((c) => c.command);

    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * `/start` is advertised, and used not to be (v0.9.1).
   *
   * The old reasoning was that Telegram offers a Start button of its own. It
   * does — on an *empty* chat, which is not where anybody needs it. Once there
   * is a conversation the button is gone, and the release announcement sent on
   * every deploy tells people to press `/start`. Omitting it made the product
   * ask for something its own menu did not offer.
   */
  it('advertises /start, first', () => {
    expect(BOT_COMMANDS[0]?.command).toBe('start');
  });

  /**
   * The point of the module. A command in the menu that the switch does not
   * handle answers «این فرمان را نمی‌شناسم» to somebody who tapped it from a
   * list the product itself published.
   */
  it('advertises only commands the bot actually dispatches', () => {
    const dispatched = dispatchedCommands();

    // Guards the regex above: an empty set would make this test vacuous.
    expect(dispatched.size).toBeGreaterThan(0);
    for (const { command } of BOT_COMMANDS) {
      expect(dispatched).toContain(command);
    }
  });

  it('renders every command into the help text', () => {
    const help = render(TEMPLATES.BOT_HELP, {});

    for (const { command, description } of BOT_COMMANDS) {
      expect(help?.text).toContain(`/${command}`);
      expect(help?.text).toContain(description);
    }
  });

  it('renders one help line per command', () => {
    expect(helpCommandLines().split('\n')).toHaveLength(BOT_COMMANDS.length);
  });
});

/**
 * The menu is only useful if it is complete.
 *
 * A command that dispatches, is advertised to Telegram and appears in no group
 * is one that can be typed and never found — which is the failure the grouping
 * exists to fix, reintroduced silently the next time somebody adds a command.
 */
describe('the command menu', () => {
  it('places every command in exactly one group', () => {
    const grouped = COMMAND_GROUPS.flatMap((group) => group.commands);

    expect([...grouped].sort()).toEqual(BOT_COMMANDS.map((entry) => entry.command).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('gives every grouped command a label to render', () => {
    for (const group of COMMAND_GROUPS) {
      for (const command of group.commands) {
        expect(describeCommand(command)).not.toBeNull();
      }
    }
  });

  it('resolves a group by its callback key, and nothing else', () => {
    for (const group of COMMAND_GROUPS) {
      expect(commandGroupFor(group.key)).toEqual(group);
    }
    expect(commandGroupFor('nope')).toBeNull();
  });

  /** The keys ride in `callback_data`, which is capped at sixty-four bytes. */
  it('keeps the group keys short and unique', () => {
    const keys = COMMAND_GROUPS.map((group) => group.key);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9_]{1,8}$/);
  });
});
