import { describe, expect, it } from 'vitest';
import {
  MAIN_MENU_LABEL,
  MENU_COMMANDS,
  MODERATION_MENU_LABEL,
  mainMenuReplyKeyboard,
  menuCommandFor,
  menuGroupKeyFor,
  menuLabelFor,
  menuPathFor,
} from './keyboards';
import { TEMPLATES, render } from './templates';
import { BOT_COMMANDS, COMMAND_GROUPS, commandGroupFor } from './commands';

/**
 * The bottom keyboard is one button now (v0.8.1); its resolver still knows eight.
 *
 * v0.7.0 removed all seven labels and sent `remove_keyboard` on everything;
 * v0.8.1 puts «☰ منوی اصلی» back, alone, on the messages that have no inline
 * keyboard of their own. Neither release lets the map shrink, and the reason is
 * unchanged: a reply keyboard lives on the *client* until a message replaces it,
 * so until a user hears from this build they are still holding whichever one
 * they were given. A label this build could not resolve would fall through
 * `onText` — and before v0.8.0, into an anonymous chat, where a stranger would
 * receive «📨 درخواست‌های من». That is what this suite protects.
 */
describe('the bottom keyboard resolves every label it has ever drawn', () => {
  /** Report: `/profile` was reachable only by typing it. It resolves as a label. */
  it('resolves the profile', () => {
    expect(menuCommandFor('👤 نمایه من')).toBe('profile');
  });

  it('resolves every label the keyboard ever drew', () => {
    for (const [label, command] of MENU_COMMANDS) {
      expect(menuCommandFor(label), label).toBe(command);
    }
  });

  it('resolves every category label the keyboard ever drew', () => {
    for (const group of COMMAND_GROUPS) {
      const key = menuGroupKeyFor(group.label);
      expect(key).toBe(group.key);
      expect(commandGroupFor(key as string)).not.toBeNull();
    }
  });

  it('tells a category apart from a command', () => {
    expect(menuGroupKeyFor('➕ ساختن فعالیت')).toBeNull();
    expect(menuCommandFor('🎟 فعالیت‌ها')).toBeNull();
    expect(menuGroupKeyFor('سلام')).toBeNull();
  });

  /**
   * Resolved for everybody, authorised for nobody. A stranger who guesses the
   * moderator's label gets «این فرمان را نمی‌شناسم» — and, crucially, does not
   * get it relayed to whoever they are talking to.
   */
  it('resolves the moderation label without authorising it', () => {
    expect(menuCommandFor(MODERATION_MENU_LABEL)).toBe('moderate');
  });

  it('tolerates the whitespace a client may add', () => {
    expect(menuCommandFor('  ➕ ساختن فعالیت  ')).toBe('create_event');
  });

  it('is null for anything somebody actually typed', () => {
    expect(menuCommandFor('سلام')).toBeNull();
    expect(menuCommandFor('')).toBeNull();
  });

  /** A label that dispatches nothing would answer «این فرمان را نمی‌شناسم». */
  it('only maps to commands the bot advertises', () => {
    const known = new Set(BOT_COMMANDS.map((c) => c.command));

    for (const command of MENU_COMMANDS.values()) {
      expect(known).toContain(command);
    }
  });
});

/**
 * Guidance names a **button**, not a command.
 *
 * The bot's own advice used to read «با /discover یک فعالیت پیدا کنید» — a
 * sentence telling somebody to type something, in a product whose whole point is
 * that they never have to, given at the exact moment they are stuck.
 *
 * Since v0.7.0 the button it names is in the inline menu (`/menu` and the `☰`
 * opener), because there is no keyboard under the compose box any more.
 */
