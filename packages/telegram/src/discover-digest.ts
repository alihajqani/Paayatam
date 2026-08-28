import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { formatTehran } from './datetime';
import { buildDigest } from './digest';
import { escapeHtml, toPersianDigits } from './escape';

/** One line of the discovery digest: what it is, when, and whether there is room. */
export interface DiscoverLine {
  title: string;
  categoryName: string;
  /** City, or «city — district» when the event names one. */
  where: string;
  startsAt: Date;
  remainingCapacity: number;
}

/**
 * `/discover` — activities in the sender's own city, soonest first.
 *
 * ── Why it takes no arguments ────────────────────────────────────────────────
 *
 * The city comes from the sender's profile, which makes this single-turn and
 * therefore something the bot may do at all. `DiscoveryQuery` has fourteen
 * filters and `DiscoverView` renders all of them; asking for any of them here
 * would mean holding a half-built query between two updates, which is the
 * per-user conversation state `BotService` deliberately has none of. The bot
 * answers the common question — "what is on near me?" — and the button opens the
 * screen where the other thirteen filters live.
 *
 * ── The disclaimer ───────────────────────────────────────────────────────────
 *
 * Once, at the top, covering every event below it, exactly as a channel post
 * carries it above the one event it is about. It is a liability statement and it
 * is not optional: an event listed without it is an event this product is
 * silently vouching for. Escaped like everything else, even though it is our own
 * constant — the day somebody puts an angle bracket in it, the message should
 * not break.
 */
export function formatDiscovered(lines: readonly DiscoverLine[]): string {
  const entries = lines.map((line) => {
    /**
     * «۳ جای خالی» is the number somebody scanning a list actually decides on.
     * A full event is not silently rendered as zero: `hasCapacity` filters those
     * out upstream, and if one slips through, saying so beats an empty count.
     */
    const seats =
      line.remainingCapacity > 0
        ? `${toPersianDigits(String(line.remainingCapacity))} جای خالی`
        : 'ظرفیت تکمیل';

    return (
      `• <b>${escapeHtml(line.title)}</b>\n` +
      `  🗂 ${escapeHtml(line.categoryName)}\n` +
      `  📍 ${escapeHtml(line.where)}\n` +
      `  🗓 ${formatTehran(line.startsAt)} · 👥 ${seats}`
    );
  });

  const digest = buildDigest({
    title: 'فعالیت‌های نزدیک شما',
    empty: 'فعلاً فعالیتی در شهر شما ثبت نشده است. کمی بعد دوباره سر بزنید.',
    entries,
  });

  // No disclaimer over an empty list: there is nothing to disclaim, and the
  // sentence would read as a warning about the absence of events.
  if (entries.length === 0) return digest;

  return `${digest}\n\n<i>${escapeHtml(EVENT_DISCLAIMER_SHORT_FA)}</i>`;
}
