import { describe, expect, it } from 'vitest';
import {
  MENU_COMMANDS,
  MODERATION_MENU_LABEL,
  menuCommandFor,
  menuGroupKeyFor,
  menuKeyboard,
  menuLabelFor,
} from './keyboards';
import { TEMPLATES, render } from './templates';
import { BOT_COMMANDS, COMMAND_GROUPS, commandGroupFor } from './commands';

describe('the persistent menu', () => {
  it('lays out in rows of two', () => {
    for (const row of menuKeyboard()) {
      expect(row.length).toBeLessThanOrEqual(2);
    }
  });

  /** Report: `/profile` was reachable only by typing it. Now it is a button. */
  it('offers the profile', () => {
    expect(menuCommandFor('👤 نمایه من')).toBe('profile');
  });

  /**
   * The invariant that actually matters, and the one that must never lapse.
   *
   * A reply-keyboard tap arrives as ordinary text. A label this build cannot
   * resolve is handed to `onText`, which would give it to a wizard as an answer
   * or **relay it into an anonymous chat** — and a stranger would receive «🎟
   * فعالیت‌ها» from somebody they are deciding whether to meet.
   *
   * It is no longer "the labels are the command map": the keyboard draws two
   * commands and five categories, and the map is a resolver that is deliberately
   * wider than the layout. So the assertion is resolvability, by either route.
   */
  it('draws nothing it cannot resolve', () => {
    for (const button of menuKeyboard(true).flat()) {
      const resolved = menuCommandFor(button.text) ?? menuGroupKeyFor(button.text);
      expect(resolved, `unresolvable label: ${button.text}`).not.toBeNull();
    }
  });

  /**
   * A reply keyboard lives on the client until a message replaces it, so on the
   * day the layout changes there are users holding the previous one. Every label
   * the keyboard has ever offered therefore stays resolvable whether or not it
   * is still drawn.
   */
  it('still resolves a label it no longer draws', () => {
    const drawn = new Set(
      menuKeyboard()
        .flat()
        .map((button) => button.text),
    );

    expect(drawn.has('📨 درخواست‌های من')).toBe(false);
    expect(menuCommandFor('📨 درخواست‌های من')).toBe('requests');
  });

  /** The five categories, the same five the inline menu groups by. */
  it('carries every command group', () => {
    const drawn = menuKeyboard()
      .flat()
      .map((button) => button.text);

    for (const group of COMMAND_GROUPS) {
      expect(drawn).toContain(group.label);
    }
  });

  it('resolves a category tap to a group the build knows', () => {
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
   * The product's core action stays one tap away. Everything else is two, which
   * is the trade the categories make; making *this* two would put creating an
   * activity behind a menu.
   */
  it('keeps the two verbs on their own buttons', () => {
    const drawn = menuKeyboard()
      .flat()
      .map((button) => button.text);

    expect(drawn).toContain(menuLabelFor('create_event'));
    expect(drawn).toContain(menuLabelFor('discover'));
  });

  it('gives a moderator a row of their own', () => {
    const rows = menuKeyboard(true);
    const last = rows[rows.length - 1];

    expect(last).toEqual([{ text: MODERATION_MENU_LABEL }]);
    expect(
      menuKeyboard()
        .flat()
        .map((b) => b.text),
    ).not.toContain(MODERATION_MENU_LABEL);
  });

  /**
   * A reply-keyboard tap arrives as ordinary text. Unmapped, it would be handed
   * to a wizard as an answer or relayed into an anonymous chat — and a stranger
   * would receive «🎟 فعالیت‌های من».
   */
  it('maps a label back to its command', () => {
    for (const [label, command] of MENU_COMMANDS) {
      expect(menuCommandFor(label)).toBe(command);
    }
  });

  it('tolerates the whitespace a client may add', () => {
    expect(menuCommandFor('  ➕ ساختن فعالیت  ')).toBe('create_event');
  });

  it('is null for anything somebody actually typed', () => {
    expect(menuCommandFor('سلام')).toBeNull();
    expect(menuCommandFor('')).toBeNull();
  });

  /** A menu button that dispatches nothing is a button that answers «این فرمان را نمی‌شناسم». */
  it('only offers commands the bot advertises', () => {
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
 */
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
    // The moderation label is deliberately outside the map: only a linked
    // moderator's keyboard carries it.
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
