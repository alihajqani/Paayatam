import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { encodeChatCallback, isPublicId } from './callback-data';
import { commandGroupFor, helpCommandLines } from './commands';
import { escapeHtml, toPersianDigits } from './escape';
import {
  chatKeyboard,
  hostDecisionKeyboard,
  menuGroupKeyboard,
  menuGroupText,
  menuPathFor,
  menuOpenerKeyboard,
  menuRootKeyboard,
  menuRootText,
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
  /** The host learns a guest withdrew — before a decision, or after one. */
  PARTICIPATION_CANCELLED_HOST: 'participation.cancelled.host',
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
  /**
   * The last message a blocked account receives (v0.6.5).
   *
   * The bot goes silent for a banned user — `knownUser` returns null and nothing
   * is answered — which is the right behaviour and, on its own, indistinguishable
   * from the bot being broken. Somebody blocked for a reason they can appeal, or
   * blocked in error, was left tapping a product that had stopped replying with
   * no statement that anything had happened and nobody to ask.
   *
   * Sent **before** the silence begins, which is why it is an outbox event on the
   * status change rather than a reply to their next message: after the block
   * there is no next message the bot will answer.
   */
  ACCOUNT_BLOCKED: 'account.blocked',

  // ── What the bot says when somebody talks to *it* ──────────────────────────
  /** The reply to `/start`. */
  BOT_WELCOME: 'bot.welcome',
  /** `/start <code>` with a referral code that was accepted. */
  BOT_REFERRAL_ACCEPTED: 'bot.referral_accepted',
  /**
   * The referral paid out — one event, two recipients (v0.7.0).
   *
   * The reward has always been conditional on the referred user **attending**
   * something, which is what stops a farm: accounts are free, an evening in a
   * café is not (T6). What was missing was anybody being told when the condition
   * was met, so both sides were promised coins and then found out by checking a
   * balance — or reported it as a bug. A promise is worth nothing if nobody says
   * it was kept.
   *
   * Two keys rather than one, because the two read differently: «کسی که دعوت
   * کردید…» to the referrer, «پاداش کد دعوتی که وارد کردید…» to the person who
   * used the code.
   */
  REFERRAL_QUALIFIED_REFERRER: 'referral.qualified.referrer',
  REFERRAL_QUALIFIED_REFERRED: 'referral.qualified.referred',
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
  /** `/wallet` — the balance and the ledger behind it. */
  BOT_WALLET: 'bot.wallet',
  /** `/referral` — the caller's own invite code and what it has earned. */
  BOT_REFERRAL: 'bot.referral',
  /** A host's paid or irreversible action, stated with its cost and confirmed. */
  BOT_CONFIRM_SPEND: 'bot.confirm_spend',
  /** One activity in full, with the button that joins it. */
  BOT_EVENT_DETAIL: 'bot.event_detail',
  /** `/trust` — the score, and every movement behind it. */
  BOT_TRUST: 'bot.trust',
  /** The seven reasons, under the thing being reported. */
  BOT_REPORT_REASONS: 'bot.report_reasons',
  /** `/myreviews` — what other people wrote about you, once the pair revealed. */
  BOT_RECEIVED_REVIEWS: 'bot.received_reviews',
  /** The settings board: three switches, and what is not switchable. */
  BOT_SETTINGS: 'bot.settings',
  /** Who is coming to one activity, with the host's actions on each of them. */
  BOT_PARTICIPANTS: 'bot.participants',
  /**
   * The moderation queue, for a linked moderator (v0.6.3, ADR-0018).
   *
   * A notification like any other, which is what puts it through the same
   * dedupe, the same rate limit and the same outbox as everything else the bot
   * says — invariant 11 has no staff exception.
   */
  BOT_ADMIN_CASES: 'bot.admin_cases',
  /**
   * The command menu (`/menu`), and every group screen under it.
   *
   * A passthrough like `BOT_WIZARD`: the body and the keyboard are built by the
   * caller, which knows which level of the hierarchy it is drawing. A template
   * per group would be a second copy of `COMMAND_GROUPS`.
   */
  BOT_MENU: 'bot.menu',
  /**
   * An activity the scanner held rather than published (ADR-0012).
   *
   * Its own template because it is the opposite message from
   * `BOT_EVENT_CREATED`, not a variant of it — see the renderer.
   */
  BOT_EVENT_HELD: 'bot.event_held',
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

    /**
     * Two sentences for two situations, because they ask different things of the
     * host. A withdrawal before a decision removes something from their queue and
     * needs no action; one after a decision hands a seat back, which they may
     * want to fill.
     */
    case TEMPLATES.PARTICIPATION_CANCELLED_HOST: {
      const decided = str(payload, 'statusBefore') === 'ACCEPTED';
      return {
        text:
          `<b>یک درخواست لغو شد</b>\n\n` +
          `«${str(payload, 'eventTitle')}»\n` +
          (decided
            ? `یکی از مهمان‌های پذیرفته‌شده شرکت خود را لغو کرد و یک جا آزاد شد.`
            : `درخواستی که در انتظار پاسخ شما بود، از سوی خودِ فرد لغو شد. کاری لازم نیست.`),
      };
    }

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

    /**
     * The final message, and the only one a blocked account gets.
     *
     * ── What it does and does not say ───────────────────────────────────────
     *
     * It says the account is blocked, that the bot will not answer, and where to
     * write. It does **not** say why: the reason lives in `audit_log` where a
     * moderator wrote it, it is frequently about somebody else's report, and
     * repeating it here would both disclose a complainant and invite an argument
     * with a bot that is about to stop replying. The appeal is a conversation
     * with a person, so the message's whole job is to name that person.
     *
     * The support handle is `SUPPORT_CONTACT` and arrives in the payload. When it
     * is unset the line is **omitted** rather than rendered empty — telling
     * somebody to contact support and then naming nobody is worse than a shorter
     * message.
     */
    case TEMPLATES.ACCOUNT_BLOCKED: {
      const support = str(payload, 'supportContact');
      return {
        text:
          `<b>دسترسی شما به پایه‌تَم مسدود شد</b>\n\n` +
          `از این پس ربات به پیام‌های شما پاسخ نمی‌دهد.\n\n` +
          (support === ''
            ? `اگر فکر می‌کنید اشتباهی رخ داده، از راه‌های ارتباطی اعلام‌شده با پشتیبانی تماس بگیرید.`
            : `اگر فکر می‌کنید اشتباهی رخ داده یا برای بررسی دوباره، با پشتیبانی در ارتباط باشید: ${support}`),
      };
    }

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
      return openedWithMenu(
        `<b>به پایه‌تم خوش آمدید</b> 👋\n\n` +
          `اینجا برای فعالیت‌های گروهی کوچک — کافه و بازی، پیاده‌روی و کوهنوردی — ` +
          `همراه پیدا می‌کنید.\n\n` +
          `تا زمانی که خودتان نخواهید، نام و شمارهٔ شما به کسی نشان داده نمی‌شود؛ ` +
          `گفتگو با نام مستعار انجام می‌شود.`,
        `home`,
      );

    /**
     * `/start <code>`: the invite worked, and the condition is stated in full.
     *
     * It used to say «پس از شرکت در نخستین فعالیت» and stop, which somebody
     * reasonably read as "after I press join". The reward lands when the
     * *activity has happened* and the product has settled who attended — so a
     * guest who joined, was accepted, and then watched their balance not move had
     * been told something true and unusable. All three steps are named.
     */
    case TEMPLATES.BOT_REFERRAL_ACCEPTED:
      return opened(
        `<b>کد دعوت ثبت شد</b> ✅\n\n` +
          `${num(payload, 'pendingCoins')} سکه پس از نخستین فعالیتی که در آن شرکت کنید ` +
          `به حساب شما اضافه می‌شود.\n\n` +
          `<i>یعنی: به فعالیتی «پایتم» بگویید، میزبان بپذیردتان، فعالیت برگزار شود و ` +
          `چند ساعت از پایانش بگذرد. آن‌وقت سکه‌ها را می‌گیرید و همین‌جا خبرتان می‌کنیم.</i>`,
        `home`,
      );

    /**
     * The payout, said to the person who invited.
     *
     * No name and no public id: who took up an invitation is not something the
     * inviter is told, and the count on `/referral` is where the number lives.
     */
    case TEMPLATES.REFERRAL_QUALIFIED_REFERRER:
      return {
        text:
          `<b>پاداش دعوت شما رسید</b> 🎁\n\n` +
          `کسی که با کد شما آمده بود در نخستین فعالیتش شرکت کرد، و ` +
          `${num(payload, 'referrerCoins')} سکه به حساب شما اضافه شد.`,
      };

    /** And to the person who used the code, naming the condition that was met. */
    case TEMPLATES.REFERRAL_QUALIFIED_REFERRED:
      return {
        text:
          `<b>پاداش کد دعوت رسید</b> 🎁\n\n` +
          `در نخستین فعالیتتان شرکت کردید، پس ${num(payload, 'referredCoins')} سکه ` +
          `به حساب شما اضافه شد.`,
      };

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
          `فهرست گفتگوهای باز زیر دکمهٔ «${menuPathFor('chats') ?? 'گفتگو و نظرها'}» است.\n\n` +
          `<b>درخواست‌ها</b>\n` +
          `پذیرش یا رد درخواست با دکمه‌های زیر همان اعلان انجام می‌شود — ` +
          `لازم نیست چیزی را باز کنید.\n\n` +
          `<b>بقیهٔ کارها</b>\n` +
          `لازم نیست چیزی تایپ کنید: دکمه‌های پایین صفحه — ` +
          `«${menuPathFor('create_event') ?? 'ساختن فعالیت'}»، ` +
          `«${menuPathFor('discover') ?? 'دیدن فعالیت‌ها'}»، ` +
          `«${menuPathFor('settings') ?? 'حساب من'}» — همه‌چیز را باز می‌کنند. ` +
          `فرمان‌های بالا هم کار می‌کنند، برای وقتی که تایپ کردن سریع‌تر است.`,
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

    /**
     * `/myevents` — the host's digest, built by `formatMyEvents`.
     *
     * The keyboard is what turned this from a list into a console: publishing to
     * the channel, inviting likely guests and cancelling all lived in
     * `MyEventsView` and had no bot equivalent, so a host could see their
     * activities and do nothing to them.
     */
    /**
     * The command menu, built here from `COMMAND_GROUPS` rather than passed in.
     *
     * The caller sends a group key and nothing else. That is what keeps this off
     * `escape.test.ts`'s pre-rendered exemption list, whose rule is that the body
     * must be written by this package's own renderer — a menu body assembled in
     * `BotService` would be a body this package escapes nothing in, for the sake
     * of markup it could just as well write itself.
     *
     * An unknown key renders the top level. A stale button from a build that had
     * a group this one does not should land somewhere useful, and the root is the
     * one screen that is always correct.
     */
    case TEMPLATES.BOT_MENU: {
      const group = commandGroupFor(str(payload, 'groupKey'));
      if (group === null) return { text: menuRootText(), keyboard: menuRootKeyboard() };
      return { text: menuGroupText(group), keyboard: menuGroupKeyboard(group) };
    }

    case TEMPLATES.BOT_MY_EVENTS: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `my-events`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

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

    /**
     * The profile card, with the edit **on** it.
     *
     * It has been a dead end twice. First it named a Mini App screen through a
     * button, and the button went with every other open-app button. Then it
     * named a command — «برای ویرایش، /edit_profile را بفرستید» — which is the
     * shape the settings board was fixed out of: a screen answering "how do I
     * change this?" with homework.
     *
     * The keyboard is built by the caller, because the caller is what knows
     * whether the wizards are switched on. A payload with none degrades to the
     * card alone, which is a card without an edit rather than a broken one.
     */
    case TEMPLATES.BOT_PROFILE: {
      const keyboard = parseKeyboard(payload);
      return {
        text:
          `<b>نمایه شما</b>\n\n` +
          `${str(payload, 'displayName')}\n` +
          `📍 ${str(payload, 'cityName')}\n` +
          `⭐️ امتیاز اعتماد: ${num(payload, 'trustScore')} از ۱۰۰`,
        deepLink: `profile/edit`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

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
     * where.
     *
     * **The buttons, by their own labels.** It used to name two commands, which
     * is the first thing a brand-new user reads and therefore the worst place to
     * teach them that this product is typed at. `menuPathFor` reverse-looks-up
     * the keyboard, so a renamed button cannot leave this sentence pointing at
     * one that no longer says that.
     */
    case TEMPLATES.BOT_CONSENT_ACCEPTED:
      return opened(
        `<b>ثبت شد</b> ✅\n\n` +
          `حالا می‌توانید از پایه‌تم استفاده کنید. از دکمه‌های پایین صفحه:\n` +
          `<b>${menuPathFor('discover') ?? 'دیدن فعالیت‌ها'}</b> — فعالیت‌های نزدیک شما\n` +
          `<b>${menuPathFor('create_event') ?? 'ساختن فعالیت'}</b> — ساختن فعالیت تازه`,
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
          `<b>عضویت در کانال</b>\n\n` +
          `برای استفاده از پایه‌تَم باید در همهٔ کانال‌های زیر عضو باشید.\n` +
          `پس از عضویت، «بررسی دوباره» را بزنید.`,
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
    /**
     * Registered, in the channel, and here is what else it can buy.
     *
     * The two options are explained **after** the registration rather than during
     * it, deliberately: they are not part of the price the host agreed to, and a
     * form that offers three purchases before it has produced anything is a form
     * people abandon. By this point the activity exists and is already in the
     * channel, so both options are about reaching further rather than about
     * whether the thing happens at all.
     *
     * The prices arrive on the payload, from `app_setting` via the caller. A
     * number written into this template would be a fourth place to remember on
     * the day an operator changes one — and the one that quotes a price nobody
     * will be charged.
     */
    /**
     * The activity did not publish: the scanner is holding it (ADR-0012).
     *
     * A separate template rather than a branch inside the one below, because the
     * two say opposite things. `BOT_EVENT_CREATED` congratulates a host and then
     * offers to sell them two ways of being seen more — under an activity that
     * is in a queue, that is the product taking money for reach it cannot give.
     *
     * What a held host needs is: it exists, it is not visible, somebody is
     * looking at it, and here is what usually causes this. Not *which* term
     * matched — naming it would be handing an evader the exact string to edit,
     * which is the one thing an automated list cannot survive.
     */
    case TEMPLATES.BOT_EVENT_HELD:
      return {
        text:
          `<b>فعالیت شما در انتظار بررسی است</b> ⏳\n\n` +
          `«${str(payload, 'title')}» ثبت شد، اما هنوز منتشر نشده است: ` +
          `متن آن نیاز به بررسی انسانی دارد.\n\n` +
          `بیشتر وقت‌ها دلیلش کلمه‌ای است که در فهرست فعالیت‌ها مجاز نیست — ` +
          `الکل، مواد، شرط‌بندی، سلاح یا پیشنهادهای غیرمجاز. ` +
          `اگر فکر می‌کنید اشتباه شده، منتظر بمانید؛ نتیجه به شما اطلاع داده می‌شود.\n\n` +
          `<i>سکه‌ای بابت انتشار در کانال از شما کم نشده است.</i>`,
        keyboard: menuOpenerKeyboard(),
      };

    case TEMPLATES.BOT_EVENT_CREATED:
      return opened(
        `<b>فعالیت ثبت شد</b> ✅\n\n` +
          `«${str(payload, 'title')}» ساخته شد و در کانال پایه‌تَم منتشر می‌شود.\n` +
          `از دکمهٔ «${menuPathFor('myevents') ?? 'فعالیت‌ها'}» می‌توانید ` +
          `درخواست‌ها را ببینید و پاسخ بدهید.\n\n` +
          `<b>اگر بخواهید بیشتر دیده شود:</b>\n` +
          `📨 <b>دعوت ویژه</b> — فعالیت شما با پیام اختصاصی برای حداکثر ` +
          `${str(payload, 'inviteRecipients')} نفر از مناسب‌ترین کاربران فرستاده می‌شود ` +
          `(${str(payload, 'inviteCost')} سکه).\n` +
          `🔄 <b>انتشار دوباره</b> — فعالیت دوباره در کانال منتشر می‌شود تا از نو دیده شود ` +
          `(${str(payload, 'republishCost')} سکه).\n\n` +
          `<i>هر دو از همان بخش «فعالیت‌های من»، زیر همین فعالیت.</i>`,
        `my-events`,
      );

    /**
     * `/wallet` and `/referral` — both bodies built by this package's own
     * formatters, both already escaped at every interpolation, so both go
     * through `prerendered` for the reason the five digests do.
     */
    /**
     * Both carry a keyboard now, and it is the same button in two moods: «کد
     * هدیه دارم» under the wallet, «کد معرفی دارم» under the invite screen.
     * Built by the caller because only the caller knows whether either is worth
     * offering — a user who has already been referred would be handed a button
     * whose only possible answer is «شما قبلاً با کد دعوت دیگری ثبت شده‌اید».
     */
    case TEMPLATES.BOT_WALLET: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `wallet`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    case TEMPLATES.BOT_REFERRAL: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `home`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /**
     * `/myreviews` — the reviews, each with the button that reports it.
     *
     * The keyboard is the caller's because only it holds the review public ids,
     * and those are what `POST /reviews/:publicId/report` names.
     */
    case TEMPLATES.BOT_RECEIVED_REVIEWS: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `reviews`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /**
     * The settings board — a message that redraws itself.
     *
     * Not a wizard: settings are a board you glance at and change one thing on,
     * not a sequence you complete. A wizard would also consume the single
     * `conversation_state` slot, so opening settings half-way through creating
     * an activity would silently discard the draft.
     */
    case TEMPLATES.BOT_SETTINGS: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /**
     * The moderation queue, with one button per case.
     *
     * No deep link: the panel is not a Mini App route, and a staff screen is the
     * last thing that should carry a button into an end-user application.
     */
    case TEMPLATES.BOT_ADMIN_CASES: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /** Who is coming, with a row of actions per guest. */
    case TEMPLATES.BOT_PARTICIPANTS: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        deepLink: `my-events`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /** `/trust` — the score and its ledger, built by `formatTrust`. */
    case TEMPLATES.BOT_TRUST:
      return opened(prerendered(payload), `profile/edit`);

    /**
     * The reason menu, under the thing being reported.
     *
     * A message rather than a replacement of the keyboard on whatever was tapped:
     * seven reasons do not fit under a message that is about something else, and
     * the question deserves its own screen. No deep link — there is nothing in
     * the Mini App this corresponds to any more.
     */
    case TEMPLATES.BOT_REPORT_REASONS: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /**
     * A host's paid action, asked before it is done.
     *
     * The body names the live cost — `economy.*` are settings an operator can
     * change, so it is read at the moment it is shown rather than written here.
     * The keyboard carries the confirming half; a payload with no keyboard
     * degrades to a message that explains and asks nothing, which is a dead end
     * but not a wrong charge.
     */
    /**
     * One activity in full, with «پیوستن» on it.
     *
     * The keyboard is built by the caller because only it holds the public id,
     * and it is conditional because a full or already-requested event should
     * read rather than offer — the digest's own button is where joining starts.
     */
    case TEMPLATES.BOT_EVENT_DETAIL: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        // `discover`, not `events`: the Mini App has no per-event route on the
        // allowlist, and `deep-links.test.ts` checks every target against it.
        // Nothing renders this as a button any more; the check is what it is for.
        deepLink: `discover`,
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    case TEMPLATES.BOT_CONFIRM_SPEND: {
      const keyboard = parseKeyboard(payload);
      return {
        text: prerendered(payload),
        ...(keyboard !== undefined ? { keyboard } : {}),
      };
    }

    /** Whatever the bot has to say about a request it could not carry out. */
    /**
     * Every refusal, warning and one-line answer — and the way to the commands.
     *
     * This template is what a user sees at exactly the moments they are stuck:
     * a precondition refused them, a button expired, a form closed. It has no
     * keyboard of its own, so it is the right place to spend one on the menu.
     * See `menuOpenerKeyboard` for why the menu is a button here rather than
     * nineteen buttons under every message.
     */
    case TEMPLATES.BOT_NOTICE:
      return { text: str(payload, 'text'), keyboard: menuOpenerKeyboard() };

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
 * Opened, and carrying the menu.
 *
 * For the two messages that are somebody's *first* — `/start`'s welcome and the
 * one after registering. A new user has no idea what the bot can do and no
 * reason to type `/help` to find out, so the first message it sends is the one
 * that most needs a way in.
 */
function openedWithMenu(text: string, deepLink: string): RenderedMessage {
  return { text, deepLink, keyboard: menuOpenerKeyboard() };
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
