import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '@payetam/platform';
import type { PrismaClient, PrismaService } from '@payetam/db';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { CHAT_DEPENDENTS, RETENTION, RetentionService } from './retention.service';

/**
 * The retention purge (§8, ADR-0009), and the plan's *"deletes exactly the expired
 * rows and nothing else"*.
 *
 * *Exactly* is the word doing the work, and it fails in both directions: a purge
 * that under-deletes silently breaks a promise made in a privacy notice, and one
 * that over-deletes destroys evidence somebody needs. So every test here seeds a
 * matched pair — one row just past its expiry and one just short of it — and asserts
 * that precisely one of them survives. A purge that deleted everything and a purge
 * that deleted nothing would each fail half of these.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const retention = new RetentionService(service, clock);

const DAY = 24 * 3_600_000;
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

let fixture: CatalogFixture;
let hostId: string;
let guestId: string;

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await createUser(prisma, 'PROFILE_COMPLETE');
  guestId = await createUser(prisma, 'PROFILE_COMPLETE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * A closed chat with one message, both stamped with the same expiry.
 *
 * `retentionExpiresAt` is set when the chat **closes**, not when a message is sent —
 * M8 chose that deliberately, and it is the reason partitioning `chat_message` by
 * month would not have helped: a conversation spanning a month boundary would put
 * its messages in two partitions with one expiry between them.
 */
async function closedChat(expiresAt: Date): Promise<string> {
  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title: 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: daysAgo(200),
      endsAt: new Date(daysAgo(200).getTime() + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'COMPLETED',
      moderationStatus: 'APPROVED',
    },
  });

  const participant = await prisma.eventParticipant.create({
    data: {
      eventId: event.id,
      userId: guestId,
      status: 'ACCEPTED',
      acceptedAt: daysAgo(200),
      decidedAt: daysAgo(200),
    },
  });

  const chat = await prisma.anonymousChat.create({
    data: {
      eventId: event.id,
      participantId: participant.id,
      status: 'CLOSED',
      closedAt: new Date(expiresAt.getTime() - RETENTION.CHAT_DAYS * DAY),
      retentionExpiresAt: expiresAt,
      nextSeq: 2,
    },
  });

  /**
   * Both sides, and an action-log row. The fixture is this complete on purpose:
   * three tables reference `anonymous_chat` with RESTRICT besides `chat_message`,
   * and a chat with only messages purges cleanly while a real one does not.
   */
  const [guestSide] = await Promise.all([
    prisma.chatParticipant.create({
      data: { chatId: chat.id, userId: guestId, role: 'GUEST', alias: 'مهمان ۱', aliasIndex: 1 },
    }),
    prisma.chatParticipant.create({
      data: { chatId: chat.id, userId: hostId, role: 'HOST', alias: 'میزبان', aliasIndex: 0 },
    }),
  ]);

  await prisma.chatAction.create({
    data: { chatId: chat.id, actorUserId: guestId, action: 'CLOSE' },
  });

  await prisma.chatMessage.create({
    data: {
      chatId: chat.id,
      senderParticipantId: guestSide.id,
      seq: 1,
      kind: 'TEXT',
      bodyCiphertext: Buffer.alloc(16, 1),
      bodyNonce: Buffer.alloc(12, 2),
      keyVersion: 1,
      retentionExpiresAt: expiresAt,
    },
  });

  return chat.id;
}

describe('chat bodies, ninety days after the chat closes', () => {
  it('deletes an expired conversation and its messages', async () => {
    const expired = await closedChat(daysAgo(1));

    const result = await retention.purge();

    expect(result.chatMessages).toBe(1);
    expect(result.chats).toBe(1);
    expect(await prisma.anonymousChat.findUnique({ where: { id: expired } })).toBeNull();
  });

  it('leaves a conversation whose expiry has not arrived', async () => {
    const live = await closedChat(new Date(NOW.getTime() + DAY));

    const result = await retention.purge();

    expect(result.chatMessages).toBe(0);
    expect(await prisma.anonymousChat.findUnique({ where: { id: live } })).not.toBeNull();
    expect(await prisma.chatMessage.count({ where: { chatId: live } })).toBe(1);
  });

  it('deletes exactly the expired one when both exist', async () => {
    const expired = await closedChat(daysAgo(1));
    const live = await closedChat(new Date(NOW.getTime() + DAY));

    await retention.purge();

    expect(await prisma.anonymousChat.findMany({ select: { id: true } })).toEqual([{ id: live }]);
    expect(expired).not.toBe(live);
  });

  /**
   * An open chat has a null `retentionExpiresAt` — which is also what keeps the
   * purge's index small, since it holds closed chats rather than every chat. A
   * `lte` against null matches nothing in SQL, and that is asserted rather than
   * assumed.
   */
  it('never touches a chat that is still open', async () => {
    const event = await prisma.event.create({
      data: {
        hostUserId: hostId,
        title: 'پیاده‌روی صبحگاهی',
        description: 'یک پیاده‌روی آرام در پارک.',
        titleNormalized: 'پیاده‌روی صبحگاهی',
        descriptionNormalized: 'یک پیاده‌روی آرام در پارک.',
        categoryId: fixture.categoryId,
        cityId: fixture.tehranId,
        startsAt: new Date(NOW.getTime() + DAY),
        endsAt: new Date(NOW.getTime() + DAY + 3_600_000),
        capacity: 4,
        costType: 'FREE',
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        publishedAt: daysAgo(2),
      },
    });
    const participant = await prisma.eventParticipant.create({
      data: {
        eventId: event.id,
        userId: guestId,
        status: 'ACCEPTED',
        acceptedAt: daysAgo(200),
        decidedAt: daysAgo(200),
      },
    });
    await prisma.anonymousChat.create({
      data: { eventId: event.id, participantId: participant.id, status: 'ANONYMOUS' },
    });

    const result = await retention.purge();

    expect(result.chats).toBe(0);
    expect(await prisma.anonymousChat.count()).toBe(1);
  });

  /**
   * Deleted in dependency order — messages, then the conversations that held them.
   * A chat whose messages are gone is an empty conversation; a message whose chat is
   * gone is a foreign-key violation.
   */
  it('leaves nothing orphaned', async () => {
    await closedChat(daysAgo(1));

    await retention.purge();

    expect(await prisma.chatMessage.count()).toBe(0);
    expect(await prisma.anonymousChat.count()).toBe(0);
  });
});

