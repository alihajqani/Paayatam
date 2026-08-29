import type { ChatStatus } from './contracts/chat';
import type { EventStatus } from './contracts/events';
import type { ParticipantStatus } from './contracts/participation';

/**
 * Sentences the product says in more than one place.
 *
 * A module rather than a literal at each call site, for the reason
 * `apps/miniapp/src/copy/privacy.ts` gives about the privacy summary: a sentence
 * that appears in four surfaces and is edited in three of them is a sentence the
 * product is now telling different stories about. Here they are one string, in
 * `@payetam/shared` because the four surfaces are the Mini App, the bot's message
 * catalogue, the channel renderer and the admin panel — and `shared` is the only
 * package all of them already depend on.
 *
 * Wording follows `docs/glossary-fa.md`: «فعالیت», polite plural, no exclamation
 * marks.
 */

/**
 * The standing disclaimer, shown above every event (report 8).
 *
 * ── Why it is one constant ───────────────────────────────────────────────────
 *
 * It is a **liability statement**, which is the kind of string that must not
 * drift: the sentence on the event page and the sentence in the channel post have
 * to be the same sentence, or the one that is missing a clause is the one somebody
 * quotes back. `EVENT_DISCLAIMER_FA` is what the Mini App renders and what the
 * channel post and the bot's event messages carry.
 *
 * ── Why there is a short form ────────────────────────────────────────────────
 *
 * A Telegram channel post has a length budget and a scan pattern; a paragraph at
 * the top of every post is a paragraph readers learn to skip, which is the failure
 * mode a disclaimer cannot afford. `EVENT_DISCLAIMER_SHORT_FA` is the same claim
 * in one line, used where the full sentence would push the event's own details
 * below the fold. Both say the two things that matter — the platform is not
 * responsible, and the user must take care — so neither is a weaker version of the
 * other.
 */
export const EVENT_DISCLAIMER_FA =
  'پایه‌تَم هیچ مسئولیتی در قبال برگزاری این فعالیت و آنچه در آن رخ می‌دهد ندارد. ' +
  'مسئولیت حضور و تصمیم‌گیری با خود شماست؛ لطفاً احتیاط کنید.';

/** The one-line form, for a channel post and anywhere else space is the constraint. */
export const EVENT_DISCLAIMER_SHORT_FA =
  '⚠️ پایه‌تَم مسئولیتی در قبال این فعالیت ندارد؛ لطفاً احتیاط کنید.';

/**
 * What each participation status is called, in Persian — **from each side**.
 *
 * ── Why there are two maps and not one ───────────────────────────────────────
 *
 * The same row is described differently depending on who is reading it, and the
 * difference is «شما». To the guest, `PENDING` is "waiting for the host's
 * answer"; to the host it is "waiting for *your* answer". `CANCELLED_BY_HOST` is
 * "the host cancelled" to one and "you cancelled" to the other. Collapsing them
 * into one map would put the wrong pronoun on one of the two screens, which is
 * worse than the duplication it removes.
 *
 * What was genuinely duplicated is each map *within* a perspective — the guest's
 * copy lived in `MyRequestsView` alone until the bot needed to say the same nine
 * things, and a request that reads «نوبت انتظار» in the app and «در صف» in the
 * bot is the same request described differently to the same person.
 *
 * Both are total over `ParticipantStatus` by type rather than by convention, so
 * adding a status to the enum fails the build here instead of rendering a raw
 * `CANCELLED_BY_HOST` at somebody.
 */
export const PARTICIPANT_STATUS_GUEST_FA: Record<ParticipantStatus, string> = {
  PENDING: 'در انتظار پاسخ میزبان',
  WAITLISTED: 'نوبت انتظار',
  ACCEPTED: 'پذیرفته شد',
  REJECTED: 'رد شد',
  EXPIRED: 'مهلت میزبان گذشت',
  CANCELLED_BY_PARTICIPANT: 'شما لغو کردید',
  CANCELLED_BY_HOST: 'میزبان لغو کرد',
  COMPLETED: 'برگزار شد',
  NO_SHOW: 'غایب ثبت شد',
};

/** The same nine statuses, as the host of the event reads them. */
export const PARTICIPANT_STATUS_HOST_FA: Record<ParticipantStatus, string> = {
  PENDING: 'در انتظار پاسخ شما',
  WAITLISTED: 'نوبت انتظار',
  ACCEPTED: 'پذیرفته‌شده',
  REJECTED: 'رد شده',
  EXPIRED: 'مهلت پاسخ گذشت',
  CANCELLED_BY_PARTICIPANT: 'خودش لغو کرد',
  CANCELLED_BY_HOST: 'شما لغو کردید',
  COMPLETED: 'برگزار شد',
  NO_SHOW: 'غایب',
};

/**
 * Every event status, in Persian.
 *
 * One map rather than two: an event's status is a fact about the event, not a
 * relationship between two people, so it reads the same to whoever is looking.
 */
export const EVENT_STATUS_FA: Record<EventStatus, string> = {
  DRAFT: 'پیش‌نویس',
  PENDING_MODERATION: 'در انتظار بررسی',
  PUBLISHED: 'منتشرشده',
  HIDDEN: 'پنهان',
  REJECTED: 'رد شده',
  CANCELLED_BY_HOST: 'لغو شده',
  ONGOING: 'در حال برگزاری',
  COMPLETED: 'برگزار شده',
  EXPIRED: 'منقضی',
  DELETED: 'حذف شده',
};

/**
 * Every chat status, in Persian.
 *
 * One map, like `EVENT_STATUS_FA` and unlike the two participant maps: a
 * conversation's status is a fact about the conversation rather than a
 * relationship between the two people in it, so «ناشناس» reads the same to the
 * host and to the guest. What differs between them — who may still write, whose
 * contact details are out — is carried by `contactShared` beside it, not by this
 * label.
 *
 * ── Why it is `Record<ChatStatus, string>` ───────────────────────────────────
 *
 * `ChatsView` held a `Record<string, string>` with three keys — `OPEN`,
 * `CLOSED`, `EXPIRED` — and fell back to `?? chat.status`. Two of the four real
 * statuses were missing and the third key is not a `ChatStatus` at all, so a
 * Persian RTL screen rendered the Latin word `ANONYMOUS` for what is the *usual*
 * state of a live conversation, and `BLOCKED` for the one place a clear sentence
 * matters most. `listForUser` filters by nothing, so both were reachable by
 * anybody with an open chat.
 *
 * Typing it over the enum is the fix that stays fixed: a fifth status fails the
 * build here instead of appearing untranslated at a user.
 */
export const CHAT_STATUS_FA: Record<ChatStatus, string> = {
  ANONYMOUS: 'ناشناس',
  OPEN: 'باز',
  CLOSED: 'بسته‌شده',
  BLOCKED: 'مسدود',
};
