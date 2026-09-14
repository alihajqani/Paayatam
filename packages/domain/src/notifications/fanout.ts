import { TEMPLATES } from '@payetam/telegram';

/** One notification a domain event should produce. */
export interface PlannedNotification {
  /** Who receives it, by **public** id — resolved to an internal id by the caller. */
  userPublicId: string;
  templateKey: string;
  /** Exactly-once, derived from the event and the recipient. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

interface OutboxRow {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value : '';
}

/**
 * A number out of a payload, or zero.
 *
 * Zero for a missing or malformed value, deliberately: the one caller uses it to
 * pick between "you were paid" and "you were not", and a garbled payload should
 * fall to the sentence that promises nothing.
 */
function number(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * One domain event → the notifications it should produce (ADR-0005).
 *
 * A **pure function**, which is the point: the fan-out is where "who gets told
 * what" is decided, and that decision is the one most likely to be wrong in a way
 * nobody notices — a missing recipient produces silence, and silence looks like
 * nothing happening rather than like a bug. A pure function is testable as a table
 * without a queue, a database or Telegram.
 *
 * **The dedupe key is derived from the outbox row and the recipient**, never from
 * a timestamp. That is what makes a redelivered relay pass a no-op: the same row
 * fanned out twice produces the same two keys, and the UNIQUE index absorbs the
 * second attempt. One key per *recipient* rather than per event, because a
 * promotion tells two different people two different things and a shared key would
 * deliver only the first (ADR-0011, D8).
 *
 * Events with no notification return an empty list rather than throwing. Several
 * exist purely to drive other consumers — the channel publisher in M14 reads the
 * same rows — and a fan-out that refused an event it had no message for would
 * stall the relay behind it.
 */
export function planNotifications(row: OutboxRow): PlannedNotification[] {
  const payload = row.payload;

  switch (row.eventType) {
    /**
     * The host learns somebody wants in, and the guest learns their request
     * landed. Two recipients, two keys, one outbox row — so a crash cannot tell
     * one of them and lose the other.
     */
    case 'participation.requested': {
      const host = text(payload, 'hostUserPublicId');
      const guest = text(payload, 'participantUserPublicId');
      const planned: PlannedNotification[] = [];

      if (host !== '') {
        planned.push({
          userPublicId: host,
          templateKey: TEMPLATES.PARTICIPATION_REQUESTED_HOST,
          dedupeKey: `${row.id}:host`,
          payload,
        });
      }
      // The guest is not always named on this event — M6 wrote it before the
      // payload settled — so this is conditional rather than assumed.
      if (guest !== '') {
        planned.push({
          userPublicId: guest,
          templateKey: TEMPLATES.PARTICIPATION_REQUESTED_GUEST,
          dedupeKey: `${row.id}:guest`,
          payload,
        });
      }
      return planned;
    }

    case 'participation.accepted':
      return recipient(row, 'participantUserPublicId', TEMPLATES.PARTICIPATION_ACCEPTED);

    case 'participation.rejected':
      return recipient(row, 'participantUserPublicId', TEMPLATES.PARTICIPATION_REJECTED);

    case 'participation.no_show':
      return recipient(row, 'participantUserPublicId', TEMPLATES.NO_SHOW_RECORDED);

    /**
     * The guest withdrew, and only the host is told.
     *
     * One recipient, unlike `participation.requested`: the guest performed this
     * action themselves and got the answer in the reply to their own tap, so a
     * notification would be the product telling them what they just did.
     */
    case 'participation.cancelled':
      return recipient(row, 'hostUserPublicId', TEMPLATES.PARTICIPATION_CANCELLED_HOST);

    /** D8: **both** parties, immediately, from one row. */
    case 'waitlist.promoted': {
      const planned: PlannedNotification[] = [];
      const promoted = text(payload, 'promotedUserPublicId');
      const host = text(payload, 'hostUserPublicId');

      if (promoted !== '') {
        planned.push({
          userPublicId: promoted,
          templateKey: TEMPLATES.WAITLIST_PROMOTED_GUEST,
          dedupeKey: `${row.id}:guest`,
          payload,
        });
      }
      if (host !== '') {
        planned.push({
          userPublicId: host,
          templateKey: TEMPLATES.WAITLIST_PROMOTED_HOST,
          dedupeKey: `${row.id}:host`,
          payload,
        });
      }
      return planned;
    }

    /**
     * D9: everybody the cancellation affected, seat or not.
     *
     * The key includes the participant's public id, so adding a recipient to the
     * payload later cannot shift anybody else's key and re-deliver to them.
     */
    case 'event.cancelled_by_host': {
      const participants = payload['participants'];
      if (!Array.isArray(participants)) return [];

      return participants.flatMap((entry): PlannedNotification[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const record = entry as Record<string, unknown>;
        const userPublicId = text(record, 'userPublicId');
        if (userPublicId === '') return [];

        return [
          {
            userPublicId,
            templateKey: TEMPLATES.EVENT_CANCELLED,
            dedupeKey: `${row.id}:${text(record, 'participantPublicId')}`,
            payload,
          },
        ];
      });
    }

    /**
     * A direct message about an activity, and the receipt for it (v0.7.0).
     *
     * One recipient each, and **no body in either payload** — the row points at
     * the message and the bot decrypts it when the recipient presses «مشاهده».
     * That is what makes the receipt honest: the notification cannot have been
     * read without the button being pressed.
     */
    case 'direct.message_sent':
      return recipient(row, 'recipientUserPublicId', TEMPLATES.DIRECT_MESSAGE_RECEIVED);

    case 'direct.message_seen':
      return recipient(row, 'senderUserPublicId', TEMPLATES.DIRECT_MESSAGE_SEEN);

    /**
     * The host let the clock run out, and only the guest hears about it (v0.8.1).
     *
     * `recipient` like the other single-recipient participation events. The host
     * is deliberately not told: an expiry is the outcome their own inaction
     * chose, and a message about it would be the product scolding them for
     * something it already handled.
     */
    case 'participation.expired':
      return recipient(row, 'participantUserPublicId', TEMPLATES.PARTICIPATION_EXPIRED);

    /**
     * The reminders, each to exactly one person (migration 0050).
     *
     * Two event types rather than one fanned out to both sides, because they are
     * not the same message and they do not happen at the same time: the guest is
     * told twice, and the host once with a head count. A single type would have
     * had to carry "which of you is this for" in its payload, which is the shape
     * `review.window_open` earns by telling both sides the *same* thing at the
     * *same* instant — and this is the opposite of that.
     */
    case 'event.reminder_guest':
      return recipient(row, 'participantUserPublicId', TEMPLATES.EVENT_REMINDER_GUEST);

    case 'event.reminder_host':
      return recipient(row, 'hostUserPublicId', TEMPLATES.EVENT_REMINDER_HOST);

    // «همه آمدند؟», to the host (plan 15). The key is asserted from the producer
    // in `lifecycle.int.test.ts`, not from a payload built here.
    case 'event.attendance_prompt':
      return recipient(row, 'hostUserPublicId', TEMPLATES.EVENT_ATTENDANCE_PROMPT);

    /**
     * The window is open, and both sides are told (v0.8.1).
     *
     * The same two recipients and the same key shape as `review.revealed`, for
     * the same reason: the window opens for the *pair*, and telling one of them
     * first would hand them a head start on writing — which for a blind pair is
     * the asymmetry D7 exists to remove.
     */
    case 'review.window_open': {
      const planned: PlannedNotification[] = [];
      for (const [key, role] of [
        ['hostUserPublicId', 'HOST'],
        ['guestUserPublicId', 'GUEST'],
      ] as const) {
        const userPublicId = text(payload, key);
        if (userPublicId === '') continue;
        planned.push({
          userPublicId,
          templateKey: TEMPLATES.REVIEW_WINDOW_OPEN,
          dedupeKey: `${row.id}:${key}`,
          // Which side this reader is (plan 11): the template names the other
          // person, and tells only the host about the deposit.
          payload: { ...payload, recipientRole: role },
        });
      }
      return planned;
    }

    /** D7: both sides at the same instant, so neither gets a head start. */
    case 'review.revealed': {
      const planned: PlannedNotification[] = [];
      for (const key of ['hostUserPublicId', 'guestUserPublicId']) {
        const userPublicId = text(payload, key);
        if (userPublicId === '') continue;
        planned.push({
          userPublicId,
          templateKey: TEMPLATES.REVIEW_REVEALED,
          dedupeKey: `${row.id}:${key}`,
          payload,
        });
      }
      return planned;
    }

    /** M12: the owner, and never the reporters. */
    case 'moderation.content_hidden':
      return recipient(row, 'ownerUserPublicId', TEMPLATES.CONTENT_HIDDEN);

    /**
     * And the other half (v0.7.0).
     *
     * A host was told when their activity was hidden and then told nothing when
     * it came back, so the only way to learn a case had gone their way was to
     * notice the activity in «فعالیت‌های من» again. Half a conversation is worse
     * than none: the message that arrives is the accusation and the one that
     * never arrives is the exoneration.
     */
    case 'moderation.content_restored':
      return recipient(row, 'ownerUserPublicId', TEMPLATES.CONTENT_RESTORED);

    /**
     * The last thing a blocked account is told (v0.6.5).
     *
     * Fanned out like everything else rather than sent inline by the admin
     * service, and the reason is the ordering: `setUserStatus` writes the status
     * inside a transaction, and a Telegram send that happened *before* that
     * transaction committed could tell somebody they were blocked and then roll
     * back. An outbox row commits with the block or not at all.
     *
     * It reaches the user because the delivery path keys on
     * `telegram_account.bot_blocked` rather than on `user.status` — the block is
     * ours, not theirs, and they have not blocked the bot.
     */
    case 'user.blocked':
      return recipient(row, 'userPublicId', TEMPLATES.ACCOUNT_BLOCKED);

    /**
     * The referral paid out. Both sides, one row, two keys (v0.7.0).
     *
     * The same shape as `waitlist.promoted`: two people are told two different
     * things about one fact, and a shared dedupe key would deliver only the
     * first. The condition — the referred user attended something — is the whole
     * product decision behind referrals (T6), and until now nothing announced
     * that it had been met.
     */
    case 'referral.qualified': {
      const planned: PlannedNotification[] = [];
      const referrer = text(payload, 'referrerUserPublicId');
      const referred = text(payload, 'referredUserPublicId');

      if (referrer !== '') {
        planned.push({
          userPublicId: referrer,
          // Zero coins is a referrer at `economy.referral_reward_cap`, not a
          // missing number: the payout is emitted either way, and the sentence is
          // chosen here because the fan-out is where "one fact, several
          // recipients, several messages" already lives.
          templateKey:
            number(payload, 'referrerCoins') > 0
              ? TEMPLATES.REFERRAL_QUALIFIED_REFERRER
              : TEMPLATES.REFERRAL_QUALIFIED_REFERRER_CAPPED,
          dedupeKey: `${row.id}:referrer`,
          payload,
        });
      }
      if (referred !== '') {
        planned.push({
          userPublicId: referred,
          templateKey: TEMPLATES.REFERRAL_QUALIFIED_REFERRED,
          dedupeKey: `${row.id}:referred`,
          payload,
        });
      }
      return planned;
    }

    /**
     * The host's settlement (the coin economy rebalance).
     *
     * One recipient, so `recipient()` would do — except that the payload's key is
     * `hostUserPublicId` and this is the only place that name appears. Spelled
     * out rather than folded into the helper, so a reader of this file can see
     * every recipient key without opening the emitters.
     */
    case 'host.settled':
      return recipient(row, 'hostUserPublicId', TEMPLATES.HOST_SETTLED);

    /** The comeback grant. Unprompted, to one person. */
    case 'economy.comeback_granted':
      return recipient(row, 'userPublicId', TEMPLATES.COMEBACK_GRANTED);

    default:
      return [];
  }
}

function recipient(row: OutboxRow, key: string, templateKey: string): PlannedNotification[] {
  const userPublicId = text(row.payload, key);
  if (userPublicId === '') return [];

  return [{ userPublicId, templateKey, dedupeKey: `${row.id}:${key}`, payload: row.payload }];
}
