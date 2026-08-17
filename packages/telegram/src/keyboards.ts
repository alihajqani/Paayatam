import { encodeChatCallback } from './callback-data';

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
 */
export function hostDecisionKeyboard(
  participantPublicId: string,
  botUsername: string,
  deepLink?: string,
): InlineKeyboard {
  return [
    [
      { text: '✅ پذیرش', callbackData: encodeChatCallback('accept', participantPublicId) },
      { text: '✖️ رد', callbackData: encodeChatCallback('reject', participantPublicId) },
    ],
    [openAppButton('گفتگو پیش از تصمیم', botUsername, deepLink)],
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
  botUsername: string,
  deepLink?: string,
): InlineKeyboard {
  return [
    [
      openAppButton('پاسخ در برنامه', botUsername, deepLink),
      { text: '🔒 بستن گفتگو', callbackData: encodeChatCallback('close', chatPublicId) },
    ],
  ];
}

/** The plain "open the app" keyboard, for a message that is only an announcement. */
export function openAppKeyboard(botUsername: string, deepLink?: string): InlineKeyboard {
  return [[openAppButton('باز کردن برنامه', botUsername, deepLink)]];
}
