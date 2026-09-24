import {
  encodeChatCallback,
  encodeDirectCallback,
  encodeEventCallback,
  encodeMenuCommand,
  encodeMenuGroup,
  encodeMenuRoot,
  encodeProfileFieldCallback,
  type ProfileFieldKey,
} from './callback-data';
import { COMMAND_GROUPS, describeCommand, type CommandGroup } from './commands';
import { escapeHtml, toPersianDigits } from './escape';

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
 * Under a message that puts a guest on an activity: the host, and the activity.
 *
 * The acceptance used to say «از صفحهٔ رویداد پیام بدهید» and carry nothing, and
 * nothing else a guest holds opens that screen — `/requests` lists titles and
 * `/discover` shows only their own city. So agreeing where to meet, which is the
 * step the whole product leads up to, began with a hunt (review H2).
 *
 * `withHost` is false for the waiting-list promotion: that guest has not been
 * accepted yet, and the page itself carries the message button for anybody who
 * wants it.
 */
export function guestEventKeyboard(eventPublicId: string, withHost = true): InlineKeyboard {
  const page = {
    text: '📄 صفحهٔ رویداد',
    callbackData: encodeEventCallback('show', eventPublicId),
  };
  return withHost
    ? [
        [
          { text: '✉️ پیام به میزبان', callbackData: encodeDirectCallback('write', eventPublicId) },
          page,
        ],
      ]
    : [[page]];
}

/**
 * The one button under the compose box (v0.8.1).
 *
 * ── Why a reply keyboard came back, and only one button of it ───────────────
 *
 * v0.7.0 removed the persistent keyboard entirely: seven labels under every
 * chat, none of which could coexist with an inline keyboard, because
 * `reply_markup` holds exactly one thing. That argument is about *seven*. It is
 * not an argument against one, and removing all of them took away the only
 * control in the product that is always on screen — so somebody halfway into a
 * form, or looking at a digest whose keyboard is spent on filters, had no way
 * back to the menu except typing a command they would have to already know.
 *
 * One button, and it opens `/menu`, which is the two-tap route to everything.
 *
 * ── How it coexists with the inline keyboards ───────────────────────────────
 *
 * `reply_markup` holds one thing **per message**, and a reply keyboard is not
 * per message: it lives on the *client* until another one replaces it. So a
 * message carrying an inline keyboard sends only that, the bottom button stays
 * where it was, and nothing is lost. The sender attaches this to messages that
 * would otherwise carry nothing — see `TelegramClient.send`, which used to send
 * `remove_keyboard` in exactly that slot.
 *
 * ── Why the label must resolve to a command ─────────────────────────────────
 *
 * Because a reply-keyboard tap arrives as **ordinary text**. `onText` checks
 * `menuCommandFor` before it offers the message to an open wizard, so this is
 * also the escape hatch out of a form — and if it did not resolve, the wizard
 * would swallow «☰ منوی اصلی» as an answer, or, with no wizard open, the bot
 * would answer it as a stray message. That is the whole reason `MENU_COMMANDS`
 * outlives whatever is drawn.
 */
export const MAIN_MENU_LABEL = '☰ منوی اصلی';

/**
 * The bottom keyboard, as plain data.
 *
 * `is_persistent` so it does not collapse into the paperclip after one use, and
 * `resize_keyboard` so one button is one button's worth of height rather than a
 * third of the screen. `one_time_keyboard` is deliberately absent: the point is
 * that it is always there.
 */
export interface ReplyKeyboard {
  keyboard: readonly (readonly { text: string }[])[];
  resize_keyboard: true;
  is_persistent: true;
}

/**
 * The bottom keyboard, and the one row that is not drawn for everybody.
 *
 * `moderator` is a required argument rather than an optional flag on purpose:
 * every caller has to decide, because the answer is not "add a button" but
 * "which keyboard does this client end up holding". A reply keyboard lives on
 * the *client* and a new one **replaces** whatever is there, so a send that
 * passed `false` for a linked moderator would take their button away until the
 * next message that happened to pass `true` — a button that flickers by sender
 * is worse than one that was never drawn.
 *
 * Which is also why this takes the answer rather than computing it: resolving a
 * Telegram id against the staff table is a database question, and this package
 * does no I/O (ADR-0018 resolves it per update, in the worker).
 */
