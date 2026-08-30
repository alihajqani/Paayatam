import { encodeChatCallback, encodeReportAsk } from './callback-data';

/**
 * Inline keyboards (plan §3.2: "grammY composition, keyboards, fa message
 * templates").
 *
 * **Our own button type, not grammY's.** This package renders; the worker sends.
 * Keeping the keyboard a plain data structure means the message catalogue and its
 * tests need no bot instance, no token and no network — and the mapping to
 * Telegram's wire format happens in the one file that already talks to Telegram.
 *
 * The keyboards are also what make the inbound callbacks *reachable*. A
 * `chat:accept:<id>` handler with no button that emits it is dead code, so the
 * buttons and the handlers arrive together or not at all.
 */

export interface InlineButton {
  text: string;
  /** Exactly one of these. A button with both is a Telegram 400. */
  url?: string;
  callbackData?: string;
}

/** Rows of buttons, as Telegram lays them out. */
export type InlineKeyboard = readonly (readonly InlineButton[])[];

/**
 * A link that opens the Mini App.
 *
 * `https://t.me/<bot>?startapp=<payload>` rather than a `web_app` button, for the
 * same reason M14's channel post uses it: the product has no configured Mini App
 * URL in its environment, and this form works from a plain `url` button with
 * nothing but the bot's username. The payload charset Telegram accepts is
 * `[A-Za-z0-9_-]`, so a template's `chats/<id>` becomes `chats_<id>`; anything that
 * still does not fit is dropped rather than sent broken, because a button that
 * lands somewhere wrong is worse than a button that only opens the app.
 *
 * **One caller left: the channel post** (`channel.ts`). Every open-app button on
 * a message the bot *sends somebody* is gone — it was under almost all of them,
 * which is what made it noise, and `reply_markup` holds one thing, so it was
 * also what kept the persistent menu off nearly every message. A channel post is
 * read by people who may never have started the bot, and it is the only action
 * on the post, so it keeps its button.
 */
export function openAppButton(text: string, botUsername: string, deepLink?: string): InlineButton {
  const payload = deepLink === undefined ? undefined : deepLink.replaceAll('/', '_');
  const usable = payload !== undefined && /^[A-Za-z0-9_-]{1,512}$/.test(payload);
  return {
    text,
    url: usable
      ? `https://t.me/${botUsername}?startapp=${String(payload)}`
      : `https://t.me/${botUsername}`,
  };
}

/**
 * The host's decision, in the notification that tells them about it.
 *
 * Two taps rather than "open the app, find the request, decide": the request
 * expires in 24 hours (D9), and the difference between deciding from a
 * notification and deciding from a screen you have to navigate to is the
 * difference between an answered request and an expired one.
 *
 * The third button — «گفتگو پیش از تصمیم», which opened the Mini App — is gone
 * with every other open-app button on a message the bot sends. What is left is
 * the decision itself, which is what the notification is for.
 */
export function hostDecisionKeyboard(participantPublicId: string): InlineKeyboard {
  return [
    [
      { text: '✅ پذیرش', callbackData: encodeChatCallback('accept', participantPublicId) },
      { text: '✖️ رد', callbackData: encodeChatCallback('reject', participantPublicId) },
    ],
  ];
}

/**
 * The keyboard under a relayed chat message.
 *
 * Closing lives here because here is where somebody wants it: the reply arrives in
 * Telegram, and a conversation that has run its course is ended in the same place
 * it happened rather than by finding a screen.
 */
export function chatKeyboard(
  chatPublicId: string,
  /**
   * Whether the conversation has been accepted, and contact details may
   * therefore be exchanged (report 6).
   *
   * Drawn from the payload rather than assumed, because `shareContact` is
   * OPEN-only: offering the button in an anonymous chat would be a control the
   * product already knows will answer «گفتگو باز نیست».
   */
  chatOpen = false,
): InlineKeyboard {
  const rows: InlineButton[][] = [
    /**
     * Closing, alone on the first row.
     *
     * It used to share the row with «پاسخ در برنامه». Replying does not need a
     * button at all — the message is in Telegram and the reply is typed into
     * Telegram — so the button spent a tap target on a detour, which is why it
     * went with the rest of them.
     */
    /**
     * Closing, and reporting, on the first row.
     *
     * Reporting a conversation is the one safety control that has to be where
     * the harm is happening. It was reachable only from the Mini App, and from
     * v0.4.6 — when the last button to it went — somebody being harassed in an
     * anonymous chat had no way to say so from inside Telegram.
     *
     * Beside closing rather than below it, because they are the same kind of
     * decision: this conversation should stop. Closing ends it; reporting also
     * tells somebody. Neither notifies the other party — that is the single
     * message this area must never send.
     */
    [
      { text: '🔒 بستن گفتگو', callbackData: encodeChatCallback('close', chatPublicId) },
      { text: '🚩 گزارش', callbackData: encodeReportAsk('c', chatPublicId) },
    ],
  ];

  /**
   * Sharing contact details without leaving Telegram (report 6).
   *
   * The old route was: read the message in the bot, open the Mini App, find the
   * conversation in a list, tap through a confirmation. This is the same
   * confirmed decision — `share` asks and `shareyes` does — with the two taps in
   * the place the conversation is actually happening.
   *
   * Its own row: it sits beside a destructive button, and a mis-tap here
   * discloses something that cannot be undone.
   */
  if (chatOpen) {
    rows.push([
      { text: '🤝 اشتراک اطلاعات تماس', callbackData: encodeChatCallback('share', chatPublicId) },
    ]);
  }

  return rows;
}

