import { describe, expect, it } from 'vitest';
import { SETTING_GUIDE, type SettingGuide } from './setting-guide';
import { SETTING_DEFAULTS, type SettingKey } from './settings.service';

/**
 * The operator-facing catalogue, asserted total and asserted useful.
 *
 * Totality is already a *type* constraint — `satisfies Record<SettingKey, …>` on
 * the map itself — so the first case here is belt and braces rather than the main
 * event. It earns its place by failing with a readable list of the missing keys
 * instead of a page of TypeScript, which is what somebody who has just added a
 * setting actually needs to see.
 *
 * The rest are the cases a type cannot express: an empty string satisfies
 * `string`, and a catalogue of 88 blank entries would typecheck perfectly while
 * putting nothing at all on the screen. These are the same shape as
 * `errors.test.ts`'s assertions about `ERROR_MESSAGES_FA`, and for the same
 * reason — a partial catalogue degrades silently and the entry that is missing is
 * always the one somebody needed.
 */
describe('SETTING_GUIDE', () => {
  const entries = Object.entries(SETTING_GUIDE) as Array<[SettingKey, SettingGuide]>;

  it('covers every key in SETTING_DEFAULTS', () => {
    const missing = Object.keys(SETTING_DEFAULTS).filter((key) => !(key in SETTING_GUIDE));
    expect(missing).toEqual([]);
  });

  it('describes nothing that is not a setting', () => {
    // The other direction. A key removed from `SETTING_DEFAULTS` leaves an entry
    // here that no screen can reach, and a catalogue with dead entries is one
    // nobody trusts to be current.
    const orphans = Object.keys(SETTING_GUIDE).filter((key) => !(key in SETTING_DEFAULTS));
    expect(orphans).toEqual([]);
  });

  it.each(entries)('%s has a label, a summary, a detail and guidance', (_key, guide) => {
    expect(guide.label.trim()).not.toBe('');
    expect(guide.summary.trim()).not.toBe('');
    expect(guide.detail.trim()).not.toBe('');
    expect(guide.guidance.trim()).not.toBe('');
  });

  it('says more in the detail than in the summary', () => {
    // The summary is a table row and the detail opens in a dialog somebody
    // deliberately opened. If they are the same length, the dialog is asking for
    // a click and giving nothing back for it.
    const lazy = entries.filter(([, guide]) => guide.detail.length <= guide.summary.length);
    expect(lazy.map(([key]) => key)).toEqual([]);
  });

  it('gives every switch a unit that renders as one', () => {
    // A key whose only sensible values are 0 and 1 must not reach the panel as a
    // number field: rendered that way it invites a 2, which every reader treats
    // as truthy and nobody intended.
    const switches: SettingKey[] = [
      'founding.enabled',
      'profile.location_notice',
      'channel.enabled',
      'giftcode.enabled',
      'release.announce_enabled',
      'review.partial_reveal_affects_trust',
    ];
    for (const key of switches) {
      expect(SETTING_GUIDE[key].unit).toBe('switch');
    }
  });

  it('names no code path', () => {
    // An operator cannot open a service file, and a sentence that assumes they
    // can is a sentence that helps nobody. The engineering rationale lives in
    // the comments beside the defaults; this catalogue is the other audience.
    const leaked = entries.filter(([, guide]) =>
      /Service\b|\.ts\b|\bfunction\b/.test(`${guide.detail} ${guide.guidance}`),
    );
    expect(leaked.map(([key]) => key)).toEqual([]);
  });
});