export function mainMenuReplyKeyboard({ moderator }: { moderator: boolean }): ReplyKeyboard {
  return {
    keyboard: moderator
      ? [[{ text: MAIN_MENU_LABEL }], [{ text: MODERATION_MENU_LABEL }]]
      : [[{ text: MAIN_MENU_LABEL }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * Every label a bottom keyboard has ever drawn, and what each stands for.
 *
 * ── Wider than what is drawn, deliberately ──────────────────────────────────
 *
 * v0.7.0 drew none of these and v0.8.1 draws exactly one of them — two for a
 * moderator, whose second button is deliberately not in this map — and the map
 * still carries every one of them. That is the whole reason it was ever separate from the
 * layout: a reply keyboard lives on the *client*, so until a user receives a
 * message from this build they are still holding whichever one they were given.
 * A label this build could not resolve would fall through `onText` to the
 * «پیام شما را دریافت کردم» answer — and before v0.8.0, into an anonymous chat,
 * where a stranger received «📨 درخواست‌های من».
 *
 * So every label stays resolvable whether or not anything draws it. This decides
 * what a tap *means*; `mainMenuReplyKeyboard` decides what is drawn.
 *
 * ── Why the labels are not the commands ─────────────────────────────────────
 *
 * A reply-keyboard tap sends its label as an ordinary text message, so «ساختن
 * رویداد» arrives as that text and not as `/create_event`. That is what makes
 * the resolution necessary rather than incidental.
 */
export const MENU_COMMANDS: ReadonlyMap<string, string> = new Map([
  [MAIN_MENU_LABEL, 'menu'],
  ['➕ ساختن رویداد', 'create_event'],
  ['🔎 دیدن رویدادها', 'discover'],
  ['🎟 رویدادهای من', 'myevents'],
  ['📨 درخواست‌های من', 'requests'],
  ['👤 پروفایل من', 'profile'],
  ['⚙️ تنظیمات', 'settings'],
  ['🐞 گزارش مشکل', 'bug'],
  // The same three as drawn before v0.18.4 called an event «فعالیت». Kept after
  // the new ones, so `menuLabelFor` answers with the new wording, and kept at
  // all because a reply keyboard lives on the client (see above).
  ['➕ ساختن فعالیت', 'create_event'],
  ['🔎 دیدن فعالیت‌ها', 'discover'],
  ['🎟 فعالیت‌های من', 'myevents'],
  // And the profile label from before v0.18.5 called it «نمایه», for the same reason.
  ['👤 نمایه من', 'profile'],
]);

/**
 * The moderation label, and why it is not in the map above (ADR-0018).
 *
 * `menuCommandFor` resolves it for anybody — because resolving it is not
 * authorising it. It is appended to a linked moderator's keyboard and to no
 * other, and a moderator whose link was revoked is still holding one; neither
 * they nor a stranger who guesses the label must have the tap relayed.
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
  return (
    COMMAND_GROUPS.find((group) => group.label === trimmed)?.key ??
    LEGACY_GROUP_LABELS.get(trimmed) ??
    null
  );
}

/**
 * Group labels as they read before v0.18.4 renamed «فعالیت» to «رویداد», still
 * resolved for the same reason `MENU_COMMANDS` keeps old labels: text a client
 * may still be holding must not fall through to «پیام شما را دریافت کردم».
 */
const LEGACY_GROUP_LABELS: ReadonlyMap<string, string> = new Map([['🎟 فعالیت‌ها', 'ev']]);

/**
 * Whether a plain text message is a menu tap rather than something to relay.
 *
 * Returns the command it stands for, or null. The distinction matters: a menu
 * label reaching `onText` would otherwise be relayed into an anonymous chat, and
 * the other party would receive «🎟 رویدادهای من» from a stranger.
 */
/**
 * The menu button that stands for a command, for copy that has to name one.
 *
 * ── Why guidance names a button and not a command ───────────────────────────
 *
 * The bot's own advice used to read «با /discover یک رویداد پیدا کنید» — a
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
 * This answers the question copy actually asks: **where do I tap?** It is the
 * category the command lives in, which is one tap inside «☰ منوی اصلی».
 *
 * It used to return «➕ ساختن رویداد» and «🔎 دیدن رویدادها» for the two verbs,
 * on the grounds that they kept buttons of their own. They stopped being drawn
 * in v0.8.1 and the copy kept naming them (review M2).
 *
 * Null for a command in no group, so the copy can fall back to naming a
 * command, which is what somebody types when nothing else has worked.
 */
export function menuPathFor(command: string): string | null {
  const group = COMMAND_GROUPS.find((candidate) => candidate.commands.includes(command));
  return group?.label ?? null;
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
/**
 * The five fields of a profile, two to a row (v0.9.1).
 *
 * Two per row rather than one, because five single-button rows is a screen you
 * scroll to read; and rather than three, because the Persian labels wrap at
 * three on a narrow phone and a wrapped button label is unreadable.
 *
 * **No gender button.** Gender is asked once, at completion, and is not a
 * self-service edit afterward (v0.17.0) — only support may change it.
 *
 * «همه را پشت سر هم» is last and deliberately still offered: completing a
 * profile from scratch really is all seven questions, and somebody who has just
 * arrived should not have to tap five buttons to answer them.
 */
/** The heading over the board. One line: the buttons say the rest. */
export function profileEditText(): string {
  return '<b>ویرایش پروفایل</b>\n\nکدام بخش را می‌خواهید عوض کنید؟';
}

export function profileEditKeyboard(): InlineKeyboard {
  const fields: { text: string; field: ProfileFieldKey }[] = [
    { text: '👤 نام نمایشی', field: 'name' },
    { text: '🎂 سال تولد', field: 'birth' },
    { text: '📍 استان و شهر', field: 'loc' },
    { text: '📝 درباره من', field: 'bio' },
    { text: '🏷 علاقه‌مندی‌ها', field: 'tags' },
  ];

  const rows: { text: string; callbackData: string }[][] = [];
  for (let index = 0; index < fields.length; index += 2) {
    rows.push(
      fields.slice(index, index + 2).map((entry) => ({
        text: entry.text,
        callbackData: encodeProfileFieldCallback(entry.field),
      })),
    );
  }
  return rows;
}

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
export function menuRootText(status?: MenuStatus): string {
  return (
    `<b>فهرست دستورها</b>\n\n` +
    menuStatusLine(status) +
    `دنبال چه چیزی هستید؟ یکی از بخش‌ها را انتخاب کنید.`
  );
}

/** What is waiting on the reader, read when the menu is drawn (plan 18 item 3). */
export interface MenuStatus {
  /** PENDING requests on activities the reader hosts. */
  pendingForMe: number;
  /** Review windows open for the reader and not yet written. */
  reviewsOwed: number;
  balance: number;
}

/**
 * «📥 ۲ درخواست منتظر پاسخ شما · ⭐️ ۱ نظر مانده · 🪙 ۴۵ سکه».
 *
 * Zeros are left out rather than listed, so an empty line is no line: «۰ درخواست»
 * is noise on the one screen everybody opens, and somebody with nothing waiting
 * sees the menu exactly as it was.
 */
function menuStatusLine(status: MenuStatus | undefined): string {
  if (status === undefined) return '';
  const parts: string[] = [];
  if (status.pendingForMe > 0) {
    parts.push(`📥 ${toPersianDigits(String(status.pendingForMe))} درخواست منتظر پاسخ شما`);
  }
  if (status.reviewsOwed > 0) {
    parts.push(`⭐️ ${toPersianDigits(String(status.reviewsOwed))} نظر مانده`);
  }
  if (status.balance > 0) parts.push(`🪙 ${toPersianDigits(String(status.balance))} سکه`);
  return parts.length === 0 ? '' : `${parts.join(' · ')}\n\n`;
}

export function menuGroupText(group: CommandGroup): string {
  return (
    `<b>${escapeHtml(group.label)}</b>\n\n` +
    `${escapeHtml(group.hint)}\n\n` +
    `یکی را انتخاب کنید:`
  );
}