describe('notifications, six months', () => {
  beforeEach(async () => {
    await prisma.notification.createMany({
      data: [
        {
          userId: guestId,
          templateKey: 'participation.accepted',
          payload: {},
          dedupeKey: 'old',
          createdAt: daysAgo(RETENTION.NOTIFICATION_DAYS + 1),
        },
        {
          userId: guestId,
          templateKey: 'participation.accepted',
          payload: {},
          dedupeKey: 'edge',
          createdAt: daysAgo(RETENTION.NOTIFICATION_DAYS - 1),
        },
        {
          userId: guestId,
          templateKey: 'participation.accepted',
          payload: {},
          dedupeKey: 'fresh',
          createdAt: daysAgo(1),
        },
      ],
    });
  });

  it('deletes only those past the window', async () => {
    const result = await retention.purge();

    expect(result.notifications).toBe(1);
    expect(
      (await prisma.notification.findMany({ select: { dedupeKey: true } })).map((n) => n.dedupeKey),
    ).toEqual(expect.arrayContaining(['edge', 'fresh']));
    expect(await prisma.notification.count()).toBe(2);
  });
});

describe('the outbox, seven days — and only once processed', () => {
  /**
   * `processedAt: { not: null }` is the whole safety of this one. An unprocessed row
   * is a notification nobody has been told about yet, and deleting it by age would
   * silently discard the delivery the outbox exists to guarantee (ADR-0005) —
   * during an outage, which is exactly when a backlog gets old.
   */
  it('keeps an old row that has never been processed', async () => {
    await prisma.outboxEvent.createMany({
      data: [
        {
          aggregateType: 'event',
          aggregateId: 'a',
          eventType: 'event.published',
          payload: {},
          createdAt: daysAgo(60),
          processedAt: null,
        },
        {
          aggregateType: 'event',
          aggregateId: 'b',
          eventType: 'event.published',
          payload: {},
          createdAt: daysAgo(60),
          processedAt: daysAgo(59),
        },
      ],
    });

    const result = await retention.purge();

    expect(result.outboxRows).toBe(1);
    const survivors = await prisma.outboxEvent.findMany({ select: { aggregateId: true } });
    expect(survivors).toEqual([{ aggregateId: 'a' }]);
  });

  it('keeps a processed row that is still inside the window', async () => {
    await prisma.outboxEvent.create({
      data: {
        aggregateType: 'event',
        aggregateId: 'recent',
        eventType: 'event.published',
        payload: {},
        createdAt: daysAgo(RETENTION.OUTBOX_DAYS - 1),
        processedAt: daysAgo(RETENTION.OUTBOX_DAYS - 1),
      },
    });

    expect((await retention.purge()).outboxRows).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(1);
  });
});

describe('the audit trail, twenty-four months', () => {
  beforeEach(async () => {
    await prisma.auditLog.createMany({
      data: [
        {
          actorType: 'ADMIN',
          action: 'user.status_changed',
          targetType: 'user',
          targetId: guestId,
          createdAt: daysAgo(RETENTION.AUDIT_DAYS + 10),
        },
        {
          actorType: 'ADMIN',
          action: 'user.status_changed',
          targetType: 'user',
          targetId: guestId,
          createdAt: daysAgo(30),
        },
      ],
    });
  });

  /**
   * `audit_log` is append-only by trigger, and M1 gave it a **retention escape
   * hatch** that `coin_ledger` deliberately does not have: a missing ledger row
   * breaks reconciliation permanently, while the audit trail has a stated 24-month
   * life. This is the one caller allowed to use it.
   */
  it('deletes rows past the window through the escape hatch', async () => {
    const result = await retention.purge();

    expect(result.auditRows).toBe(1);
    expect(await prisma.auditLog.count()).toBe(1);
  });

  /** And the trigger is still armed for everybody else. */
  it('still refuses an ordinary delete', async () => {
    const row = await prisma.auditLog.findFirstOrThrow();

    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /append.only|audit/i,
    );
  });

  /**
   * The escape hatch is transaction-local (`set_config(..., true)`), so it cannot
   * leak into the next statement on the same pooled connection. Asserted because the
   * alternative — a session-level setting — would leave a connection in the pool
   * permanently able to delete audit rows, and nothing would ever notice.
   */
  it('does not leave the escape hatch open afterwards', async () => {
    await retention.purge();
    const row = await prisma.auditLog.findFirstOrThrow();

    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
      /append.only|audit/i,
    );
  });
});