describe('menuPathFor', () => {
  /** Every label the inline menu actually shows: the five group buttons. */
  const inlineMenuLabels = new Set(COMMAND_GROUPS.map((group) => group.label));

  it('names the command itself for the two verbs', () => {
    for (const command of ['create_event', 'discover']) {
      expect(menuPathFor(command)).toBe(menuLabelFor(command));
    }
  });

  /**
   * The distinction this function exists for: `MENU_COMMANDS` is a **resolver**
   * and is deliberately wider than the layout — it keeps every label the bot has
   * ever drawn so a stale client's tap still means something — which makes it the
   * wrong thing for a *sentence* to be built from. This names where to tap.
   */
  it('names the category for a command that lives inside one', () => {
    for (const command of ['reviews', 'settings', 'myevents', 'requests', 'bug', 'trust']) {
      const path = menuPathFor(command) as string;
      expect(path, command).not.toBeNull();
      expect(inlineMenuLabels.has(path), `${command} → ${path}`).toBe(true);
    }
  });

  it('never names something the reader cannot find', () => {
    const findable = new Set([
      ...inlineMenuLabels,
      menuLabelFor('create_event') ?? '',
      menuLabelFor('discover') ?? '',
    ]);

    for (const { command } of BOT_COMMANDS) {
      const path = menuPathFor(command);
      if (path === null) continue;
      expect(findable.has(path), `${command} → ${path}`).toBe(true);
    }
  });
});

describe('menuLabelFor', () => {
  it('round-trips with menuCommandFor for every button', () => {
    for (const [label, command] of MENU_COMMANDS) {
      expect(menuLabelFor(command)).toBe(label);
      expect(menuCommandFor(label)).toBe(command);
    }
  });

  /**
   * `/help` and `/start` have no button and are correctly named as commands —
   * they are what somebody types when nothing else has worked. Null is what lets
   * the copy fall back to a written label rather than render `undefined`.
   */
  it('answers null for a command with no button', () => {
    expect(menuLabelFor('help')).toBeNull();
    expect(menuLabelFor('start')).toBeNull();
    // The moderation label is deliberately outside the map: it was only ever
    // appended to a linked moderator's keyboard.
    expect(menuLabelFor('moderate')).toBeNull();
    expect(menuCommandFor(MODERATION_MENU_LABEL)).toBe('moderate');
  });

  /**
   * The two screens a brand-new user meets first. Teaching them here that the
   * product is typed at is the worst possible place to do it.
   */
  it.each([
    [TEMPLATES.BOT_CONSENT_ACCEPTED, 'the gate clearing'],
    [TEMPLATES.BOT_PROFILE, 'the profile card'],
  ])('%s does not tell the reader to send a command', (templateKey, _what) => {
    const text = render(templateKey, {
      displayName: 'نام',
      cityName: 'تهران',
      trustScore: 50,
    })?.text;

    expect(text).toBeDefined();
    // `</b>` is not a command, so the pattern is a slash followed by a command's
    // own charset.
    expect(text).not.toMatch(/\/[a-z_]{3,}/);
  });
});

/**
 * The one button that is actually drawn (v0.8.1).
 *
 * `reply_markup` holds one thing per *message*, and a reply keyboard is not per
 * message — it stays under the compose box while messages carrying inline
 * keyboards go past. So this coexists with every inline keyboard in the product
 * by living somewhere else entirely, and the only thing that has to be true here
 * is that a tap on it resolves to a command rather than being treated as typing.
 */
describe('the main-menu button', () => {
  it('resolves to the menu, so a tap is a command and not a message', () => {
    expect(menuCommandFor(MAIN_MENU_LABEL)).toBe('menu');
  });

  it('survives the whitespace a client may add around a label', () => {
    expect(menuCommandFor(`  ${MAIN_MENU_LABEL}  `)).toBe('menu');
  });

  it('draws exactly one button, sized and pinned', () => {
    const keyboard = mainMenuReplyKeyboard();

    expect(keyboard.keyboard).toEqual([[{ text: MAIN_MENU_LABEL }]]);
    // Without `resize_keyboard` one button takes a third of the screen; without
    // `is_persistent` it collapses into the paperclip after one use, which is the
    // opposite of always being there.
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBe(true);
  });

  /**
   * `menu` has to be a command the bot answers.
   *
   * A label that resolves to a command nothing handles is a button that answers
   * «این فرمان را نمی‌شناسم» — which is worse than no button, and is exactly what
   * a rename of `/menu` would silently produce.
   */
  it('names a command the bot publishes', () => {
    expect(BOT_COMMANDS.map((entry) => entry.command)).toContain('menu');
  });
});
