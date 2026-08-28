import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { encodeChatCallback, isPublicId } from './callback-data';
import { helpCommandLines } from './commands';
import { escapeHtml, toPersianDigits } from './escape';
import {
  chatKeyboard,
  hostDecisionKeyboard,
  openAppKeyboard,
  type InlineKeyboard,
} from './keyboards';

/**
 * Every Persian message the bot sends (plan §3.2).
 *
 * A **message catalogue, not an i18n framework** — the product is fa-IR only
 * (assumption 10), and a framework here would be indirection over a single
 * locale. Keeping the text in code rather than in `notification.payload` is what
 * makes fixing a typo a deploy instead of a migration, and it means a stored
 * notification renders with today's wording rather than the wording of the day it
 * was queued.
 *
 * **Every interpolated value goes through `escapeHtml`.** Titles, display names
 * and anything else a user wrote are markup injection points under
 * `parse_mode: 'HTML'` (T9), and the escaping lives here so a new template cannot
 * forget it — the templates take structured payloads and do the escaping
 * themselves rather than accepting pre-formatted strings.
 *
 * Nothing here can render a Telegram identifier, because nothing here is given
 * one: the payloads carry public ids and display names (ADR-0009, invariant 7).
 */

export const TEMPLATES = {
  PARTICIPATION_REQUESTED_HOST: 'participation.requested.host',
  PARTICIPATION_REQUESTED_GUEST: 'participation.requested.guest',
  PARTICIPATION_ACCEPTED: 'participation.accepted',
  PARTICIPATION_REJECTED: 'participation.rejected',
  WAITLIST_PROMOTED_GUEST: 'waitlist.promoted.guest',
  WAITLIST_PROMOTED_HOST: 'waitlist.promoted.host',
  EVENT_CANCELLED: 'event.cancelled',
  CHAT_MESSAGE: 'chat.message',
  CHAT_MESSAGE_EDITED: 'chat.message_edited',
  CHAT_MESSAGE_DELETED: 'chat.message_deleted',
  /** The «آیا مطمئنید؟» step before contact details are disclosed (report 6). */
  CHAT_SHARE_CONFIRM: 'chat.share_confirm',
  REVIEW_REVEALED: 'review.revealed',
  REVIEW_WINDOW_OPEN: 'review.window_open',
  NO_SHOW_RECORDED: 'participation.no_show',
  CONTENT_HIDDEN: 'moderation.content_hidden',

  // ── What the bot says when somebody talks to *it* ──────────────────────────
  /** The reply to `/start`. */
  BOT_WELCOME: 'bot.welcome',
  /** `/start <code>` with a referral code that was accepted. */
  BOT_REFERRAL_ACCEPTED: 'bot.referral_accepted',
  /**
   * Anything the bot has to say about a request it could not carry out.
   *
   * A single passthrough template, deliberately: the Persian text comes from
   * `ERROR_MESSAGES_FA`, which is already total over `ErrorCode` (criterion 12).
   * A template per error code would be a second, partial copy of a catalogue that
   * exists — and the copy is the one that would fall behind.
   */
  BOT_NOTICE: 'bot.notice',
  /** `/help` — what the bot can do, for somebody who has only ever seen `/start`. */
  BOT_HELP: 'bot.help',
  /** `/balance` — the coin balance, without opening anything. */
  BOT_BALANCE: 'bot.balance',
  /** `/requests` — what the sender has asked to join, and where each one stands. */
  BOT_REQUESTS: 'bot.requests',
  /** `/myevents` — what the sender is hosting, and how full each one is. */
  BOT_MY_EVENTS: 'bot.my_events',
  /** `/chats` — which conversations are open, and who is waiting for a reply. */
  BOT_CHATS: 'bot.chats',
} as const;

export type TemplateKey = (typeof TEMPLATES)[keyof typeof TEMPLATES];

/** What a rendered notification becomes: text, and whether to offer a button. */
export interface RenderedMessage {
  text: string;
  /** A deep link into the Mini App, when the message is about something to open. */
  deepLink?: string;
  /** Buttons under the message, already built (see `keyboards.ts`). */
  keyboard?: InlineKeyboard;
}

