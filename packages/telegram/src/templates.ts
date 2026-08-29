import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { encodeChatCallback, isPublicId } from './callback-data';
import { helpCommandLines } from './commands';
import { escapeHtml, toPersianDigits } from './escape';
import { chatKeyboard, hostDecisionKeyboard, type InlineKeyboard } from './keyboards';

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
  /** `/profile` — who the product thinks you are, including your Trust Score. */
  BOT_PROFILE: 'bot.profile',
  /** `/discover` — what is on in the sender's city, without opening anything. */
  BOT_DISCOVER: 'bot.discover',
  /** `/reviews` — the reviews the sender still owes, and when they expire. */
  BOT_REVIEWS: 'bot.reviews',
  /**
   * A conversation wizard's screen (ADR-0017).
   *
   * A passthrough, like `BOT_NOTICE`: the body and the keyboard are built by
   * `renderStep` and `renderSummary`, which know the step. A template per step
   * would be a second copy of the wizard definition, and the copy is the one
   * that falls behind.
   *
   * Only the **first** screen is a notification. Every screen after it is an
   * `editMessageText` job on the same message, which is what makes a wizard a
   * screen rather than a transcript.
   */
  BOT_WIZARD: 'bot.wizard',
  /** The event exists. Said once, with the way to open it. */
  BOT_EVENT_CREATED: 'bot.event_created',
  /** The policies are accepted and the gate is clear (ADR-0017). */
  BOT_CONSENT_ACCEPTED: 'bot.consent_accepted',
  /** The channel requirement stands, with a button per channel to join. */
  BOT_CHANNEL_GATE: 'bot.channel_gate',
  /** `/terms` for somebody already up to date: what they accepted, and when. */
  BOT_TERMS_STANDING: 'bot.terms_standing',
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

/**
 * A body that is **already** HTML, passed through unescaped.
 *
 * Two callers. `BOT_WIZARD`, whose text comes from `renderStep`; and
 * `prerendered`, for the six digest bodies the formatters in this package build.
 * Both emit their own `<b>`/`<i>` and both have already escaped every
 * user-supplied value they interpolated — a prompt, an event title, a stranger's
 * display name. Running `escapeHtml` over that a second time turns their markup
 * into visible `&lt;i&gt;`, which is what it did until this existed.
 *
 * **The contract is one-directional and narrow:** a template may use this only
 * when the value was produced by this package's own renderer, and only when that
 * renderer has a test proving it escapes. Anything that originates with a user
 * goes through `str`.
 */
