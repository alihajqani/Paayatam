import { escapeHtml, toPersianDigits } from './escape';

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
  REVIEW_REVEALED: 'review.revealed',
  REVIEW_WINDOW_OPEN: 'review.window_open',
  NO_SHOW_RECORDED: 'participation.no_show',
  CONTENT_HIDDEN: 'moderation.content_hidden',
} as const;

export type TemplateKey = (typeof TEMPLATES)[keyof typeof TEMPLATES];

/** What a rendered notification becomes: text, and whether to offer a button. */
export interface RenderedMessage {
  text: string;
  /** A deep link into the Mini App, when the message is about something to open. */
  deepLink?: string;
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
 * Renders a notification.
 *
 * Returns `null` for a template this build does not know, which is deliberate: a
 * notification queued by a newer deploy and processed by an older one should be
 * skipped and retried after the rollout, not crash the worker and stall the whole
 * queue behind it.
 */
export function render(templateKey: string, payload: Payload): RenderedMessage | null {
  switch (templateKey) {
    case TEMPLATES.PARTICIPATION_REQUESTED_HOST:
      return {
        text:
          `<b>درخواست تازه</b>\n\n` +
          `یک نفر می‌خواهد به «${str(payload, 'eventTitle')}» بپیوندد.\n` +
          `می‌توانید پیش از تصمیم‌گیری با او گفتگو کنید.`,
        deepLink: `participants/${str(payload, 'participantPublicId')}`,
      };

    case TEMPLATES.PARTICIPATION_REQUESTED_GUEST:
      return {
        text:
          `درخواست شما برای «${str(payload, 'eventTitle')}» ثبت شد.\n` +
          `تا زمان تصمیم میزبان می‌توانید در گفتگو سؤال بپرسید.`,
        deepLink: `chats/${str(payload, 'chatPublicId')}`,
      };

    case TEMPLATES.PARTICIPATION_ACCEPTED:
      return {
        text:
          `<b>درخواست شما پذیرفته شد</b> 🎉\n\n` +
          `«${str(payload, 'eventTitle')}»\n` +
          `از این پس می‌توانید اطلاعات تماس را در گفتگو رد و بدل کنید.`,
        deepLink: `chats/${str(payload, 'chatPublicId')}`,
      };

    case TEMPLATES.PARTICIPATION_REJECTED:
      return {
        text:
          `درخواست شما برای «${str(payload, 'eventTitle')}» پذیرفته نشد.\n` +
          `فعالیت‌های دیگری هم هست — سری بزنید.`,
      };

    /** D8: the promoted participant learns their status changed, immediately. */
    case TEMPLATES.WAITLIST_PROMOTED_GUEST:
      return {
        text:
          `<b>یک جا باز شد</b>\n\n` +
          `درخواست شما برای «${str(payload, 'eventTitle')}» از لیست انتظار خارج شد و ` +
          `اکنون در انتظار تصمیم میزبان است.`,
        deepLink: `chats/${str(payload, 'chatPublicId')}`,
      };

    /** D8: and so does the host, in the same domain event. */
    case TEMPLATES.WAITLIST_PROMOTED_HOST:
      return {
        text:
          `یک درخواست از لیست انتظار به «${str(payload, 'eventTitle')}» منتقل شد و ` +
          `منتظر تصمیم شماست.`,
        deepLink: `participants/${str(payload, 'participantPublicId')}`,
      };

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
     * The alias, never a name — this is the notification that would break the
     * product's central promise if it carried an identity (ADR-0009).
     */
    case TEMPLATES.CHAT_MESSAGE:
      return {
        text: `<b>${str(payload, 'senderAlias')}:</b>\n${str(payload, 'text')}`,
        deepLink: `chats/${str(payload, 'chatPublicId')}`,
      };

    case TEMPLATES.REVIEW_WINDOW_OPEN:
      return {
        text:
          `چطور بود؟\n\n` +
          `می‌توانید تا ${num(payload, 'daysLeft')} روز آینده بازخورد خود را درباره ` +
          `«${str(payload, 'eventTitle')}» ثبت کنید.`,
        deepLink: `reviews/pending`,
      };

    /** D7: both sides learn at the same instant, which is why one event fans out. */
    case TEMPLATES.REVIEW_REVEALED:
      return {
        text:
          `<b>بازخوردها منتشر شد</b>\n\n` +
          `بازخورد «${str(payload, 'eventTitle')}» اکنون قابل مشاهده است.`,
        deepLink: `reviews/pending`,
      };

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

    default:
      return null;
  }
}
