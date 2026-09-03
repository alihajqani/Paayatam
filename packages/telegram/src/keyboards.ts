import {
  encodeChatCallback,
  encodeMenuCommand,
  encodeMenuGroup,
  encodeMenuRoot,
} from './callback-data';
import { COMMAND_GROUPS, describeCommand, type CommandGroup } from './commands';
import { escapeHtml } from './escape';

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
 * The labels a bottom keyboard used to draw, and what each stands for.
 *
 * ── The keyboard is gone; this is not ───────────────────────────────────────
 *
 * v0.7.0 removed the persistent reply keyboard entirely, and every message the
 * bot sends now carries `remove_keyboard` so a client holding one drops it. That
 * does **not** make this map deletable, and the reason is the whole of why it
 * was ever separate from the layout: a reply keyboard lives on the client, and
 * until the user receives a message from this build they are still holding the
 * old one. A label this build could not resolve would be handed to `onText` and
 * **relayed into an anonymous chat**, where a stranger would receive «📨
 * درخواست‌های من».
 *
 * So every label the keyboard ever offered stays resolvable, whether or not
 * anything still draws it. This decides what a tap *means*; nothing decides what
 * is drawn any more.
 *
 * ── Why the labels are not the commands ─────────────────────────────────────
 *
 * A reply-keyboard tap sends its label as an ordinary text message, so «ساختن
 * فعالیت» arrives as that text and not as `/create_event`. That is what makes
 * the resolution necessary rather than incidental.
 */
export const MENU_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['➕ ساختن فعالیت', 'create_event'],
  ['🔎 دیدن فعالیت‌ها', 'discover'],
  ['🎟 فعالیت‌های من', 'myevents'],
  ['📨 درخواست‌های من', 'requests'],
  ['👤 نمایه من', 'profile'],
  ['⚙️ تنظیمات', 'settings'],
  ['🐞 گزارش مشکل', 'bug'],
]);

/**
 * The two commands copy names directly rather than by their category.
 *
 * They are the verbs somebody opens the bot intending to do, so «با دکمهٔ «🔎
 * دیدن فعالیت‌ها» …» is more use than naming the group it lives in. Everything
 * else is named by its category, which is one tap inside `/menu`.
 */
const QUICK_COMMANDS: readonly string[] = ['create_event', 'discover'];

/**
 * The moderation label, and why it is not in the map above (ADR-0018).
 *
 * `menuCommandFor` resolves it for anybody — because resolving it is not
 * authorising it. It was appended to a moderator's keyboard while there was a
 * keyboard; a moderator still holding one must not have the tap relayed.
 *
 * That split matters. If the label were unresolvable for a non-moderator, a
 * stranger who typed it would have it **relayed into an anonymous chat** — the
 * one thing `onText` must never do with a menu label. So it always resolves to
 * `moderate`, and `moderate` answers the same «این فرمان را نمی‌شناسم» as any
 * unknown command when there is no link. A stranger who guesses the label learns
 * exactly nothing, and a moderator's guest never sees the button.
 */
export const MODERATION_MENU_LABEL = '🛡 داوری';
export const MODERATION_MENU_COMMAND = 'moderate';

/**
 * Whether a plain text message is a tap on one of the **category** buttons.
 *
 * Returns the group's key, or null. Separate from `menuCommandFor` because the
 * two answers are different things — a command to run, versus a menu to draw —
 * and because the same rule applies to both: a label the bot cannot resolve is
 * relayed into somebody's anonymous chat, so both lookups happen before the
 * relay ever sees the text.
 */
export function menuGroupKeyFor(text: string): string | null {
  const trimmed = text.trim();
  return COMMAND_GROUPS.find((group) => group.label === trimmed)?.key ?? null;
}

/**
 * Whether a plain text message is a menu tap rather than something to relay.
 *
 * Returns the command it stands for, or null. The distinction matters: a menu
 * label reaching `onText` would otherwise be relayed into an anonymous chat, and
 * the other party would receive «🎟 فعالیت‌های من» from a stranger.
 */
/**
 * The menu button that stands for a command, for copy that has to name one.
 *
 * ── Why guidance names a button and not a command ───────────────────────────
 *
 * The bot's own advice used to read «با /discover یک فعالیت پیدا کنید» — a
 * sentence telling somebody to type something, in a product whose whole point is
 * that they never have to. It is the same shape as the settings board's «برای
 * تغییر این مورد، /edit_profile را بفرستید», and it is worse here: the advice is
 * given at the exact moment somebody is stuck.
 *
 * Reverse-looked-up rather than written out, so a renamed label cannot leave the
 * copy pointing at a button that no longer says that. Null for a command with no
 * button — `/help` and `/start` have none and are correctly named as commands,
 * because they are what somebody types when nothing else has worked.
 */
