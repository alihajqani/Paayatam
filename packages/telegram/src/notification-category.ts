import { TEMPLATES } from './templates';

/**
 * What kind of thing a notification is, so a preference can act on it (v0.6.1).
 *
 * ── Why the mapping lives here ──────────────────────────────────────────────
 *
 * Beside the templates it classifies. A category kept in the worker would drift
 * the moment somebody added a template and did not think about preferences —
 * and the failure of that drift is silent: a new notification defaults to
 * whatever the fallback is, forever, and nobody finds out.
 *
 * `notification-category.test.ts` asserts **every** key in `TEMPLATES` has an
 * entry, so adding one without classifying it fails the build rather than
 * shipping.
 *
 * ── `essential` is the important one ────────────────────────────────────────
 *
 * Consent, moderation outcomes, account state and everything the bot says in
 * direct answer to a command are not notifications somebody opts out of. Two
 * different reasons, both load-bearing:
 *
 *  * **Obligation.** A preference that could silence `CONTENT_HIDDEN` would hide
 *    a moderation decision from the person it was made about.
 *  * **Causation.** `BOT_WALLET` is the reply to a tap. Suppressing it would
 *    make the bot appear broken to somebody who had turned off "campaigns" a
 *    month earlier and forgotten.
 *
 * So the rule is: a preference silences things the product decided to send you.
 * It never silences an answer to something you just did, and never silences
 * something you are entitled to know.
 */
export type NotificationCategory = 'chat' | 'events' | 'campaigns' | 'essential';

const CATEGORY: Record<string, NotificationCategory> = {
  // ── Activity lifecycle ────────────────────────────────────────────────────
  [TEMPLATES.PARTICIPATION_REQUESTED_HOST]: 'events',
  [TEMPLATES.PARTICIPATION_REQUESTED_GUEST]: 'events',
  [TEMPLATES.PARTICIPATION_ACCEPTED]: 'events',
  [TEMPLATES.PARTICIPATION_REJECTED]: 'events',
  [TEMPLATES.WAITLIST_PROMOTED_GUEST]: 'events',
  [TEMPLATES.WAITLIST_PROMOTED_HOST]: 'events',
  [TEMPLATES.EVENT_CANCELLED]: 'events',
  [TEMPLATES.REVIEW_WINDOW_OPEN]: 'events',
  [TEMPLATES.REVIEW_REVEALED]: 'events',

  // ── Conversations ─────────────────────────────────────────────────────────
  [TEMPLATES.CHAT_MESSAGE]: 'chat',
  // A direct message and its read receipt. `chat`, not `events`: it is somebody
  // writing to you, which is what that preference is about — and somebody who has
  // turned conversation messages off has said they do not want to be written to.
  [TEMPLATES.DIRECT_MESSAGE_RECEIVED]: 'chat',
  [TEMPLATES.DIRECT_MESSAGE_SEEN]: 'chat',
  [TEMPLATES.CHAT_MESSAGE_EDITED]: 'chat',
  [TEMPLATES.CHAT_MESSAGE_DELETED]: 'chat',
  // The confirmation before contact details are shared is a *decision screen*,
  // not news: it appears because the user tapped «اشتراک اطلاعات تماس», and
  // suppressing it would strand them mid-disclosure.
  [TEMPLATES.CHAT_SHARE_CONFIRM]: 'essential',

  // ── Things somebody is entitled to know ───────────────────────────────────
  [TEMPLATES.NO_SHOW_RECORDED]: 'essential',
  // Coins landing in an account. `essential` rather than `campaigns`: this is not
  // the product advertising itself, it is the product reporting that money
  // changed hands — and a preference that could silence it would leave somebody
  // with a balance they cannot account for, which is what ADR-0007 exists to
  // prevent.
  [TEMPLATES.REFERRAL_QUALIFIED_REFERRER]: 'essential',
  [TEMPLATES.REFERRAL_QUALIFIED_REFERRED]: 'essential',
  [TEMPLATES.CONTENT_HIDDEN]: 'essential',
  [TEMPLATES.CONTENT_RESTORED]: 'essential',
  [TEMPLATES.BOT_CONSENT_ACCEPTED]: 'essential',
  [TEMPLATES.BOT_CHANNEL_GATE]: 'essential',
  [TEMPLATES.BOT_TERMS_STANDING]: 'essential',

  // ── Answers to something the user just did ────────────────────────────────
  [TEMPLATES.BOT_WELCOME]: 'essential',
  [TEMPLATES.BOT_REFERRAL_ACCEPTED]: 'essential',
  [TEMPLATES.BOT_NOTICE]: 'essential',
  [TEMPLATES.BOT_HELP]: 'essential',
  [TEMPLATES.BOT_BALANCE]: 'essential',
  [TEMPLATES.BOT_REQUESTS]: 'essential',
  [TEMPLATES.BOT_MY_EVENTS]: 'essential',
  [TEMPLATES.BOT_CHATS]: 'essential',
  [TEMPLATES.BOT_PROFILE]: 'essential',
  [TEMPLATES.BOT_DISCOVER]: 'essential',
  [TEMPLATES.BOT_REVIEWS]: 'essential',
  [TEMPLATES.BOT_WIZARD]: 'essential',
  [TEMPLATES.BOT_EVENT_CREATED]: 'essential',
  [TEMPLATES.BOT_WALLET]: 'essential',
  [TEMPLATES.BOT_REFERRAL]: 'essential',
  [TEMPLATES.BOT_CONFIRM_SPEND]: 'essential',
  [TEMPLATES.BOT_EVENT_DETAIL]: 'essential',
  [TEMPLATES.BOT_TRUST]: 'essential',
  [TEMPLATES.BOT_REPORT_REASONS]: 'essential',
  [TEMPLATES.BOT_RECEIVED_REVIEWS]: 'essential',
  /**
   * A moderator asked for their queue and must get it (ADR-0018).
   *
   * `essential` like every other answer to a command the sender typed: a
   * preference silences things the product decided to say, never a reply to a
   * request. A moderation queue suppressed by somebody's notification settings
   * would be a safety control switched off by a toggle about advertising.
   */
  [TEMPLATES.BOT_ADMIN_CASES]: 'essential',
};

/**
 * The category, or `essential` for a template this build does not know.
 *
 * Unknown means a notification queued by a **newer** deploy, and the safe
 * reading of "I have never heard of this" is to deliver it: silently dropping a
 * message an older worker cannot classify would lose it entirely, and the
 * rollout window is exactly when that is hardest to notice.
 */
export function notificationCategory(templateKey: string): NotificationCategory {
  return CATEGORY[templateKey] ?? 'essential';
}

/** Which preference governs a category, or null when nothing may silence it. */
export function preferenceKeyFor(
  category: NotificationCategory,
): 'notifyChat' | 'notifyEvents' | 'notifyCampaigns' | null {
  switch (category) {
    case 'chat':
      return 'notifyChat';
    case 'events':
      return 'notifyEvents';
    case 'campaigns':
      return 'notifyCampaigns';
    case 'essential':
      return null;
  }
}
