import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOT_COMMANDS, helpCommandLines } from './commands';
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
  return new Set([...body.slice(0, end).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] as string));
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
   * Telegram offers a Start button of its own; spending a menu line on it again
   * is the first line of a short list gone.
   */
  it('does not advertise /start', () => {
    expect(BOT_COMMANDS.map((c) => c.command)).not.toContain('start');
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
