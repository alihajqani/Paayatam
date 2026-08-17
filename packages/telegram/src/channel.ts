import { escapeHtml, toPersianDigits } from './escape';

/** What a channel post is rendered from. Note what is absent: the host. */
export interface ChannelPostContent {
  kind: 'VIP' | 'BOOSTED' | 'TRENDING';
  title: string;
  categoryName: string;
  cityName: string;
  districtName: string | null;
  startsAt: Date;
  capacity: number;
  acceptedCount: number;
  costType: string;
  costAmount: number | null;
  eventPublicId: string;
  /** The bot's username, for the deep link. */
  botUsername: string;
}

const KIND_LABEL: Record<ChannelPostContent['kind'], string> = {
  VIP: '⭐️ ویژه',
  BOOSTED: '🔝 نردبان',
  TRENDING: '🔥 پرطرفدار',
};

const COST_LABEL: Record<string, string> = {
  FREE: 'رایگان',
  APPROX: 'تقریبی',
  FIXED: 'ثابت',
  SPLIT: 'دنگی',
};

/**
 * One channel post.
 *
 * **The post body contains no host identity**, which the plan states as a test and
 * which is the reason this renderer takes a narrow content type rather than an
 * event row: there is no `hostUserId`, no display name and no avatar in
 * `ChannelPostContent`, so a future edit cannot casually add one. The channel is a
 * public surface with no authentication in front of it — whatever appears here is
 * readable by anyone who finds the channel, forever, including after the event is
 * over and the account is deleted.
 *
 * Every interpolated value is escaped (T9). A title is host-authored text on its
 * way into an HTML message, and the channel is the widest audience any of it
 * reaches.
 */
export function renderChannelPost(content: ChannelPostContent): string {
  const where =
    content.districtName === null
      ? escapeHtml(content.cityName)
      : `${escapeHtml(content.cityName)}، ${escapeHtml(content.districtName)}`;

  const seatsLeft = Math.max(content.capacity - content.acceptedCount, 0);
  const cost =
    content.costType === 'FREE' || content.costAmount === null
      ? (COST_LABEL[content.costType] ?? '—')
      : `${toPersianDigits(content.costAmount)} تومان (${COST_LABEL[content.costType] ?? ''})`;

  return [
    `${KIND_LABEL[content.kind]}`,
    ``,
    `<b>${escapeHtml(content.title)}</b>`,
    ``,
    `🗂 ${escapeHtml(content.categoryName)}`,
    `📍 ${where}`,
    `🗓 ${formatTehran(content.startsAt)}`,
    `💸 ${cost}`,
    `👥 ${toPersianDigits(seatsLeft)} جای خالی از ${toPersianDigits(content.capacity)}`,
    ``,
    // A deep link rather than a bare id: the reader taps and lands on the event.
    // Built from the *public* id, which is the only identifier that ever appears
    // outside the backend (invariant 7).
    `<a href="https://t.me/${escapeHtml(content.botUsername)}?startapp=event_${escapeHtml(
      content.eventPublicId,
    )}">مشاهده و درخواست پیوستن</a>`,
  ].join('\n');
}

/**
 * The start time, in Tehran, in Persian digits.
 *
 * Formatted here rather than stored: the database holds UTC and the reader lives
 * in Tehran (D12, ADR-0008). Gregorian rather than Jalali because `Intl` has no
 * Persian calendar formatter available in every Node build, and a wrong date in a
 * public channel is worse than a Gregorian one — the Mini App renders Jalali,
 * where the conversion is done properly.
 */
function formatTehran(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return toPersianDigits(parts);
}