type Payload = Record<string, unknown>;

function str(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? escapeHtml(value) : '';
}

function num(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === 'number' ? toPersianDigits(value) : '۰';
}

/**
 * «who — which event», for the header of a relayed message (ADR-0014).
 *
 * The name when the payload carries one and the alias when it does not, so an
 * anonymised profile degrades to «میهمان ۱ — سفر شمال» rather than to an empty
 * bold tag. The em dash is the glossary's separator for this pairing.
 *
 * A payload from an older deploy carries neither `senderName` nor `eventTitle`;
 * this renders whichever halves are present rather than emitting a stray dash,
 * because the relay must keep working across a rollout in both directions.
 */
function chatHeading(payload: Payload): string {
  const who = str(payload, 'senderName') || str(payload, 'senderAlias');
  const what = str(payload, 'eventTitle');
  if (who === '') return what;
  if (what === '') return who;
  return `${who} — ${what}`;
}

/**
 * A public id, unescaped, for a callback payload or a URL.
 *
 * Separate from `str` on purpose: escaping is for text on its way into HTML, and a
 * `callback_data` value is neither. Null when absent, so a template omits the
 * keyboard rather than emitting a button that names nothing.
 */
function id(payload: Payload, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && isPublicId(value) ? value : null;
}

/**
 * Renders a notification.
 *
 * Returns `null` for a template this build does not know, which is deliberate: a
 * notification queued by a newer deploy and processed by an older one should be
 * skipped and retried after the rollout, not crash the worker and stall the whole
 * queue behind it.
 *
 * `botUsername` is required rather than defaulted: it is what every button's link
 * is built from, and a default would turn a missing configuration value into a
 * keyboard full of links to somebody else's bot.
 */
