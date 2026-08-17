import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { NotificationService } from '../notifications/notification.service';
import { OutboxService } from './outbox.service';
import { OutboxRelayService } from './relay.service';

/**
 * The transactional outbox, end to end (M13, ADR-0005).
 *
 * The property the plan singles out — *"a crash between commit and enqueue still
 * delivers"* — is asserted directly below, and the way it is asserted is the
 * point: the "crash" is simply **not running the relay**, because that is exactly
 * what a crash between the two looks like from the database's side. The row is
 * there, nothing has consumed it, and the next pass finds it.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);

const outbox = new OutboxService(service, clock);
const notifications = new NotificationService(service, clock);
const relay = new OutboxRelayService(service, clock, notifications);

let fixture: CatalogFixture;

async function createProfiledUser(): Promise<{ id: string; publicId: string }> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return { id: userId, publicId: user.publicId };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a crash between commit and enqueue still delivers', () => {
  /**
   * The scenario, stated plainly: a state change committed, its outbox row
   * committed with it, and then the process died before anything drained it. The
   * row is still there, and the next relay pass delivers it.
   */
  it('delivers a row the previous pass never reached', async () => {
    const host = await createProfiledUser();
    const guest = await createProfiledUser();

    await outbox.emit({
      aggregateType: 'event_participant',
      aggregateId: 'participant-1',
      eventType: 'participation.requested',
      payload: {
        hostUserPublicId: host.publicId,
        participantUserPublicId: guest.publicId,
        eventTitle: 'شب بازی رومیزی',
      },
    });

    // Nothing ran. This is the crash.
    await expect(prisma.notification.count()).resolves.toBe(0);

    const result = await relay.drain();

    expect(result.processed).toBe(1);
    expect(result.created).toBe(2);
    await expect(prisma.notification.count()).resolves.toBe(2);
  });

  /**
   * The other half of the same guarantee: a **rolled-back** transaction leaves no
   * row, so nothing is announced about something that did not happen.
   */
  it('announces nothing for a transaction that rolled back', async () => {
    const host = await createProfiledUser();

    await prisma
      .$transaction(async (tx) => {
        await outbox.emit(
          {
            aggregateType: 'event_participant',
            aggregateId: 'participant-1',
            eventType: 'participation.accepted',
            payload: { participantUserPublicId: host.publicId },
          },
          tx,
        );
        throw new Error('the state change failed');
      })
      .catch(() => undefined);

    await relay.drain();
    await expect(prisma.notification.count()).resolves.toBe(0);
  });

  /**
   * `processed_at` is set **after** the notifications are recorded, so a crash
   * between the two re-reads the row and re-plans it. That is safe only because
   * the dedupe keys come from the row rather than from the moment — which is what
   * this asserts.
   */
  it('produces one notification however many times the relay runs', async () => {
    const guest = await createProfiledUser();

    await outbox.emit({
      aggregateType: 'event_participant',
      aggregateId: 'participant-1',
      eventType: 'participation.accepted',
      payload: { participantUserPublicId: guest.publicId, eventTitle: 'دورهمی' },
    });

    const first = await relay.drain();
    // Force the row back into the backlog, which is what a crash after the
    // notifications were written but before the mark would leave behind.
    await prisma.outboxEvent.updateMany({ data: { processedAt: null } });
    const second = await relay.drain();

    expect(first.created).toBe(1);
    // Re-planned, recognised as already queued, and not duplicated.
    expect(second.created).toBe(0);
    expect(second.queued).toHaveLength(1);
    await expect(prisma.notification.count()).resolves.toBe(1);
  });

  it('leaves a drained row alone on the next pass', async () => {
    const guest = await createProfiledUser();
    await outbox.emit({
      aggregateType: 'event_participant',
      aggregateId: 'participant-1',
      eventType: 'participation.rejected',
      payload: { participantUserPublicId: guest.publicId },
    });

    await relay.drain();
    const second = await relay.drain();

    expect(second.processed).toBe(0);
  });
});