export function menuLabelFor(command: string): string | null {
  for (const [label, mapped] of MENU_COMMANDS) {
    if (mapped === command) return label;
  }
  return null;
}

/**
 * The button on the **drawn** keyboard that gets you to a command.
 *
 * ── Why `menuLabelFor` is no longer enough for copy ─────────────────────────
 *
 * `MENU_COMMANDS` is a resolver and is deliberately wider than the layout: it
 * keeps every label the keyboard has ever drawn, so a client still holding the
 * previous one is understood rather than relaying «📨 درخواست‌های من» into a
 * stranger's chat. That makes it exactly the wrong thing for a *sentence* to be
 * built from — «فهرست گفتگوها زیر دکمهٔ «💬 گفتگوها» است» names a button that is
 * no longer under anybody's compose box.
 *
 * This answers the question copy actually asks: **where do I tap?** For the two
 * verbs that keep a button of their own, that is the button. For everything
 * else it is the category the command lives in, which is one tap from the same
 * keyboard and is where the reader will find it.
 *
 * Null for a command in no group and on no button — `/start` — so the copy can
 * fall back to naming a command, which is what somebody types when nothing else
 * has worked.
 */
export function menuPathFor(command: string): string | null {
  const own = menuLabelFor(command);
  if (own !== null && QUICK_COMMANDS.includes(command)) return own;

  const group = COMMAND_GROUPS.find((candidate) => candidate.commands.includes(command));
  return group?.label ?? own;
}

export function menuCommandFor(text: string): string | null {
  const trimmed = text.trim();
  // Resolved for everybody, authorised for nobody — see `MODERATION_MENU_LABEL`.
  // A label that failed to resolve would be relayed into an anonymous chat.
  if (trimmed === MODERATION_MENU_LABEL) return MODERATION_MENU_COMMAND;
  return MENU_COMMANDS.get(trimmed) ?? null;
}

/**
 * The top level of the command menu: one button per group, plus nothing else.
 *
 * Two per row. One per row is a column of five that pushes the message off the
 * screen; three per row truncates «🆘 راهنما و پشتیبانی» to «🆘 راهنما و…», and a
 * label that cannot be read is a button that has to be guessed at.
 */
export function menuRootKeyboard(): InlineKeyboard {
  const rows: { text: string; callbackData: string }[][] = [];
  for (let index = 0; index < COMMAND_GROUPS.length; index += 2) {
    rows.push(
      COMMAND_GROUPS.slice(index, index + 2).map((group) => ({
        text: group.label,
        callbackData: encodeMenuGroup(group.key),
      })),
    );
  }
  return rows;
}

/**
 * One group's commands, and the way back.
 *
 * The back button is not optional. A menu you can descend into and not climb out
 * of is one where the only exit is typing a command — which is the thing this
 * menu exists to spare people.
 *
 * Labelled with the command's own description rather than its slash form: the
 * whole point is that somebody who does not know the commands can still find
 * what they want, and «موجودی سکه‌های شما» is what they are looking for while
 * «/balance» is what they would have had to already know.
 */
export function menuGroupKeyboard(group: CommandGroup): InlineKeyboard {
  const rows: { text: string; callbackData: string }[][] = group.commands.map((command) => [
    {
      text: describeCommand(command) ?? command,
      callbackData: encodeMenuCommand(command),
    },
  ]);
  rows.push([{ text: '‹ بازگشت به منو', callbackData: encodeMenuRoot() }]);
  return rows;
}

/**
 * The one button that opens the menu, for messages that have no keyboard of
 * their own.
 *
 * Telegram allows a message exactly one inline keyboard, and most of what this
 * bot sends already spends it — a digest on its filters, a host console on its
 * actions, a wizard on its steps. So "every command under every message" is not
 * something the platform can be made to do; what it can do is put one button
 * under the messages whose keyboard is otherwise empty, and have that button
 * lead to all of them in two taps.
 */
export function menuOpenerKeyboard(): InlineKeyboard {
  return [[{ text: '☰ فهرست دستورها', callbackData: encodeMenuRoot() }]];
}

/**
 * The menu bodies, beside the keyboards they belong to.
 *
 * Exported because a *redraw* needs the text and the keyboard together, and
 * `editMessageText` does not go through the template catalogue — so without
 * these the same two strings would exist once here and once in `BotService`,
 * which is the drift `MENU_COMMANDS` already exists to prevent.
 */
export function menuRootText(): string {
  return `<b>فهرست دستورها</b>\n\n` + `دنبال چه چیزی هستید؟ یکی از بخش‌ها را انتخاب کنید.`;
}

export function menuGroupText(group: CommandGroup): string {
  return (
    `<b>${escapeHtml(group.label)}</b>\n\n` +
    `${escapeHtml(group.hint)}\n\n` +
    `یکی را انتخاب کنید:`
  );
}
