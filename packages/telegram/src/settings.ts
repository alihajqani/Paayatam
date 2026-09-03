import {
  encodeSettingCallback,
  SETTING_LANGUAGE,
  SETTING_PRIVACY,
  SETTING_PROFILE,
  type SettingLetter,
} from './callback-data';

/**
 * The settings board (v0.6.1, made entirely tappable in v0.6.3).
 *
 * ── «تبلیغات» is gone (v0.7.0) ──────────────────────────────────────────────
 *
 * The switch that turned campaign messages off is no longer drawn and the body
 * no longer names them. **The preference behind it is untouched**:
 * `user_settings.notify_campaigns` still exists, still defaults to on,
 * `notificationCategory` still classifies a broadcast as `campaigns`, and the
 * worker still refuses to deliver one to somebody whose row says no. So an
 * account that opted out before today stays opted out, and the day this screen
 * wants the row back it is a keyboard row and nothing else.
 *
 * `SETTING_FIELDS['m']` also stays resolvable, for the reason the retired
 * keyboard labels do: a board drawn before this release is still in somebody's
 * chat, and a tap on its third row must land somewhere rather than parse as
 * garbage.
 *
 * ── What is here, and where each value actually lives ───────────────────────
 *
 * Three areas, three stores, and nothing copied between them — a setting with
 * two homes is a setting that will disagree with itself:
 *
 *  * **Notifications** are `user_settings`, the one table this feature added.
 *  * **Privacy** is `user_profile.invite_opt_out`, which has existed since M22
 *    and which the invitation pool already reads.
 *  * **Language** is `user.locale`, and the product is fa-IR only — every
 *    template, every date format, every error message.
 *
 * ── Why the last two became buttons ─────────────────────────────────────────
 *
 * They were sentences: «برای تغییر این مورد، /edit_profile را بفرستید» under
 * privacy, and «فعلاً فقط فارسی در دسترس است» under language. Both were true and
 * both were the wrong shape — a board of switches where two of the rows answer a
 * tap with homework teaches the reader that the rows are decoration.
 *
 * Privacy is now the switch it always was, written straight through
 * `ProfileService.update` — the same method the profile wizard calls, so the
 * invite pool cannot see one value from one surface and another from the other.
 * Language is a button that states the fact rather than a line of italics under
 * it: one language, said in the place somebody tapped to ask.
 *
 * ── The one row that is not a switch ────────────────────────────────────────
 *
 * Somebody with no profile row has no `invite_opt_out` to flip — `update`
 * answers `PROFILE_INCOMPLETE`, correctly, because editing something that was
 * never created is not an edit. So the privacy switch is replaced by the thing
 * that would make it possible: a button that opens the profile form. A switch
 * that exists to be refused is worse than a button that fixes the reason.
 */
export interface SettingsState {
  notifyChat: boolean;
  notifyEvents: boolean;
  notifyCampaigns: boolean;
  inviteOptOut: boolean;
  locale: string;
  /**
   * Whether there is a `user_profile` row to hold the privacy flag.
   *
   * Drawn from the read rather than inferred from `inviteOptOut`, which
   * defaults to `false` for somebody who has no profile at all — so the flag and
   * "the flag is false" are genuinely different states here.
   */
  hasProfile: boolean;
}

const LOCALE_FA: Record<string, string> = {
  'fa-IR': 'فارسی',
};

export function formatSettings(state: SettingsState): string {
  /**
   * The state, with an emoji that **is** the state.
   *
   * It used to read «روشن» / «خاموش» in the body and carry 🔕 on the button
   * beside it whenever the setting was *on* — the emoji described the action the
   * button performed, so the board's two halves showed opposite symbols for the
   * same row and the icon a reader glances at was reliably the wrong one. Here
   * and on the buttons the emoji now answers one question only: is this on?
   */
  const onOff = (on: boolean): string => (on ? '🔔 روشن' : '🔕 خاموش');

  return (
    `<b>تنظیمات</b>\n\n` +
    `<b>اعلان‌ها</b>\n` +
    `✉️ پیام‌های مستقیم: ${onOff(state.notifyChat)}\n` +
    `🎟 فعالیت‌ها و درخواست‌ها: ${onOff(state.notifyEvents)}\n\n` +
    `<b>حریم خصوصی</b>\n` +
    (state.hasProfile
      ? `✉️ دریافت دعوت از میزبان‌ها: ${onOff(!state.inviteOptOut)}\n\n`
      : `✉️ دریافت دعوت از میزبان‌ها: پس از تکمیل نمایه\n\n`) +
    `<b>زبان</b>\n` +
    `🌐 ${LOCALE_FA[state.locale] ?? state.locale}\n\n` +
    `<i>اعلان‌های مربوط به قوانین، تصمیم‌های پشتیبانی و پاسخ به دستورهای خودتان ` +
    `همیشه فرستاده می‌شوند.</i>`
  );
}

/** One row per switch: tapping the row flips it. */
export function settingsRows(state: SettingsState): { text: string; callbackData: string }[][] {
  const row = (
    label: string,
    on: boolean,
    field: SettingLetter,
  ): { text: string; callbackData: string }[] => [
    {
      /**
       * The emoji is the **state**; the words are the **action**.
       *
       * They were the other way round: 🔕 was drawn on a switch that was on,
       * because the icon was describing what the tap would do. Read at a glance
       * — which is how anybody reads a board of five rows — that says the
       * setting is off, and it disagreed with the line above it saying «روشن».
       * The words still say what tapping does, because «خاموش کردن» beside a
       * live switch is unambiguous in a way «روشن ✅» is not.
       */
      text: `${on ? '🔔' : '🔕'} ${label} — ${on ? 'خاموش کردن' : 'روشن کردن'}`,
      callbackData: encodeSettingCallback(field, !on),
    },
  ];

  const rows = [
    row('پیام‌های مستقیم', state.notifyChat, 'c'),
    row('فعالیت‌ها', state.notifyEvents, 'e'),
  ];

  /**
   * Privacy, carried as the reader sees it.
   *
   * The label says «دریافت دعوت» and the payload says the same thing, so the
   * inversion into `invite_opt_out` happens once, at the write. A button whose
   * text and data disagree is the one place that bug hides.
   */
  if (state.hasProfile) {
    rows.push(row('دریافت دعوت از میزبان‌ها', !state.inviteOptOut, SETTING_PRIVACY));
  } else {
    rows.push([
      {
        text: '👤 تکمیل نمایه، برای تنظیم دعوت‌ها',
        callbackData: encodeSettingCallback(SETTING_PROFILE, true),
      },
    ]);
  }

  rows.push([
    {
      text: '🌐 زبان: فارسی',
      callbackData: encodeSettingCallback(SETTING_LANGUAGE, true),
    },
  ]);

  return rows;
}
