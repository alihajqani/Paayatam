import { describe, expect, it } from 'vitest';
import {
  SETTING_LANGUAGE,
  SETTING_PRIVACY,
  SETTING_PROFILE,
  parseSettingCallback,
} from './callback-data';
import { formatSettings, settingsRows, type SettingsState } from './settings';

const base: SettingsState = {
  notifyChat: true,
  notifyEvents: true,
  notifyCampaigns: false,
  inviteOptOut: false,
  locale: 'fa-IR',
  hasProfile: true,
};

/** Every button on the board, flattened, so a row layout change does not matter. */
function buttons(state: SettingsState): { text: string; callbackData: string }[] {
  return settingsRows(state).flat();
}

describe('the settings board', () => {
  it('renders every area, and never tells the reader to send a command', () => {
    const text = formatSettings(base);

    expect(text).toContain('اعلان‌ها');
    expect(text).toContain('حریم خصوصی');
    expect(text).toContain('زبان');
    // The whole point of v0.6.3: a board of switches must not answer with
    // homework. `</b>` is not a command, so the pattern is a slash followed by a
    // command's own charset.
    expect(text).not.toMatch(/\/[a-z_]{3,}/);
  });

  it('gives every row a button, so nothing on the board is decoration', () => {
    const data = buttons(base).map((button) => button.callbackData);

    // Three notification switches, privacy, language.
    expect(data).toHaveLength(5);
    for (const value of data) expect(parseSettingCallback(value)).not.toBeNull();
  });

  it('sends the value a tap would set, not the value it shows', () => {
    const chat = buttons(base).find((button) => button.text.includes('پیام‌های گفتگو'));
    expect(parseSettingCallback(chat?.callbackData ?? '')).toEqual({ field: 'c', value: false });

    const campaigns = buttons(base).find((button) => button.text.includes('تبلیغات'));
    expect(parseSettingCallback(campaigns?.callbackData ?? '')).toEqual({
      field: 'm',
      value: true,
    });
  });

  it('carries privacy as the reader sees it, not as the column stores it', () => {
    const receiving = buttons(base).find((button) => button.text.includes('دریافت دعوت'));
    // `inviteOptOut` false means invitations are ON, so the button turns them off.
    expect(parseSettingCallback(receiving?.callbackData ?? '')).toEqual({
      field: SETTING_PRIVACY,
      value: false,
    });

    const optedOut = buttons({ ...base, inviteOptOut: true }).find((button) =>
      button.text.includes('دریافت دعوت'),
    );
    expect(parseSettingCallback(optedOut?.callbackData ?? '')).toEqual({
      field: SETTING_PRIVACY,
      value: true,
    });
  });

  it('offers the profile form where the privacy switch cannot work', () => {
    const state = { ...base, hasProfile: false };
    const fields = buttons(state).map((button) => parseSettingCallback(button.callbackData)?.field);

    // A switch that exists to be refused is worse than the button that fixes it.
    expect(fields).not.toContain(SETTING_PRIVACY);
    expect(fields).toContain(SETTING_PROFILE);
    expect(formatSettings(state)).toContain('پس از تکمیل نمایه');
  });

  it('keeps the language row tappable even though there is one language', () => {
    const language = buttons(base).find(
      (button) => parseSettingCallback(button.callbackData)?.field === SETTING_LANGUAGE,
    );
    expect(language?.text).toContain('فارسی');
  });

  it('renders an unknown locale as itself rather than blank', () => {
    expect(formatSettings({ ...base, locale: 'en-US' })).toContain('en-US');
  });
});
