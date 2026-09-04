import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '@payetam/telegram';
import { planNotifications } from './fanout';

/**
 * Who gets told what (ADR-0005, M13).
 *
 * A pure function with a table, because this is the decision most likely to be
 * wrong in a way nobody notices: **a missing recipient produces silence**, and
 * silence looks like nothing having happened rather than like a bug. The
 * integration test proves the relay writes what this plans; this proves the plan
 * is right.
 */

const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';

function row(eventType: string, payload: Record<string, unknown>) {
  return { id: 'outbox-1', aggregateId: 'agg-1', eventType, payload };
}

describe('single-recipient events', () => {
  it.each([
    ['participation.accepted', TEMPLATES.PARTICIPATION_ACCEPTED],
    ['participation.rejected', TEMPLATES.PARTICIPATION_REJECTED],
    // The host is deliberately not told about an expiry: it is the outcome their
    // own inaction chose, and a message would be the product scolding them.
    ['participation.expired', TEMPLATES.PARTICIPATION_EXPIRED],
    ['participation.no_show', TEMPLATES.NO_SHOW_RECORDED],
  ])('%s tells the participant', (eventType, templateKey) => {
    const planned = planNotifications(row(eventType, { participantUserPublicId: GUEST }));

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ userPublicId: GUEST, templateKey });
  });

  /**
   * The host, and only the host. The guest cancelled it themselves and already
   * has their answer; telling them would be the product narrating their own tap.
   */
  it('participation.cancelled tells the host', () => {
    const planned = planNotifications(
      row('participation.cancelled', {
        hostUserPublicId: HOST,
        eventTitle: 'قهوه و بازی',
        statusBefore: 'PENDING',
      }),
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      userPublicId: HOST,
      templateKey: TEMPLATES.PARTICIPATION_CANCELLED_HOST,
    });
  });

  /** M12: the owner, and never the reporters. */
  it('moderation.content_hidden tells only the owner', () => {
    const planned = planNotifications(
      row('moderation.content_hidden', {
        ownerUserPublicId: HOST,
        reportCount: 3,
      }),
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]?.userPublicId).toBe(HOST);
  });
});

/**
 * D8 and D7 both require **two** people told from **one** row, which is what makes
 * "a crash cannot deliver one and lose the other" true by construction.
 */
describe('two-recipient events', () => {
  it('waitlist.promoted tells the promoted participant and the host (D8)', () => {
    const planned = planNotifications(
      row('waitlist.promoted', { promotedUserPublicId: GUEST, hostUserPublicId: HOST }),
    );

    expect(planned).toHaveLength(2);
    expect(planned.map((plan) => plan.templateKey).sort()).toEqual(
      [TEMPLATES.WAITLIST_PROMOTED_GUEST, TEMPLATES.WAITLIST_PROMOTED_HOST].sort(),
    );
  });

  it('review.revealed tells both sides at once (D7)', () => {
    const planned = planNotifications(
      row('review.revealed', { hostUserPublicId: HOST, guestUserPublicId: GUEST }),
    );

    expect(planned).toHaveLength(2);
    expect(planned.every((plan) => plan.templateKey === TEMPLATES.REVIEW_REVEALED)).toBe(true);
  });

  /**
   * The reminder that had a template and no producer until v0.8.1.
   *
   * Both sides, for the same reason the reveal tells both: the window opens for
   * the *pair*, and telling one of them first would hand them a head start on
   * writing — the asymmetry a blind pair exists to remove.
   */
  it('review.window_open tells both sides, with one key each', () => {
    const planned = planNotifications(
      row('review.window_open', {
        hostUserPublicId: HOST,
        guestUserPublicId: GUEST,
        eventTitle: 'قهوه و بازی',
        daysLeft: 7,
      }),
    );

    expect(planned).toHaveLength(2);
    expect(planned.every((plan) => plan.templateKey === TEMPLATES.REVIEW_WINDOW_OPEN)).toBe(true);
    expect(new Set(planned.map((plan) => plan.dedupeKey)).size).toBe(2);
    expect(planned.map((plan) => plan.userPublicId).sort()).toEqual([HOST, GUEST].sort());
  });

  /**
   * The referral payout (v0.7.0). Two people, two different sentences, one row —
   * so two keys, or the shared one would deliver only to the first.
   */
  it('referral.qualified tells the referrer and the person who used the code', () => {
    const planned = planNotifications(
      row('referral.qualified', {
        referrerUserPublicId: HOST,
        referredUserPublicId: GUEST,
        referrerCoins: 30,
        referredCoins: 10,
      }),
    );

    expect(planned).toHaveLength(2);
    expect(planned.map((plan) => plan.templateKey).sort()).toEqual(
      [TEMPLATES.REFERRAL_QUALIFIED_REFERRER, TEMPLATES.REFERRAL_QUALIFIED_REFERRED].sort(),
    );
    expect(new Set(planned.map((plan) => plan.dedupeKey)).size).toBe(2);
  });

  it('participation.requested tells the host and the guest', () => {
    const planned = planNotifications(
      row('participation.requested', {
        hostUserPublicId: HOST,
        participantUserPublicId: GUEST,
      }),
    );

    expect(planned).toHaveLength(2);
  });
});