function raw(payload: Payload, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A body that was rendered as HTML before it was ever put in a payload.
 *
 * `formatMyEvents`, `formatMyRequests`, `formatMyChats`, `formatDiscovered`,
 * `formatPendingReviews` and `formatStanding` all build `<b>`-marked lists and
 * all call `escapeHtml` on every value they interpolate. Passing their output
 * through `str` escaped it a **second** time, so the tags survived as text and
 * `/myevents` answered with a literal `<b>سفر شمال</b>` — five commands and
 * `/terms` reading like a view-source of themselves.
 *
 * `raw` under a name that says which invariant is carrying the safety: the
 * escaping happened at the formatter, one interpolation at a time, which is the
 * only place that can tell a stranger's event title from the markup around it.
 * Anything reaching this that was *not* built by one of those formatters is a
 * bug in its caller, not something a second `escapeHtml` here would fix.
 */
function prerendered(payload: Payload): string {
  return raw(payload, 'text');
}

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
 * It no longer takes a bot username. Every button built from one was an
 * "open the app" link, and those are gone — see `opened()`. What is left is
 * callback data, which addresses a row in our own database and needs no host.
 */
export function render(templateKey: string, payload: Payload): RenderedMessage | null {
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
      const deepLink = HOST_DECISION_SCREEN;
      return {
        text:
          `<b>درخواست تازه</b>\n\n` +
          `یک نفر می‌خواهد به «${str(payload, 'eventTitle')}» بپیوندد.\n` +
          `می‌توانید پیش از تصمیم‌گیری با او گفتگو کنید.`,
        deepLink,
        ...(participant !== null ? { keyboard: hostDecisionKeyboard(participant) } : {}),
      };
    }

    case TEMPLATES.PARTICIPATION_REQUESTED_GUEST:
      return opened(
        `درخواست شما برای «${str(payload, 'eventTitle')}» ثبت شد.\n` +
          `تا زمان تصمیم میزبان می‌توانید در گفتگو سؤال بپرسید.`,
        `chats/${str(payload, 'chatPublicId')}`,
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
      );

    /** D8: and so does the host, in the same domain event — decision buttons included. */
    case TEMPLATES.WAITLIST_PROMOTED_HOST: {
      const participant = id(payload, 'participantPublicId');
      const deepLink = HOST_DECISION_SCREEN;
      return {
        text:
          `یک درخواست از لیست انتظار به «${str(payload, 'eventTitle')}» منتقل شد و ` +
          `منتظر تصمیم شماست.`,
        deepLink,
        ...(participant !== null ? { keyboard: hostDecisionKeyboard(participant) } : {}),
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
      return relayed(`<b>${chatHeading(payload)}:</b>\n${str(payload, 'text')}`, payload);

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
      );

    case TEMPLATES.REVIEW_WINDOW_OPEN:
      return opened(
        `چطور بود؟\n\n` +
          `می‌توانید تا ${num(payload, 'daysLeft')} روز آینده بازخورد خود را درباره ` +
          `«${str(payload, 'eventTitle')}» ثبت کنید.`,
        `reviews/pending`,
      );

    /** D7: both sides learn at the same instant, which is why one event fans out. */
    case TEMPLATES.REVIEW_REVEALED:
      return opened(
        `<b>بازخوردها منتشر شد</b>\n\n` +
          `بازخورد «${str(payload, 'eventTitle')}» اکنون قابل مشاهده است.`,
        `reviews/pending`,
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
      );

    /** `/start <code>`: the invite worked, and what it is worth is stated plainly. */
    case TEMPLATES.BOT_REFERRAL_ACCEPTED:
      return opened(
        `<b>کد دعوت ثبت شد</b> ✅\n\n` +
          `پس از شرکت در نخستین فعالیت، ${num(payload, 'pendingCoins')} سکه به حساب شما اضافه می‌شود.`,
        `home`,
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
          `<b>بقیهٔ کارها</b>\n` +
          `ساختن فعالیت با /create_event، ویرایش نمایه با /edit_profile، ` +
          `و دیدن فعالیت‌های نزدیک با /discover — همه همین‌جا در ربات.`,
        `home`,
      );

    /**
     * `/balance` — a number somebody checks often, and previously could only see by
     * opening the Mini App and waiting for the home screen to load.
     *
     * `wallet` stays as the deep link although no button spends it: the balance
     * answers "how many" and the ledger answers "why", and the ledger still has
     * no bot command. See the retirement plan's §3 — that is the outstanding
     * work, not this line.
     */
    case TEMPLATES.BOT_BALANCE:
      return opened(`<b>موجودی شما</b>\n\n${num(payload, 'balance')} سکه`, `wallet`);

    /**
     * `/requests` — the digest, built by `formatMyRequests` and passed through.
     *
     * The body arrives already rendered for the reason `BOT_NOTICE`'s does: a
     * payload holds scalars, and a list of events is not one. What is stored is
     * the snapshot the sender asked for, which is also the honest thing to keep
     * — re-rendering it six weeks later from live rows would answer a question
     * nobody asked.
     */
    case TEMPLATES.BOT_REQUESTS: {
      // «لغو» per live request, numbered to match. Built by the caller, which is
      // the only place the participant public ids are.
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `my-requests`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /** `/myevents` — the host's digest, built by `formatMyEvents`. */
    case TEMPLATES.BOT_MY_EVENTS:
      return opened(prerendered(payload), `my-events`);

    /**
     * `/chats` — the conversation digest, built by `formatMyChats`.
     *
     * `chats` is on the Mini App's `DEEP_LINKS` allowlist, and stays named here
     * even though nothing renders it as a button any more: `deep-links.test.ts`
     * checks every template's target against that allowlist, and a template
     * pointing at a route that does not exist is the failure that pairing exists
     * to catch — see `deepLinkTarget()`.
     */
    case TEMPLATES.BOT_CHATS:
      return opened(prerendered(payload), `chats`);

    /**
     * `/profile` — and the only place in the product that shows you your own
     * Trust Score.
     *
     * `GET /me/trust` has existed since M18 and `TrustBadge` renders *other*
     * people's scores on two screens, but no Mini App view has ever shown the
     * caller theirs. ADR-0007's «a score nobody can account for is a score
     * nobody can appeal» is hard to act on when you cannot see the number.
     *
     * Rendered as a number without the `TrustBadge` fallback, and that is
     * correct rather than an oversight: `scoreOf` returns the configured
     * starting score for an account with no ledger row, so there is no `null`
     * to stand in for. «تازه‌وارد» exists because *somebody else's* score can be
     * genuinely unknown — your own never is.
     *
     * The deep link names `profile/edit` rather than `profile`, because
     * `/profile` is an onboarding step the router bounces a finished user away
     * from. `/edit_profile` is the bot's own answer to the same question.
     */
    /**
     * `/discover` — the digest, built by `formatDiscovered`, disclaimer included.
     *
     * The deep link names `discover`, where the fourteen filters this command
     * deliberately does not ask about actually live. There is no button on it
     * any more — see `opened()` — which makes those filters app-only in
     * practice, and is the open question in the retirement plan's §7.
     *
     * **The keyboard is what makes the list actionable.** One «پیوستن» per
     * numbered event, built by the caller because only it holds the public ids;
     * a digest with no buttons was a catalogue you could read and not act on,
     * which is what discovery had been since the open-app button went.
     */
    case TEMPLATES.BOT_DISCOVER: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `discover`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /**
     * `/reviews` — the pending digest, built by `formatPendingReviews`.
     *
     * `reviews/pending` was already on the allowlist, put there for
     * `REVIEW_WINDOW_OPEN`; it resolves to `/reviews`, which is the screen with
     * the form on it.
     */
    case TEMPLATES.BOT_REVIEWS: {
      // A row of five ratings per pending review, in the digest's order.
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `reviews/pending`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    case TEMPLATES.BOT_PROFILE:
      return opened(
        `<b>نمایه شما</b>\n\n` +
          `${str(payload, 'displayName')}\n` +
          `📍 ${str(payload, 'cityName')}\n` +
          `⭐️ امتیاز اعتماد: ${num(payload, 'trustScore')} از ۱۰۰\n\n` +
          // The card used to be a dead end: it named a Mini App screen through a
          // button, and the button is gone. The way to change any of this is a
          // command, and it is on the card rather than in `/help`.
          `<i>برای ویرایش، /edit_profile را بفرستید.</i>`,
        `profile/edit`,
      );

    /**
     * A wizard screen. The keyboard arrives already built, as JSON.
     *
     * Parsed rather than reconstructed because `renderStep` has already decided
     * the layout — which page of cities, which month, whether «بازگشت» applies —
     * and none of that is recoverable from a payload of scalars. A malformed one
     * degrades to a message with no buttons rather than throwing inside `render`,
     * which would fail the send job and then every retry of it.
     */
    case TEMPLATES.BOT_WIZARD: {
      const keyboard = parseKeyboard(payload);
      // `raw`, not `str`: see the note on `raw`. `renderStep` has already escaped
      // everything inside this that came from a user.
      return { text: raw(payload, 'text'), ...(keyboard !== undefined ? { keyboard } : {}) };
    }

    /**
     * The gate is clear.
     *
     * It names what just became possible rather than saying «متشکریم»: somebody
     * who has just been stopped by a gate wants to know they can proceed, and
     * which commands are the way in.
     */
    case TEMPLATES.BOT_CONSENT_ACCEPTED:
      return opened(
        `<b>ثبت شد</b> ✅\n\n` +
          `حالا می‌توانید از پایه‌تم استفاده کنید:\n` +
          `<b>/discover</b> — دیدن فعالیت‌های نزدیک\n` +
          `<b>/create_event</b> — ساختن فعالیت تازه`,
        `home`,
      );

    /**
     * The channel requirement, with a **button** per channel.
     *
     * Buttons rather than links in the body, because a `<a href>` inside a
     * notice would have to survive `escapeHtml` — and the template that carries
     * arbitrary sentences must keep escaping them. A URL button carries the link
     * outside the text entirely, which is both safer and a larger tap target.
     */
    case TEMPLATES.BOT_CHANNEL_GATE: {
      const keyboard = parseKeyboard(payload);
      return {
        text:
          `<b>عضویت در کانال</b>\n\n` + `برای ادامه، در کانال‌های زیر عضو شوید و دوباره تلاش کنید.`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /**
     * `/terms`, for somebody who owes nothing.
     *
     * `raw`-free: the body is built from policy titles, which are operator text
     * from `policy_version`, and `str` escapes it. That is the right choice even
     * though an operator is not an attacker — a title with an ampersand in it
     * should render, not break the message.
     */
    case TEMPLATES.BOT_TERMS_STANDING:
      return opened(prerendered(payload), `home`);

    /** The event exists, and here is the way to it. */
    case TEMPLATES.BOT_EVENT_CREATED:
      return opened(
        `<b>فعالیت ثبت شد</b> ✅\n\n` +
          `«${str(payload, 'title')}» ساخته شد. ` +
          `از «رویدادهای من» می‌توانید درخواست‌ها را ببینید و پاسخ بدهید.`,
        `my-events`,
      );

    /** Whatever the bot has to say about a request it could not carry out. */
    case TEMPLATES.BOT_NOTICE:
      return { text: str(payload, 'text') };

    default:
      return null;
  }
}

/**
 * Where a host goes to decide on a request.
 *
 * It was `participants/<id>`, and **there has never been a `/participants`
 * route.** `deepLinkTarget()` resolves a start param against a fixed allowlist
 * and returns null for anything else, so the «باز کردن برنامه» button on the two
 * notifications a host most needs to act on — a new join request, and a waitlist
 * promotion — silently opened the splash screen. A request expires in
 * twenty-four hours (D9); a button that goes nowhere is how it expires.
 *
 * These two escaped the 2026-08-28 sweep because they build their target inline
 * rather than through `opened()`, so they did not look like the others.
 * `deep-links.test.ts` now checks every template against the allowlist, which is
 * what found them.
 *
 * The button itself is gone now, and the target is kept anyway: the allowlist
 * check is what would notice a template pointing somewhere that does not exist,
 * and it is worth more standing than a field nobody renders is worth deleting.
 *
 * The participant id is dropped rather than relocated: no route reads it, and
 * `MyEventsView` — which is where accept and reject actually live — lists the
 * pending requests for every event the caller hosts.
 */
const HOST_DECISION_SCREEN = 'my-events';

/**
 * A keyboard a caller already built, carried through the payload as JSON.
 *
 * Undefined on anything unreadable. A notification payload is jsonb and this is
 * the one template whose buttons are not derivable from its scalars, so the
 * choice is between carrying them and rebuilding the wizard's layout decisions
 * inside the renderer — which would be the wizard, twice.
 */
function parseKeyboard(payload: Payload): InlineKeyboard | undefined {
  const raw = payload['keyboard'];
  if (typeof raw !== 'string') return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as InlineKeyboard) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A message that used to carry an "open the app" button, and no longer does.
 *
 * ── Why the button is gone ──────────────────────────────────────────────────
 *
 * It was under **almost every message the bot sends**, which is what made it
 * noise: a notification about a request, a balance, a digest and a welcome all
 * ended in the same «باز کردن برنامه», so the one place it was the actual next
 * step read like the twenty places it was not.
 *
 * It cost more than attention. `reply_markup` holds one thing, so a message with
 * inline buttons cannot also carry the persistent menu — and `opened()` put
 * buttons on nearly everything, so the menu almost never went out. Removing this
 * is what makes the menu re-attach on every message that has no buttons of its
 * own, which is now most of them.
 *
 * ── Why `deepLink` stays ────────────────────────────────────────────────────
 *
 * It names the screen this message is about, and `deepLinkTarget()` asserts that
 * every one of them is on the Mini App's allowlist. That check is worth keeping
 * whether or not a button spends it today.
 */
function opened(text: string, deepLink: string): RenderedMessage {
  return { text, deepLink };
}

/**
 * A message from inside a conversation.
 *
 * Carries the close-and-share keyboard when the payload names a chat, which every
 * relay payload does — the conditional is there so a malformed one degrades to a
 * plain message rather than a button that closes nothing.
 *
 * There is no "reply" button, and there never needed to be one: the message is
 * in Telegram and the reply is typed into Telegram. It used to open the Mini App
 * to do that, which was a detour spending the row's first tap target.
 */
function relayed(text: string, payload: Payload): RenderedMessage {
  const chat = id(payload, 'chatPublicId');
  return {
    text,
    deepLink: `chats/${chat ?? ''}`,
    ...(chat !== null ? { keyboard: chatKeyboard(chat, bool(payload, 'chatOpen')) } : {}),
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