export function render(
  templateKey: string,
  payload: Payload,
  botUsername: string,
): RenderedMessage | null {
  switch (templateKey) {
    /**
     * The one notification with something to *decide*, so it carries the decision.
     *
     * The request expires in twenty-four hours (D9), and the difference between
     * deciding from a notification and deciding from a screen somebody has to
     * navigate to is the difference between an answered request and an expired one.
     */
    case TEMPLATES.PARTICIPATION_REQUESTED_HOST: {
      const participant = id(payload, 'participantPublicId');
      const deepLink = `participants/${participant ?? ''}`;
      return {
        text:
          `<b>درخواست تازه</b>\n\n` +
          `یک نفر می‌خواهد به «${str(payload, 'eventTitle')}» بپیوندد.\n` +
          `می‌توانید پیش از تصمیم‌گیری با او گفتگو کنید.`,
        deepLink,
        ...(participant !== null
          ? { keyboard: hostDecisionKeyboard(participant, botUsername, deepLink) }
          : {}),
      };
    }

    case TEMPLATES.PARTICIPATION_REQUESTED_GUEST:
      return opened(
        `درخواست شما برای «${str(payload, 'eventTitle')}» ثبت شد.\n` +
          `تا زمان تصمیم میزبان می‌توانید در گفتگو سؤال بپرسید.`,
        `chats/${str(payload, 'chatPublicId')}`,
        botUsername,
      );

    /**
     * The one notification where the disclaimer belongs (report 8).
     *
     * Not on every message about an event — a liability line under a chat relay
     * is noise, and noise is how a disclaimer stops being read. This is the
     * moment a real-world meeting with a stranger becomes real, which is the
     * moment «احتیاط کنید» is actually advice rather than boilerplate.
     */
    case TEMPLATES.PARTICIPATION_ACCEPTED:
      return opened(
        `<b>درخواست شما پذیرفته شد</b> 🎉\n\n` +
          `«${str(payload, 'eventTitle')}»\n` +
          `از این پس می‌توانید اطلاعات تماس را در گفتگو رد و بدل کنید.\n\n` +
          `<i>${escapeHtml(EVENT_DISCLAIMER_SHORT_FA)}</i>`,
        `chats/${str(payload, 'chatPublicId')}`,
        botUsername,
      );

    case TEMPLATES.PARTICIPATION_REJECTED:
      return {
        text:
          `درخواست شما برای «${str(payload, 'eventTitle')}» پذیرفته نشد.\n` +
          `فعالیت‌های دیگری هم هست — سری بزنید.`,
      };

    /** D8: the promoted participant learns their status changed, immediately. */
    case TEMPLATES.WAITLIST_PROMOTED_GUEST:
      return opened(
        `<b>یک جا باز شد</b>\n\n` +
          `درخواست شما برای «${str(payload, 'eventTitle')}» از لیست انتظار خارج شد و ` +
          `اکنون در انتظار تصمیم میزبان است.`,
        `chats/${str(payload, 'chatPublicId')}`,
        botUsername,
      );

    /** D8: and so does the host, in the same domain event — decision buttons included. */
    case TEMPLATES.WAITLIST_PROMOTED_HOST: {
      const participant = id(payload, 'participantPublicId');
      const deepLink = `participants/${participant ?? ''}`;
      return {
        text:
          `یک درخواست از لیست انتظار به «${str(payload, 'eventTitle')}» منتقل شد و ` +
          `منتظر تصمیم شماست.`,
        deepLink,
        ...(participant !== null
          ? { keyboard: hostDecisionKeyboard(participant, botUsername, deepLink) }
          : {}),
      };
    }

    case TEMPLATES.EVENT_CANCELLED:
      return {
        text:
          `<b>این فعالیت لغو شد</b>\n\n` +
          `«${str(payload, 'eventTitle')}» توسط میزبان لغو شده است. ` +
          `اگر بابت شرکت در آن سکه‌ای پرداخت کرده بودید، به حساب شما بازگشته است.`,
      };

    /**
     * The relayed chat message.
     *
     * **Who wrote it and what it is about**, since M18 (ADR-0014). The bot's DM
     * carries every conversation a person is in, so a message headed «میهمان ۱:»
     * and nothing else was unreadable the moment somebody had two events running:
     * two different people were «میهمان ۱» and neither header said which event
     * either of them was asking about.
     *
     * `senderAlias` is still the fallback — `chatHeading` uses the name when the
     * payload has one and the alias when it does not, so an anonymised or
     * never-completed profile degrades to «میهمان ۱ — سفر شمال» rather than to a
     * blank. Nothing here is or can become a Telegram identifier; that is what
     * ADR-0009's invariant 7 protects and it is untouched.
     */
    case TEMPLATES.CHAT_MESSAGE:
      return relayed(
        `<b>${chatHeading(payload)}:</b>\n${str(payload, 'text')}`,
        payload,
        botUsername,
      );

    /**
     * The sender edited what they had said (D10).
     *
     * A **new message** rather than an edit of the delivered copy, and the marker
     * says so: nothing populates `chat_message.telegram_message_ids`, so the
     * product cannot find the recipient's copy to edit it. Delivering the corrected
     * text late is honest; delivering nothing — which is what happened before this
     * template existed — leaves the recipient acting on a sentence the sender has
     * retracted.
     */
    case TEMPLATES.CHAT_MESSAGE_EDITED:
      return relayed(
        `<b>${chatHeading(payload)}</b> <i>(ویرایش شد)</i>:\n${str(payload, 'text')}`,
        payload,
        botUsername,
      );

    /**
     * The confirmation before contact details are shared (report 6).
     *
     * Two things have to be true of this message and both are load-bearing.
     *
     * It must **not overstate what happens**: agreeing discloses nothing by
     * itself. The platform holds no phone number and will not surrender a
     * Telegram handle — what changes is that the user's own messages stop being
     * masked, so they can send their details themselves if they choose to. A
     * message that said "your contact details will be shared" would be describing
     * a thing the product does not do, and the user would act on it.
     *
     * And it must carry the button, because the whole point of this step is that
     * the *decision* happens here rather than in another application. The
     * conditional is the same one every other keyboard here has: a malformed
     * payload degrades to a plain message rather than a button that confirms
     * nothing.
     */
    case TEMPLATES.CHAT_SHARE_CONFIRM: {
      const chat = id(payload, 'chatPublicId');
      return {
        text:
          `<b>اشتراک اطلاعات تماس</b>\n\n` +
          `با تأیید، از این پس شمارهٔ تماس یا نام کاربری‌تان در پیام‌های <i>خودتان</i> پنهان ` +
          `نمی‌شود و می‌توانید آن را بفرستید.\n\n` +
          `پایه‌تَم هیچ اطلاعاتی از شما را به طرف مقابل نمی‌دهد؛ تصمیم و متن پیام با خود شماست. ` +
          `این کار برگشت‌پذیر نیست.`,
        ...(chat !== null
          ? {
              keyboard: [
                [
                  {
                    text: '✅ بله، تأیید می‌کنم',
                    callbackData: encodeChatCallback('shareyes', chat),
                  },
                ],
              ],
            }
          : {}),
      };
    }

    /** The sender deleted it. The replacement sentence comes from the domain (D10). */
    case TEMPLATES.CHAT_MESSAGE_DELETED:
      return relayed(
        `<b>${chatHeading(payload)}</b>\n<i>${str(payload, 'replacementText')}</i>`,
        payload,
        botUsername,
      );

    case TEMPLATES.REVIEW_WINDOW_OPEN:
      return opened(
        `چطور بود؟\n\n` +
          `می‌توانید تا ${num(payload, 'daysLeft')} روز آینده بازخورد خود را درباره ` +
          `«${str(payload, 'eventTitle')}» ثبت کنید.`,
        `reviews/pending`,
        botUsername,
      );

    /** D7: both sides learn at the same instant, which is why one event fans out. */
    case TEMPLATES.REVIEW_REVEALED:
      return opened(
        `<b>بازخوردها منتشر شد</b>\n\n` +
          `بازخورد «${str(payload, 'eventTitle')}» اکنون قابل مشاهده است.`,
        `reviews/pending`,
        botUsername,
      );

    case TEMPLATES.NO_SHOW_RECORDED:
      return {
        text:
          `میزبان اعلام کرده که شما در «${str(payload, 'eventTitle')}» حاضر نشده‌اید.\n` +
          `اگر این درست نیست، از بخش پشتیبانی به ما اطلاع دهید.`,
      };

    /** M12: the owner is told, and never told by whom. */
    case TEMPLATES.CONTENT_HIDDEN:
      return {
        text:
          `<b>محتوای شما موقتاً پنهان شد</b>\n\n` +
          `تعدادی گزارش دربارهٔ آن ثبت شده و در حال بررسی توسط تیم ماست. ` +
          `پس از بررسی نتیجه را به شما اطلاع می‌دهیم.`,
      };

    /**
     * The answer to `/start` — the first sentence anybody reads about the product.
     *
     * It says what the anonymity actually is, because that is the promise people
     * are being asked to rely on and «امن» on its own means nothing.
     */
    case TEMPLATES.BOT_WELCOME:
      return opened(
        `<b>به پایه‌تم خوش آمدید</b> 👋\n\n` +
          `اینجا برای فعالیت‌های گروهی کوچک — کافه و بازی، پیاده‌روی و کوهنوردی — ` +
          `همراه پیدا می‌کنید.\n\n` +
          `تا زمانی که خودتان نخواهید، نام و شمارهٔ شما به کسی نشان داده نمی‌شود؛ ` +
          `گفتگو با نام مستعار انجام می‌شود.`,
        `home`,
        botUsername,
      );

    /** `/start <code>`: the invite worked, and what it is worth is stated plainly. */
    case TEMPLATES.BOT_REFERRAL_ACCEPTED:
      return opened(
        `<b>کد دعوت ثبت شد</b> ✅\n\n` +
          `پس از شرکت در نخستین فعالیت، ${num(payload, 'pendingCoins')} سکه به حساب شما اضافه می‌شود.`,
        `home`,
        botUsername,
      );

    /**
     * `/help` — the only place the bot's own capabilities are written down.
     *
     * Until this existed every command except `/start` answered «این فرمان را
     * نمی‌شناسم», which told somebody what the bot could *not* do and nothing at
     * all about what it could. The three behaviours listed are the ones that are
     * invisible: that a reply routes to the right conversation, that the buttons
     * carry the decision, and that plain text works when only one chat is open.
     */
    case TEMPLATES.BOT_HELP:
      return opened(
        `<b>راهنما</b>\n\n` +
          `${helpCommandLines()}\n` +
          `<b>/start</b> — بازگشت به ابتدا\n\n` +
          `<b>گفتگوها</b>\n` +
          `برای پاسخ دادن، روی پیام همان گفتگو <i>reply</i> بزنید؛ ` +
          `اگر فقط یک گفتگوی باز دارید، نوشتن پیام کافی است. ` +
          `برای دیدن اینکه چه گفتگوهایی باز است، /chats را بفرستید.\n\n` +
          `<b>درخواست‌ها</b>\n` +
          `پذیرش یا رد درخواست با دکمه‌های زیر همان اعلان انجام می‌شود — ` +
          `لازم نیست چیزی را باز کنید.\n\n` +
          `بقیهٔ کارها — ساختن رویداد، جستجو، ویرایش نمایه — در برنامه انجام می‌شود.`,
        `home`,
        botUsername,
      );

    /**
     * `/balance` — a number somebody checks often, and previously could only see by
     * opening the Mini App and waiting for the home screen to load.
     *
     * The button still offers the wallet, because the balance answers "how many"
     * and the ledger answers "why", and only one of those fits in a line.
     */
    case TEMPLATES.BOT_BALANCE:
      return opened(`<b>موجودی شما</b>\n\n${num(payload, 'balance')} سکه`, `wallet`, botUsername);

    /**
     * `/requests` — the digest, built by `formatMyRequests` and passed through.
     *
     * The body arrives already rendered for the reason `BOT_NOTICE`'s does: a
     * payload holds scalars, and a list of events is not one. What is stored is
     * the snapshot the sender asked for, which is also the honest thing to keep
     * — re-rendering it six weeks later from live rows would answer a question
     * nobody asked.
     */
    case TEMPLATES.BOT_REQUESTS:
      return opened(str(payload, 'text'), `my-requests`, botUsername);

    /** `/myevents` — the host's digest, built by `formatMyEvents`. */
    case TEMPLATES.BOT_MY_EVENTS:
      return opened(str(payload, 'text'), `my-events`, botUsername);

    /**
     * `/chats` — the conversation digest, built by `formatMyChats`.
     *
     * `chats` is already in the Mini App's `DEEP_LINKS` allowlist, so the button
     * lands on the conversation list rather than the splash. Adding a template
     * whose target is *not* in that allowlist is the failure this pairing exists
     * to prevent — see `deepLinkTarget()`.
     */
    case TEMPLATES.BOT_CHATS:
      return opened(str(payload, 'text'), `chats`, botUsername);

    /** Whatever the bot has to say about a request it could not carry out. */
    case TEMPLATES.BOT_NOTICE:
      return { text: str(payload, 'text') };

    default:
      return null;
  }
}