/**
 * The three one-recipient events v0.7.0 added.
 *
 * A direct message and its receipt go opposite ways — the message to the
 * recipient, the «دیده شد» back to the sender — and getting that pair the wrong
 * way round would tell somebody their own message had arrived.
 */
describe('the v0.7.0 events', () => {
  it('direct.message_sent tells the recipient', () => {
    const planned = planNotifications(
      row('direct.message_sent', { recipientUserPublicId: HOST, senderDisplayName: 'میهمان' }),
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]?.templateKey).toBe(TEMPLATES.DIRECT_MESSAGE_RECEIVED);
    expect(planned[0]?.userPublicId).toBe(HOST);
  });

  it('direct.message_seen tells the sender, the other way round', () => {
    const planned = planNotifications(
      row('direct.message_seen', { senderUserPublicId: GUEST, eventTitle: 'کوهنوردی' }),
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]?.templateKey).toBe(TEMPLATES.DIRECT_MESSAGE_SEEN);
    expect(planned[0]?.userPublicId).toBe(GUEST);
  });

  /** The counterpart `moderation.content_hidden` never had. */
  it('moderation.content_restored tells the owner, and names no reporter', () => {
    const planned = planNotifications(
      row('moderation.content_restored', { ownerUserPublicId: HOST, subjectType: 'EVENT' }),
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]?.templateKey).toBe(TEMPLATES.CONTENT_RESTORED);
    expect(planned[0]?.userPublicId).toBe(HOST);
  });
});

describe('event.cancelled_by_host (D9)', () => {
  it('tells everybody affected, seat or not', () => {
    const planned = planNotifications(
      row('event.cancelled_by_host', {
        participants: [
          { participantPublicId: 'p1', userPublicId: HOST, hadSeat: true },
          { participantPublicId: 'p2', userPublicId: GUEST, hadSeat: false },
        ],
      }),
    );

    expect(planned).toHaveLength(2);
    expect(planned.map((plan) => plan.userPublicId).sort()).toEqual([HOST, GUEST].sort());
  });

  it('plans nothing for an event nobody had joined', () => {
    expect(planNotifications(row('event.cancelled_by_host', { participants: [] }))).toEqual([]);
  });

  it('survives a malformed participant list rather than throwing', () => {
    expect(planNotifications(row('event.cancelled_by_host', { participants: 'nonsense' }))).toEqual(
      [],
    );
  });
});

/**
 * **The dedupe key is derived from the row and the recipient, never from a
 * timestamp.** That is what makes a redelivered relay pass a no-op: the same row
 * fanned out twice produces the same keys, and the UNIQUE index absorbs the
 * second.
 */
