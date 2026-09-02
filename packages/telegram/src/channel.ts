import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { formatTehran } from './datetime';
import { escapeHtml, toPersianAmount } from './escape';
import { seatsLine } from './seats';
import { botStartUrl, encodeStartPayload } from './deep-link';
import { type InlineKeyboard } from './keyboards';

/** What a channel post is rendered from. Note what is absent: the host. */
export interface ChannelPostContent {
  /**
   * Why this event is in the channel. Mirrors `channel_post_kind`, and is spelled
   * out rather than imported so this package stays free of a Prisma dependency.
   *
   * **Not rendered** since v0.7.0. It used to head the post — «🔥 پرطرفدار», «📣
   * معرفی‌شده» — which told the reader something true and irrelevant: why the
   * channel is showing them this is the channel's business, and the line was
   * spending the most-read row of the post on it. It stays on the type because
   * `UNIQUE (event_id, kind)` is what makes a claim exactly-once, and because a
   * renderer that cannot see which kind it is drawing is a renderer that cannot
   * be given a kind-specific line later.
   */
  kind: 'VIP' | 'BOOSTED' | 'TRENDING' | 'PAID';
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

const COST_LABEL: Record<string, string> = {
  FREE: 'رایگان',
  APPROX: 'تقریبی',
  FIXED: 'ثابت',
  SPLIT: 'دنگی',
};

/** A channel post: the message, and the button under it. */
export interface RenderedChannelPost {
  text: string;
  /**
   * The inline keyboard Telegram draws under the post.
   *
   * Never absent, and never fewer than one button: a post with no button is a
   * post the channel cannot be reached *from*, which is the whole of report 7.
   * `renderChannelPost` degrades to the bot's plain link if a public id ever
   * fails the charset check, so the reader always has somewhere to tap.
   */
  keyboard: InlineKeyboard;
}

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
 *
 * ── The link became a button (report 7) ──────────────────────────────────────
 *
 * It used to be an `<a>` in the last line of the body. That works, and almost
 * nobody taps it: it renders as ordinary blue text at the bottom of a nine-line
 * message, and on a phone it is a small target competing with the message above
 * it. An inline button is a control — full width, at the bottom of the post,
 * where every Telegram user already expects one. Same deep link, same public id,
 * so nothing about what is exposed changes.
 *
 * ── One button became two, and both point at the bot (v0.6.3) ────────────────
 *
 * The single button opened the **Mini App** (`?startapp=`), which v0.4.6 spent a
 * release removing every other button to. So the channel — the one surface that
 * reaches people who have never met this product — was still sending them to the
 * application being retired, and it sent them there to *read*: the post named no
 * way to act on the activity it was advertising.
 *
 * Two buttons now, and the split is the reader's own two questions. «مشاهده در
 * ربات» opens the activity in full — description, cost, age range, the host's
 * Trust Score — for somebody deciding. «پایتم» is for somebody who has already
 * decided, and asks to join without a detail screen in between. It says the same
 * word the in-bot button says (v0.7.0); it used to say «شرکت می‌کنم», which was
 * a third phrasing of one action.
 *
 * Both are `?start=` links rather than callback buttons, and that is not a
 * stylistic choice: the bot cannot send a message to somebody who has never
 * opened a chat with it, so a callback from a reader who has not started the bot
 * could be answered with a toast and **nothing else** — no acknowledgement, no
 * host notification, no explanation of a refusal. Following a link opens the
 * chat, which is what makes every message after it deliverable. It also keeps
 * working on a post forwarded out of the channel.
 *
 * **Joining is still refused by the service**, exactly as it is from every other
 * surface: a full event, a cancelled one, the reader's own, one they have already
 * asked to join. The button says what it does; the answer is the product's.
 *
 * ── The disclaimer (report 8) ────────────────────────────────────────────────
 *
 * The first line of every post, above the event's own details, because "above
 * every event" is what was asked for and because a liability line below the fold
 * is a line nobody reads. It is the short form: a paragraph at the top of every
 * post is a paragraph readers learn to skip, which is the one thing a disclaimer
 * cannot afford. The text is `@payetam/shared`'s, so the channel and the Mini App
 * cannot drift into saying different things.
 *
 * ── The voice (v0.7.0) ───────────────────────────────────────────────────────
 *
 * The post used to be a card: a kind label, the title in bold on its own line,
 * then five facts. It read like a listing, which is what it was, and a listing is
 * not what somebody scrolling a channel stops for.
 *
 * It now opens the way the person posting it would: «پایه واسه <b>…</b> میخوام /
 * کیو داریم اینجا؟ بگه!» — the host asking, in the register the product is named
 * in, with the activity's name inside the sentence rather than above it. The five
 * facts follow unchanged, because they are what a reader decides on.
 *
 * ── Escaping ─────────────────────────────────────────────────────────────────
 *
 * `parse_mode: 'HTML'`, as every message this package renders is, and every
 * interpolated value goes through `escapeHtml` — the title, the category, the
 * city and the neighbourhood are all host-authored, and the channel is the widest
 * audience any of them reaches. The only unescaped markup is this file's own
 * `<b>`. MarkdownV2 would need a second escaping discipline for a second parse
 * mode in a codebase that has exactly one, which is how a post ends up rendering
 * a host's underscore as italics.
 */
export function renderChannelPost(content: ChannelPostContent): RenderedChannelPost {
  const where =
    content.districtName === null
      ? escapeHtml(content.cityName)
      : `${escapeHtml(content.cityName)}، ${escapeHtml(content.districtName)}`;

  const cost =
    content.costType === 'FREE' || content.costAmount === null
      ? (COST_LABEL[content.costType] ?? '—')
      : `${toPersianAmount(content.costAmount)} تومان (${COST_LABEL[content.costType] ?? ''})`;

  const text = [
    // Escaped like everything else, even though it is our own constant: the day
    // somebody puts an angle bracket in it, the post should not break. It
    // carries its own ⚠️ and is plain rather than italic — a whole italic line
    // at the head of every post is the shape readers learn to skip.
    escapeHtml(EVENT_DISCLAIMER_SHORT_FA),
    `پایه واسه <b>${escapeHtml(content.title)}</b> میخوام`,
    `کیو داریم اینجا؟ بگه!`,
    ``,
    `🗂 ${escapeHtml(content.categoryName)}`,
    `📍 ${where}`,
    `🗓 ${formatTehran(content.startsAt)}`,
    `💸 ${cost}`,
    `👥 ${seatsLine(content.capacity, content.acceptedCount)}`,
  ].join('\n');

  /**
   * Built from the *public* id, which is the only identifier that ever appears
   * outside the backend (invariant 7).
   *
   * `encodeStartPayload` throws on anything Telegram would refuse, and a throw
   * inside a renderer fails the send job — which retries, and fails again. So a
   * malformed id costs the two actions and leaves the plain bot link, exactly as
   * `isPublicId` protects the keyboards that carry `callback_data`.
   */
  let keyboard: InlineKeyboard;
  try {
    keyboard = [
      [
        {
          text: '👀 مشاهده در ربات',
          url: botStartUrl(content.botUsername, encodeStartPayload('event', content.eventPublicId)),
        },
      ],
      [
        {
          text: '🤝 پایتم',
          url: botStartUrl(content.botUsername, encodeStartPayload('join', content.eventPublicId)),
        },
      ],
    ];
  } catch {
    keyboard = [[{ text: '👀 مشاهده در ربات', url: `https://t.me/${content.botUsername}` }]];
  }

  return { text, keyboard };
}