/** A message whose only action is "open the app". */
function opened(text: string, deepLink: string, botUsername: string): RenderedMessage {
  return { text, deepLink, keyboard: openAppKeyboard(botUsername, deepLink) };
}

/**
 * A message from inside a conversation.
 *
 * Carries the reply-and-close keyboard when the payload names a chat, which every
 * relay payload does — the conditional is there so a malformed one degrades to a
 * plain message rather than a button that closes nothing.
 */
function relayed(text: string, payload: Payload, botUsername: string): RenderedMessage {
  const chat = id(payload, 'chatPublicId');
  const deepLink = `chats/${chat ?? ''}`;
  return {
    text,
    deepLink,
    ...(chat !== null
      ? { keyboard: chatKeyboard(chat, botUsername, deepLink, bool(payload, 'chatOpen')) }
      : {}),
  };
}

/**
 * A boolean from a payload, defaulting to false.
 *
 * False for an absent key on purpose: a payload written by an older deploy has no
 * `chatOpen`, and the safe reading of "we do not know whether this conversation
 * is open" is to leave the contact-sharing button off. A button that is missing
 * is a feature nobody noticed; a button that discloses somebody's details from a
 * conversation that was never accepted is a privacy incident.
 */
function bool(payload: Payload, key: string): boolean {
  return payload[key] === true;
}
