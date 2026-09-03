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
          templateKey: TEMPLATES.REFERRAL_QUALIFIED_REFERRER,
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

    default:
      return [];
  }
}

function recipient(row: OutboxRow, key: string, templateKey: string): PlannedNotification[] {
  const userPublicId = text(row.payload, key);
  if (userPublicId === '') return [];

  return [{ userPublicId, templateKey, dedupeKey: `${row.id}:${key}`, payload: row.payload }];
}