describe('the fan-out', () => {
  /** D8: both parties, from one row, so a crash cannot tell one and lose the other. */
  it('tells both sides of a waitlist promotion', async () => {
    const host = await createProfiledUser();
    const promoted = await createProfiledUser();

    await outbox.emit({
      aggregateType: 'event_participant',
      aggregateId: 'participant-1',
      eventType: 'waitlist.promoted',
      payload: {
        hostUserPublicId: host.publicId,
        promotedUserPublicId: promoted.publicId,
        eventTitle: 'دورهمی',
      },
    });

    await relay.drain();

    const rows = await prisma.notification.findMany({
      select: { userId: true, templateKey: true },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort()).toEqual([host.id, promoted.id].sort());
  });

  /** D9: everybody the cancellation affected, seat or not. */
  it('tells every participant of a cancelled event', async () => {
    const first = await createProfiledUser();
    const second = await createProfiledUser();

    await outbox.emit({
      aggregateType: 'event',
      aggregateId: 'event-1',
      eventType: 'event.cancelled_by_host',
      payload: {
        eventPublicId: 'evt',
        eventTitle: 'دورهمی',
        participants: [
          { participantPublicId: 'p1', userPublicId: first.publicId, hadSeat: true },
          { participantPublicId: 'p2', userPublicId: second.publicId, hadSeat: false },
        ],
      },
    });

    await relay.drain();
    await expect(prisma.notification.count()).resolves.toBe(2);
  });

  /**
   * Several events exist to drive other consumers rather than to notify anybody —
   * M14's channel publisher reads the same rows. A fan-out that refused an event
   * it had no message for would stall the relay behind it.
   */
  it('drains an event nobody is notified about', async () => {
    await outbox.emit({
      aggregateType: 'anonymous_chat',
      aggregateId: 'chat-1',
      eventType: 'chat.contact_shared',
      payload: {},
    });

    const result = await relay.drain();
    expect(result.processed).toBe(1);
    expect(result.created).toBe(0);
  });

  /**
   * A public id that resolves to nobody is an anonymised or deleted account
   * (M15). The row still drains — otherwise one departed user would block every
   * notification behind them forever.
   */
  it('drains a row whose recipient no longer exists', async () => {
    await outbox.emit({
      aggregateType: 'event_participant',
      aggregateId: 'participant-1',
      eventType: 'participation.accepted',
      payload: { participantUserPublicId: '00000000-0000-4000-8000-000000000000' },
    });

    const result = await relay.drain();
    expect(result.processed).toBe(1);
    expect(result.created).toBe(0);
  });

  it('drains oldest first, so a backlog does not starve the front of the queue', async () => {
    const guest = await createProfiledUser();

    for (const [index, title] of ['اول', 'دوم', 'سوم'].entries()) {
      clock.set(new Date(NOW.getTime() + index * 1000));
      await outbox.emit({
        aggregateType: 'event_participant',
        aggregateId: `participant-${String(index)}`,
        eventType: 'participation.accepted',
        payload: { participantUserPublicId: guest.publicId, eventTitle: title },
      });
    }

    await relay.drain(2);

    const remaining = await prisma.outboxEvent.findMany({
      where: { processedAt: null },
      select: { aggregateId: true },
    });
    expect(remaining.map((row) => row.aggregateId)).toEqual(['participant-2']);
  });
});

/**
 * `notification.dedupe_key` is the **second** idempotency layer, and it is the one
 * that holds when the queue does not exist any more — a Redis flush, a migration,
 * a replay. BullMQ's deterministic job id is the first.
 */
describe('the dedupe key (ADR-0005)', () => {
  it('refuses a second notification with the same key', async () => {
    const user = await createProfiledUser();

    const first = await notifications.queue({
      userId: user.id,
      templateKey: 'participation.accepted',
      dedupeKey: 'outbox-1:guest',
      payload: {},
    });
    const second = await notifications.queue({
      userId: user.id,
      templateKey: 'participation.accepted',
      dedupeKey: 'outbox-1:guest',
      payload: {},
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    await expect(prisma.notification.count()).resolves.toBe(1);
  });

  it('is enforced by the database, not only by the service', async () => {
    const user = await createProfiledUser();
    await notifications.queue({
      userId: user.id,
      templateKey: 'x',
      dedupeKey: 'shared-key',
      payload: {},
    });

    await expect(
      prisma.notification.create({
        data: { userId: user.id, templateKey: 'y', dedupeKey: 'shared-key', payload: {} },
      }),
    ).rejects.toThrow(/dedupe_key/);
  });

  /** Ten relay passes racing over one row still produce one notification. */
  it('holds under ten concurrent attempts on the same key', async () => {
    const user = await createProfiledUser();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        notifications.queue({
          userId: user.id,
          templateKey: 'participation.accepted',
          dedupeKey: 'contended',
          payload: {},
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    await expect(prisma.notification.count()).resolves.toBe(1);
  });
});

describe('delivery outcomes', () => {
  async function queued(): Promise<{ id: string; userId: string }> {
    const user = await createProfiledUser();
    const result = await notifications.queue({
      userId: user.id,
      templateKey: 'participation.accepted',
      dedupeKey: `k-${user.id}`,
      payload: {},
    });
    return { id: result.id, userId: user.id };
  }

  it('records the Telegram message id on success, so an edit can find it', async () => {
    const notification = await queued();
    await notifications.markSent(notification.id, 4242);

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(row.status).toBe('SENT');
    expect(row.telegramMessageId).toBe(4242);
    expect(row.sentAt).not.toBeNull();
  });

  /** A redelivered job finds a sent notification and stops. */
  it('will not load a notification that has already been sent', async () => {
    const notification = await queued();
    await notifications.markSent(notification.id, 1);

    await expect(notifications.load(notification.id)).resolves.toBeNull();
  });

  /**
   * 403 marks the account and stops (ADR-0005). Retrying a block burns the global
   * rate budget that other users' notifications need, and there is nobody at the
   * other end either way.
   */
  it('marks the account blocked and stops, on an undeliverable', async () => {
    const notification = await queued();
    await notifications.markUndeliverable(notification.id, notification.userId);

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(row.status).toBe('UNDELIVERABLE');

    const account = await prisma.telegramAccount.findFirstOrThrow({
      where: { userId: notification.userId },
    });
    expect(account.botBlocked).toBe(true);

    // And it is not loaded again, so the queue cannot retry it.
    await expect(notifications.load(notification.id)).resolves.toBeNull();
  });

  it('counts attempts and keeps the last error', async () => {
    const notification = await queued();
    await notifications.markFailed(notification.id, 'network error reaching Telegram');
    await notifications.markFailed(notification.id, 'network error reaching Telegram');

    const row = await prisma.notification.findUniqueOrThrow({ where: { id: notification.id } });
    expect(row.attempts).toBe(2);
    expect(row.lastError).toContain('network error');
    // Still loadable: a failure is retryable, unlike a block.
    await expect(notifications.load(notification.id)).resolves.not.toBeNull();
  });

  /** A sent notification says when. The CHECK is what stops the two disagreeing. */
  it('refuses a SENT row with no timestamp at the database level', async () => {
    const notification = await queued();

    await expect(
      prisma.notification.update({
        where: { id: notification.id },
        data: { status: 'SENT' },
      }),
    ).rejects.toThrow(/notification_sent_at_matches_status/);
  });
});