describe('the ledgers are not on any retention schedule', () => {
  /**
   * Neither ledger appears in §8's table and neither is purged here. That is not an
   * omission: ADR-0007 makes them the record that answers "where did my coins go?",
   * and a retention policy that eventually deletes the answer makes the question
   * unanswerable — permanently, and only for the oldest accounts.
   */
  it('leaves ancient ledger rows alone', async () => {
    await prisma.coinLedger.create({
      data: {
        userId: guestId,
        idempotencyKey: 'ancient',
        type: 'ONBOARDING_REWARD',
        amount: 20,
        balanceBefore: 0,
        balanceAfter: 20,
        reasonCode: 'onboarding_reward',
        actorType: 'SYSTEM',
        createdAt: daysAgo(2000),
      },
    });

    await retention.purge();

    expect(await prisma.coinLedger.count()).toBe(1);
  });
});

describe('expired Idempotency-Key claims', () => {
  /**
   * Swept by `expires_at` rather than by an age constant: the interceptor decides how
   * long a key speaks for, and this sweep should not hold a second opinion about it.
   */
  async function claim(expiresAt: Date, key: string): Promise<void> {
    await prisma.requestIdempotency.create({
      data: {
        userId: hostId,
        key,
        method: 'POST',
        path: '/api/v1/events/x/boost',
        requestFingerprint: 'a'.repeat(64),
        statusCode: 201,
        responseBody: '{"ok":true}',
        expiresAt,
      },
    });
  }

  it('deletes a claim whose window has passed', async () => {
    await claim(daysAgo(1), 'expired');

    const result = await retention.purge();

    expect(result.idempotencyKeys).toBe(1);
    expect(await prisma.requestIdempotency.count()).toBe(0);
  });

  it('keeps a claim that is still live — deleting it would re-enable a double charge', async () => {
    await claim(new Date(NOW.getTime() + 3_600_000), 'live');

    const result = await retention.purge();

    expect(result.idempotencyKeys).toBe(0);
    expect(await prisma.requestIdempotency.count()).toBe(1);
  });
});

describe('running it on an empty database', () => {
  it('deletes nothing and reports nothing', async () => {
    expect(await retention.purge()).toEqual({
      chatMessages: 0,
      chats: 0,
      notifications: 0,
      auditRows: 0,
      outboxRows: 0,
      idempotencyKeys: 0,
    });
  });

  /** A purge nobody dares re-run is a purge that stops being run. */
  it('is idempotent', async () => {
    await closedChat(daysAgo(1));

    const first = await retention.purge();
    const second = await retention.purge();

    expect(first.chats).toBe(1);
    expect(second).toEqual({
      chatMessages: 0,
      chats: 0,
      notifications: 0,
      auditRows: 0,
      outboxRows: 0,
      idempotencyKeys: 0,
    });
  });
});

describe('the list of tables the chat purge has to clear', () => {
  /**
   * Against `pg_constraint`, not against anybody's memory.
   *
   * The purge deletes a chat's dependents by name, and a fifth table added in a
   * later milestone would turn the nightly job into a nightly exception — with the
   * only symptom being chat bodies quietly outliving the ninety days they were
   * promised. Nothing else in the suite would notice: the tests above seed the four
   * tables that exist today, so they would keep passing.
   */
  it('matches every foreign key pointing at anonymous_chat', async () => {
    const referring = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT DISTINCT con.conrelid::regclass::text AS table_name
      FROM pg_constraint con
      WHERE con.contype = 'f' AND con.confrelid = 'anonymous_chat'::regclass
    `;

    expect(referring.map((row) => row.table_name).sort()).toEqual([...CHAT_DEPENDENTS].sort());
  });

  /** All four are RESTRICT, which is why the order in the purge matters at all. */
  it('confirms none of them cascade', async () => {
    const cascading = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT con.conrelid::regclass::text AS table_name
      FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.confrelid = 'anonymous_chat'::regclass
        AND con.confdeltype <> 'r'
    `;

    expect(cascading).toEqual([]);
  });
});

describe('the retention windows themselves', () => {
  /** §8's table, asserted by number rather than trusted to a comment. */
  it('matches §8', () => {
    expect(RETENTION).toEqual({
      CHAT_DAYS: 90,
      NOTIFICATION_DAYS: 180,
      AUDIT_DAYS: 730,
      OUTBOX_DAYS: 7,
    });
  });
});
