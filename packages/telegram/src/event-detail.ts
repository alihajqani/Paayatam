import { EVENT_DISCLAIMER_FA } from '@payetam/shared';
import { escapeHtml, toPersianDigits } from './escape';
import { formatJalali, formatJalaliTime } from './wizard/jalali';

/**
 * One activity, in full (v0.5.5).
 *
 * ── Why the digest was not enough ───────────────────────────────────────────
 *
 * `/discover` renders four lines per event: title, category, place, time and
 * seats. That is a scanning list and it was the *only* thing the bot ever showed
 * — so somebody joined an activity without having read its description, without
 * knowing what it costs, whether it is for their age, or who is hosting it.
 * `EventDetailView` held all of that and v0.4.6 removed the last button to it.
 *
 * Deciding to spend an evening with strangers on four lines is not a decision
 * anybody should be asked to make, and the disclaimer — which this is the right
 * place for, over one event somebody is about to act on — says as much.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 *
 * No exact address and no contact details. Those are the anonymous stage's to
 * give up (ADR-0009), through the chat, after a host has accepted — a detail
 * screen that leaked a meeting point to anybody holding an event id would make
 * the acceptance meaningless.
 */
export interface EventDetailLine {
  title: string;
  description: string;
  categoryName: string;
  where: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  acceptedCount: number;
  costType: string;
  costAmount: number | null;
  costNote: string | null;
  minAge: number | null;
  maxAge: number | null;
  hostDisplayName: string;
  /** Null when the host has never been judged. Never rendered as zero. */
  hostTrustScore: number | null;
}

const COST_TYPE_FA: Record<string, string> = {
  FREE: 'رایگان',
  APPROX: 'تقریبی',
  FIXED: 'مبلغ ثابت',
  SPLIT: 'دنگی',
};

/**
 * What it costs, in one line.
 *
 * `FREE` says so and stops — appending «۰ تومان» to a free activity reads like a
 * price rather than the absence of one. Everything else names the type, then the
 * amount when there is one, then the host's own note when there is one.
 */
function costLine(line: EventDetailLine): string {
  if (line.costType === 'FREE') return '💵 رایگان';

  const label = COST_TYPE_FA[line.costType] ?? line.costType;
  const amount =
    line.costAmount === null ? '' : ` — ${toPersianDigits(String(line.costAmount))} تومان`;
  const note =
    line.costNote === null || line.costNote === '' ? '' : `\n  ${escapeHtml(line.costNote)}`;

  return `💵 ${escapeHtml(label)}${amount}${note}`;
}

/**
 * The age range, when there is one.
 *
 * Three shapes, because a half-open range is common and «از ۱۸ تا ∞» is not a
 * sentence: both bounds, a floor only, or a ceiling only.
 */
function ageLine(line: EventDetailLine): string | null {
  const { minAge, maxAge } = line;
  if (minAge === null && maxAge === null) return null;
  if (minAge !== null && maxAge !== null) {
    return `🎂 ${toPersianDigits(String(minAge))} تا ${toPersianDigits(String(maxAge))} سال`;
  }
  if (minAge !== null) return `🎂 از ${toPersianDigits(String(minAge))} سال به بالا`;
  return `🎂 تا ${toPersianDigits(String(maxAge ?? 0))} سال`;
}

export function formatEventDetail(line: EventDetailLine): string {
  const remaining = Math.max(line.capacity - line.acceptedCount, 0);
  const seats =
    remaining > 0
      ? `${toPersianDigits(String(remaining))} جای خالی از ${toPersianDigits(String(line.capacity))}`
      : 'ظرفیت تکمیل';

  /**
   * «تازه‌وارد» rather than a number, when the host has never been judged.
   *
   * Null is not zero and the distinction is the whole point: `trust_score` is
   * written lazily by the first movement, so a host who has just finished their
   * profile legitimately has no row — and showing 0 would put the worst possible
   * reputation on somebody who has done nothing wrong.
   */
  const trust =
    line.hostTrustScore === null
      ? 'تازه‌وارد'
      : `${toPersianDigits(String(line.hostTrustScore))} از ۱۰۰`;

  const age = ageLine(line);

  return (
    `<b>${escapeHtml(line.title)}</b>\n\n` +
    `${escapeHtml(line.description)}\n\n` +
    `🗂 ${escapeHtml(line.categoryName)}\n` +
    `📍 ${escapeHtml(line.where)}\n` +
    `🗓 ${formatJalali(line.startsAt)} — ${formatJalaliTime(line.startsAt)} تا ${formatJalaliTime(
      line.endsAt,
    )}\n` +
    `👥 ${seats}\n` +
    `${costLine(line)}\n` +
    (age === null ? '' : `${age}\n`) +
    `\n👤 میزبان: ${escapeHtml(line.hostDisplayName)}\n` +
    `⭐️ امتیاز اعتماد: ${trust}\n\n` +
    `<i>${escapeHtml(EVENT_DISCLAIMER_FA)}</i>`
  );
}