describe('dedupe keys', () => {
  it('are identical across two passes over the same row', () => {
    const input = row('waitlist.promoted', {
      promotedUserPublicId: GUEST,
      hostUserPublicId: HOST,
    });

    const first = planNotifications(input).map((plan) => plan.dedupeKey);
    const second = planNotifications(input).map((plan) => plan.dedupeKey);

    expect(second).toEqual(first);
  });

  /**
   * One key per **recipient**, not per event. A shared key would deliver to
   * whichever of the two people the relay reached first and silently drop the
   * other — which for a promotion is the participant who most needs to know.
   */
  it('differ between the two recipients of one event', () => {
    const planned = planNotifications(
      row('waitlist.promoted', { promotedUserPublicId: GUEST, hostUserPublicId: HOST }),
    );

    expect(planned[0]?.dedupeKey).not.toBe(planned[1]?.dedupeKey);
  });

  /** Two different outbox rows never collide, even for the same recipient. */
  it('differ between two rows about the same person', () => {
    const first = planNotifications({
      id: 'outbox-1',
      aggregateId: 'agg',
      eventType: 'participation.accepted',
      payload: { participantUserPublicId: GUEST },
    });
    const second = planNotifications({
      id: 'outbox-2',
      aggregateId: 'agg',
      eventType: 'participation.accepted',
      payload: { participantUserPublicId: GUEST },
    });

    expect(first[0]?.dedupeKey).not.toBe(second[0]?.dedupeKey);
  });
});

describe('events that notify nobody', () => {
  /**
   * Several exist to drive other consumers — M14's channel publisher reads the
   * same rows. Returning an empty list rather than throwing is what keeps one
   * unrecognised event from stalling the relay behind it.
   */
  it.each(['chat.contact_shared', 'something.unknown'])('%s plans nothing', (eventType) => {
    expect(planNotifications(row(eventType, {}))).toEqual([]);
  });

  it('plans nothing when the recipient is missing from the payload', () => {
    expect(planNotifications(row('participation.accepted', {}))).toEqual([]);
  });
});

/**
 * The conversation events, which now plan nothing (v0.8.0).
 *
 * `chat.message`, `chat.message_edited` and `chat.message_deleted` were the
 * relay's three outbox events and each planned a notification. The relay is gone,
 * so nothing emits them — but rows written by the previous build can still be in
 * `outbox_event` when this one starts draining, and an unrecognised event type
 * must return an empty list rather than throw. A throw here stalls the relay
 * behind the row for every other notification in the queue.
 */
describe('the retired conversation events', () => {
  it.each(['chat.message', 'chat.message_edited', 'chat.message_deleted'])(
    '%s plans nothing',
    (eventType) => {
      expect(
        planNotifications(
          row(eventType, { recipientUserPublicId: GUEST, chatPublicId: 'chat-1', seq: 3 }),
        ),
      ).toEqual([]);
    },
  );
});

/**
 * The last message a blocked account receives (v0.6.5).
 *
 * It reaches them because delivery keys on `telegram_account.bot_blocked` rather
 * than on `user.status` — the block is ours, not theirs, and they have not
 * blocked the bot.
 */
describe('a blocked account', () => {
  it('is told, once, by public id', () => {
    const planned = planNotifications(
      row('user.blocked', { userPublicId: GUEST, supportContact: '@paayatam_support' }),
    );

    expect(planned).toEqual([
      {
        userPublicId: GUEST,
        templateKey: 'account.blocked',
        dedupeKey: 'outbox-1:userPublicId',
        payload: { userPublicId: GUEST, supportContact: '@paayatam_support' },
      },
    ]);
  });

  it('plans nothing when the row names no recipient', () => {
    expect(planNotifications(row('user.blocked', {}))).toEqual([]);
  });
});
