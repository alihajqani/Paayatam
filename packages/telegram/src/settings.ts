import { encodeSettingCallback } from './callback-data';

/**
 * The settings board (v0.6.1).
 *
 * ── What is here, and what is elsewhere ─────────────────────────────────────
 *
 * Three notification switches. Language and privacy are *shown* and are not
 * switches here, and both for the same reason: the product has one language and
 * one privacy control, and pretending otherwise would be a settings screen that
 * lies about what it can do.
 *
 *  * **Language** is `user.locale`, and the product is fa-IR only — every
 *    template, every date format, every error message. A language picker with
 *    one entry is not a feature, so this states the language rather than
 *    offering to change it.
 *  * **Privacy** is `user_profile.invite_opt_out`, which already exists and is
 *    already read by the invitation pool. It is a toggle, and it is the profile
 *    wizard's field — surfaced here with the command that changes it.
 */
export interface SettingsState {
  notifyChat: boolean;
  notifyEvents: boolean;
  notifyCampaigns: boolean;
  inviteOptOut: boolean;
  locale: string;
}

const LOCALE_FA: Record<string, string> = {
  'fa-IR': 'فارسی',
};

export function formatSettings(state: SettingsState): string {
  const onOff = (on: boolean): string => (on ? 'روشن' : 'خاموش');

  return (
    `<b>تنظیمات</b>\n\n` +
    `<b>اعلان‌ها</b>\n` +
    `💬 پیام‌های گفتگو: ${onOff(state.notifyChat)}\n` +
    `🎟 فعالیت‌ها و درخواست‌ها: ${onOff(state.notifyEvents)}\n` +
    `📣 پیام‌های تبلیغاتی: ${onOff(state.notifyCampaigns)}\n\n` +
    `<b>حریم خصوصی</b>\n` +
    `✉️ دریافت دعوت از میزبان‌ها: ${onOff(!state.inviteOptOut)}\n` +
    `<i>برای تغییر این مورد، /edit_profile را بفرستید.</i>\n\n` +
    `<b>زبان</b>\n` +
    `🌐 ${LOCALE_FA[state.locale] ?? state.locale}\n` +
    `<i>فعلاً فقط فارسی در دسترس است.</i>\n\n` +
    `<i>اعلان‌های مربوط به قوانین، تصمیم‌های پشتیبانی و پاسخ به دستورهای خودتان ` +
    `همیشه فرستاده می‌شوند.</i>`
  );
}

/** One row per switch: tapping the row flips it. */
export function settingsRows(state: SettingsState): { text: string; callbackData: string }[][] {
  const row = (
    label: string,
    on: boolean,
    field: Parameters<typeof encodeSettingCallback>[0],
  ): { text: string; callbackData: string }[] => [
    {
      // The button says what tapping it *does*, not what the state is — the
      // state is in the body above. «خاموش کردن» beside a switch that is on is
      // unambiguous in a way «روشن ✅» is not.
      text: `${on ? '🔕' : '🔔'} ${label}: ${on ? 'خاموش کردن' : 'روشن کردن'}`,
      callbackData: encodeSettingCallback(field, !on),
    },
  ];

  return [
    row('پیام‌های گفتگو', state.notifyChat, 'c'),
    row('فعالیت‌ها', state.notifyEvents, 'e'),
    row('تبلیغات', state.notifyCampaigns, 'm'),
  ];
}
