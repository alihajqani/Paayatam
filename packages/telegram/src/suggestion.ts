import { encodeSuggestionCallback } from './callback-data';
import { escapeHtml, toPersianAmount, toPersianDigits } from './escape';
import type { InlineKeyboard } from './keyboards';
import { formatJalali, formatJalaliTime } from './wizard/jalali';

/**
 * A suggestion as the bot draws it (migration 0064): a real programme outside
 * the product — a screening, a play, a group hike — that the reader may turn
 * into an event of their own with one tap.
 *
 * ── Honest about what it is ─────────────────────────────────────────────────
 *
 * The reader came from a channel post, not from a crowd, and nobody has planned
 * this yet. The card says so: the programme is real, and «میزبانش می‌شوم» makes
 * an event in the reader's name that others can ask to join. Dressing it up as
 * an event people are already going to would be the empty-shelf trick the
 * suggestions exist to replace.
 */
export interface SuggestionCardLine {
  title: string;
  description: string;
  venueLabel: string;
  cityName: string;
  categoryName: string;
  startsAt: Date;
  durationHours: number;
  costType: string;
  costAmount: number | null;
  externalLink: string | null;
}

const COST_TYPE_FA: Record<string, string> = {
  APPROX: 'تقریبی',
  FIXED: 'مبلغ ثابت',
  SPLIT: 'دنگی',
};

function costLine(line: SuggestionCardLine): string {
  if (line.costType === 'FREE') return '💵 رایگان';
  const label = COST_TYPE_FA[line.costType] ?? line.costType;
  const amount = line.costAmount === null ? '' : ` — ${toPersianAmount(line.costAmount)} تومان`;
  return `💵 ${escapeHtml(label)}${amount}`;
}

export function formatSuggestionCard(line: SuggestionCardLine): string {
  return (
    `<b>${escapeHtml(line.title)}</b>\n\n` +
    `${escapeHtml(line.description)}\n\n` +
    `🗂 ${escapeHtml(line.categoryName)}\n` +
    `📍 ${escapeHtml(line.cityName)}، ${escapeHtml(line.venueLabel)}\n` +
    `🗓 ${formatJalali(line.startsAt)} — ساعت ${formatJalaliTime(line.startsAt)}` +
    ` (${toPersianDigits(String(line.durationHours))} ساعت)\n` +
    `${costLine(line)}\n\n` +
    `این برنامه واقعی است و بیرون از پایتم برگزار می‌شود. اگر می‌خواهید بروید، ` +
    `«میزبانش می‌شوم» را بزنید: رویدادش به اسم شما ساخته می‌شود و دیگران می‌توانند ` +
    `درخواست بدهند که همراهتان بیایند.`
  );
}

/**
 * «میزبانش می‌شوم», and the programme's own page when it has one.
 *
 * The page is a URL button rather than a link in the text: no `href` in this
 * package is built from input (escape.ts), and a button cannot be smuggled into
 * markup. The admin contract holds it to `https://`.
 */
export function suggestionKeyboard(publicId: string, externalLink: string | null): InlineKeyboard {
  return [
    [
      {
        text: '🙋 میزبانش می‌شوم',
        callbackData: encodeSuggestionCallback(publicId),
        style: 'primary',
      },
    ],
    ...(externalLink === null ? [] : [[{ text: '🔗 اطلاعات و بلیت', url: externalLink }]]),
  ];
}

/**
 * Drawn under somebody else's event made from the same suggestion: going with
 * them is the suggestion the bot makes, not a rule it enforces.
 */
export const JOIN_EXISTING_LINE =
  'برای همین برنامه یک نفر رویداد ساخته است و هنوز جا دارد؛ می‌توانید همراهش شوید. ' +
  'اگر ترجیح می‌دهید جدا بروید، رویداد خودتان را بسازید.';

export function joinExistingKeyboard(publicId: string): InlineKeyboard {
  return [[{ text: '✍️ خودم یکی جدا می‌سازم', callbackData: encodeSuggestionCallback(publicId) }]];
}

/** A suggestion that was closed, has started, or never existed. */
export const SUGGESTION_GONE_FA =
  'این پیشنهاد دیگر باز نیست؛ یا زمانش گذشته یا بسته شده است. ' +
  'رویدادهای باز را از منو، بخش «🎟 رویدادها»، ببینید.';