/**
 * A button on the persistent keyboard below the text box.
 *
 * A `ReplyKeyboard`, not an inline one. The difference is the whole point:
 * inline buttons belong to *a message* and scroll away with it, while this sits
 * under the compose box until it is replaced. That is what makes it a menu
 * rather than a prompt.
 */
export interface ReplyButton {
  text: string;
}

/** Rows of reply buttons, as Telegram lays them out. */
export type ReplyKeyboard = readonly (readonly ReplyButton[])[];

/**
 * What the bottom keyboard offers.
 *
 * ── Why these seven ─────────────────────────────────────────────────────────
 *
 * The bot answers many commands and this shows seven, because a menu that
 * lists everything is a menu nobody reads. These are the ones with a *verb* —
 * things somebody opens the bot intending to do — and the rest stay discoverable
 * through the "/" menu and `/help`.
 *
 * «تنظیمات» is the seventh, and it is here rather than behind a command
 * because that is the whole point of it: a settings screen nobody can find is a
 * settings screen nobody uses, and `/settings` exists only as a fallback for
 * somebody who types it.
 *
 * «نمایه من» is the sixth and was the one people asked for. It is not a verb,
 * but it is the answer to "what does this thing know about me, and what is my
 * trust score" — and `/profile` was previously reachable only by typing it,
 * which meant only by having read `/help` first.
 *
 * ── Why the labels are not the commands ─────────────────────────────────────
 *
 * A reply-keyboard tap sends its label as an ordinary text message, so «ساختن
 * فعالیت» arrives as that text and not as `/create_event`. `BotService` maps
 * them back — see `MENU_COMMANDS`. Labelling the buttons `/create_event` would
 * work and would put slash-commands in the chat transcript, which is exactly the
 * awkwardness this keyboard exists to remove.
 *
 * The mapping is here rather than in the bot so the label and the command it
 * stands for cannot drift into two files.
 */
export const MENU_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['➕ ساختن فعالیت', 'create_event'],
  ['🔎 دیدن فعالیت‌ها', 'discover'],
  ['🎟 فعالیت‌های من', 'myevents'],
  ['📨 درخواست‌های من', 'requests'],
  ['💬 گفتگوها', 'chats'],
  ['👤 نمایه من', 'profile'],
  ['⚙️ تنظیمات', 'settings'],
]);

/**
 * The persistent menu, in rows of two.
 *
 * `is_persistent` keeps it open rather than collapsing to an icon the moment
 * something else is sent; `resize_keyboard` stops Telegram giving six buttons
 * the height of a full phone keyboard.
 *
 * Two per row rather than three. Telegram truncates a reply-keyboard label that
 * does not fit its share of the width, and «🔎 دیدن فعالیت‌ها» is long enough
 * that three across would show some of these as an ellipsis — a menu you cannot
 * read is the problem this keyboard exists to solve.
 *
 * Chunked rather than sliced by hand, so adding a seventh label lays itself out.
 */
export function menuKeyboard(): ReplyKeyboard {
  const labels = [...MENU_COMMANDS.keys()];
  const rows: ReplyButton[][] = [];
  for (let index = 0; index < labels.length; index += 2) {
    rows.push(labels.slice(index, index + 2).map((text) => ({ text })));
  }
  return rows;
}

/**
 * Whether a plain text message is a menu tap rather than something to relay.
 *
 * Returns the command it stands for, or null. The distinction matters: a menu
 * label reaching `onText` would otherwise be relayed into an anonymous chat, and
 * the other party would receive «🎟 فعالیت‌های من» from a stranger.
 */
export function menuCommandFor(text: string): string | null {
  return MENU_COMMANDS.get(text.trim()) ?? null;
}
