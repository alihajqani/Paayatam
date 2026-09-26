import { describe, expect, it } from 'vitest';
import {
  SETTING_LANGUAGE,
  SETTING_PRIVACY,
  SETTING_PROFILE,
  parseSettingCallback,
} from './callback-data';
import {
  blockedListRows,
  formatBlockedList,
  formatSettings,
  settingsRows,
  type SettingsState,
} from './settings';

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

    // Two notification switches, privacy, the blocked list (ADR-0020), language.
    // «تبلیغات» went in v0.7.0; the preference behind it did not.
    expect(data).toHaveLength(5);
    for (const value of data) expect(parseSettingCallback(value)).not.toBeNull();
  });

  it('sends the value a tap would set, not the value it shows', () => {
    const chat = buttons(base).find((button) => button.text.includes('پیام‌های مستقیم'));
    expect(parseSettingCallback(chat?.callbackData ?? '')).toEqual({ field: 'c', value: false });

    const events = buttons(base).find((button) => button.text.includes('رویدادها'));
    expect(parseSettingCallback(events?.callbackData ?? '')).toEqual({ field: 'e', value: false });
  });

  /**
   * The emoji says what the setting *is*, not what the button *does*.
   *
   * It was the other way round: a live switch drew 🔕, because the icon
   * described the tap. Glanced at — which is how a five-row board is read — that
   * says "off", while the line above it said «روشن».
   */
  it('draws the state emoji, not the action emoji', () => {
    const on = buttons(base).find((button) => button.text.includes('پیام‌های مستقیم'));
    expect(on?.text.startsWith('🔔')).toBe(true);
    expect(on?.text).toContain('خاموش کردن');

    const off = buttons({ ...base, notifyChat: false }).find((button) =>
      button.text.includes('پیام‌های مستقیم'),
    );
    expect(off?.text.startsWith('🔕')).toBe(true);
    expect(off?.text).toContain('روشن کردن');
  });

  /** And the body agrees with the button, which is what was actually broken. */
  it('states the same thing in the body as on the button', () => {
    expect(formatSettings(base)).toContain('✉️ پیام‌های مستقیم: 🔔 روشن');
    expect(formatSettings({ ...base, notifyChat: false })).toContain(
      '✉️ پیام‌های مستقیم: 🔕 خاموش',
    );
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
    expect(formatSettings(state)).toContain('پس از تکمیل پروفایل');
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

/** «کاربران مسدودشده» (ADR-0020): the one place a block can be lifted later. */
describe('the blocked list', () => {
  const P = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  it('opens from the board', () => {
    const row = buttons(base).find((button) => button.text.includes('مسدودشده'));
    expect(parseSettingCallback(row?.callbackData ?? '')).toEqual({ field: 'b', value: true });
  });

  it('says so when nobody is blocked, and still offers the way back', () => {
    expect(formatBlockedList([])).toContain('کسی را مسدود نکرده‌اید');
    const rows = blockedListRows([]).flat();
    expect(rows).toHaveLength(1);
    expect(parseSettingCallback(rows[0]?.callbackData ?? '')).toEqual({ field: 'b', value: false });
  });

  it('offers one unblock per person, by their public id', () => {
    const rows = blockedListRows([{ userPublicId: P, displayName: 'سارا' }]).flat();
    expect(rows[0]?.callbackData).toBe(`dm:unblock:${P}`);
    expect(rows[0]?.text).toContain('سارا');
  });

  it('escapes the names in the body', () => {
    expect(formatBlockedList([{ userPublicId: P, displayName: '<b>x' }])).toContain('&lt;b&gt;x');
  });
});
