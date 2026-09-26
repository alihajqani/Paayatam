import { toPersianDigits } from '@payetam/telegram';
import { SETTING_DEFAULTS, type SettingKey } from './settings.service';

/**
 * The guide's placeholders, as pure functions (migration 0063).
 *
 * `{{economy.event_join_coins}}` in a section's text becomes the live value of
 * that setting when the page is drawn; see `HELP_GUIDE_DEFAULTS` for why the
 * numbers are not written out. Pure, so the bot, the panel's validation and the
 * tests all agree on what a placeholder is and what it becomes.
 */

/** A button label: short enough to read on a phone without being cut. */
export const HELP_GUIDE_TITLE_MAX = 40;
/**
 * A section's text. One Telegram message is 4096 characters and the page adds
 * a heading and a footer, so this leaves room; the table's CHECK is the same.
 */
export const HELP_GUIDE_BODY_MAX = 3500;

/**
 * Numbers the guide quotes that are not one setting but arithmetic over two.
 *
 * Computed here rather than written as `{{a}} + {{b}}`, because the sentence
 * wants the one number somebody pays. Each names the settings it reads, so a
 * page that uses it reads exactly those.
 */
const DERIVED: Record<
  string,
  { reads: readonly SettingKey[]; value: (v: SettingValues) => number }
> = {
  /**
   * What creating an event costs, as one sum. The split into a registration
   * and a channel publication is deliberately never shown to a host
   * (`economy.event_channel_publish_coins`), so the guide quotes the total.
   */
  'derived.event_register_coins': {
    reads: ['economy.event_create_coins', 'economy.event_channel_publish_coins'],
    value: (v) =>
      (v['economy.event_create_coins'] ?? 0) + (v['economy.event_channel_publish_coins'] ?? 0),
  },
  /** A host found absent pays the no-show price times the host multiplier. */
  'derived.host_no_show_coins': {
    reads: ['cancellation.coins_no_show', 'cancellation.host_penalty_multiplier'],
    value: (v) =>
      Math.round(
        Math.abs(v['cancellation.coins_no_show'] ?? 0) *
          (v['cancellation.host_penalty_multiplier'] ?? 1),
      ),
  },
};

type SettingValues = Partial<Record<SettingKey, number>>;

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)(\|abs)?\s*\}\}/g;

/** Every key a placeholder may name: each setting, then the derived sums. */
export function helpGuidePlaceholderKeys(): string[] {
  return [...Object.keys(SETTING_DEFAULTS), ...Object.keys(DERIVED)];
}

function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, key);
}

function isKnownKey(key: string): boolean {
  return isSettingKey(key) || Object.prototype.hasOwnProperty.call(DERIVED, key);
}

/** The keys a text names, once each, in the order they first appear. */
export function placeholdersIn(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const key = match[1] ?? '';
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Keys a text names that no setting and no derived value answers to. */
export function unknownPlaceholders(text: string): string[] {
  return placeholdersIn(text).filter((key) => !isKnownKey(key));
}

/** The settings a set of texts needs read, derived values' inputs included. */
export function settingKeysFor(texts: readonly string[]): SettingKey[] {
  const keys = new Set<SettingKey>();
  for (const text of texts) {
    for (const key of placeholdersIn(text)) {
      if (isSettingKey(key)) keys.add(key);
      for (const read of DERIVED[key]?.reads ?? []) keys.add(read);
    }
  }
  return [...keys];
}

/** Every placeholder's value from the settings it reads, derived ones included. */
export function placeholderValues(settings: SettingValues): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'number') values[key] = value;
  }
  for (const [key, derived] of Object.entries(DERIVED)) {
    if (derived.reads.every((read) => typeof settings[read] === 'number')) {
      values[key] = derived.value(settings);
    }
  }
  return values;
}

/**
 * A number the way the rest of the bot writes one: Persian digits, «٬» between
 * thousands and «٫» before a fraction — «۱٫۵ برابر», «۴۵٬۰۰۰ تومان».
 */
export function formatGuideNumber(value: number): string {
  const [whole = '0', fraction] = String(Math.abs(value)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const sign = value < 0 ? '-' : '';
  return toPersianDigits(`${sign}${grouped}${fraction === undefined ? '' : `٫${fraction}`}`);
}

/**
 * The text with every placeholder filled.
 *
 * A key with no value is left as written rather than blanked: the panel refuses
 * to save an unknown key, so reaching here with one means a setting was retired
 * under a saved text, and «{{old.key}}» on a page is a visible bug where an
 * empty gap in a sentence would be a silent one.
 */
export function renderGuideText(text: string, values: Readonly<Record<string, number>>): string {
  return text.replace(PLACEHOLDER, (whole, key: string, abs: string | undefined) => {
    const value = values[key];
    if (value === undefined) return whole;
    return formatGuideNumber(abs === undefined ? value : Math.abs(value));
  });
}
