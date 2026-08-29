import { describe, expect, it } from 'vitest';
import { MENU_COMMANDS, menuCommandFor, menuKeyboard } from './keyboards';
import { BOT_COMMANDS } from './commands';

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

  it('offers every label it knows how to map back', () => {
    const labels = menuKeyboard()
      .flat()
      .map((button) => button.text);

    expect(labels.sort()).toEqual([...MENU_COMMANDS.keys()].sort());
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
