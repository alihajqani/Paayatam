import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { ChatService } from '../chat/chat.service';
import { MessageCipher } from '../chat/message-cipher';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from './participation.service';

/**
 * Waitlist promotion (ADR-0011, D8).
 *
 * The properties that matter are all about *who* gets the seat and *how many*
 * times: FIFO by `(requested_at, id)`, one seat to one person, and never the same
 * person twice however the cancellations interleave. All three are properties of
 * the event row lock, so none of them can be demonstrated without a real database.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const cipher = new MessageCipher({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as unknown as Env);
const chat = new ChatService(service, clock, cipher, audit, outbox);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
const participation = new ParticipationService(
  service,
  clock,
  env,
  settings,
  audit,
  outbox,
  chat,
  penalties,
);

const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');

let fixture: CatalogFixture;
let hostId: string;
let titleSequence = 0;

async function createEvent(capacity = 1, startsAt: Date = STARTS_AT): Promise<string> {
  titleSequence += 1;
  const title = `دورهمی شماره ${titleSequence}`;
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';

  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return event.publicId;
}

async function createJoiner(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId,
      displayName: 'شرکت‌کننده',
      cityId: fixture.tehranId,
      birthYear: 1995,
      gender: 'FEMALE',
    },
  });
  return userId;
}

/** Joins in a fixed order, one clock tick apart, so the queue order is unambiguous. */
async function joinInOrder(
  eventPublicId: string,
  userIds: string[],
): Promise<Array<{ userId: string; publicId: string; status: string }>> {
  const rows: Array<{ userId: string; publicId: string; status: string }> = [];
  for (const [index, userId] of userIds.entries()) {
    clock.set(new Date(NOW.getTime() + index * 1000));
    const row = await participation.join(userId, eventPublicId);
    rows.push({ userId, publicId: row.publicId, status: row.status });
  }
  clock.set(NOW);
  return rows;
}

async function statusOf(participantPublicId: string): Promise<string> {
  const row = await prisma.eventParticipant.findUniqueOrThrow({
    where: { publicId: participantPublicId },
    select: { status: true },
  });
  return row.status;
}

async function seats(eventPublicId: string): Promise<number> {
  const event = await prisma.event.findUniqueOrThrow({
    where: { publicId: eventPublicId },
    select: { acceptedCount: true },
  });
  return event.acceptedCount;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  titleSequence = 0;
  fixture = await seedCatalog(prisma);
  hostId = await createJoiner();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('promotion is FIFO by (requested_at, id)', () => {
  it('gives a freed seat to the person who has waited longest', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, first, second] = await Promise.all([
      createJoiner(),
      createJoiner(),
      createJoiner(),
    ]);
    const rows = await joinInOrder(eventPublicId, [holder, first, second]);

    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'WAITLISTED', 'WAITLISTED']);

    await participation.cancel(holder, rows[0]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
    expect(await statusOf(rows[2]!.publicId)).toBe('WAITLISTED');
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('walks the queue in order as seats keep freeing', async () => {
    const eventPublicId = await createEvent(1);
    const users = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, users);

    await participation.cancel(users[0], rows[0]!.publicId);
    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');

    await participation.cancel(users[1], rows[1]!.publicId);
    expect(await statusOf(rows[2]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('promotes on a rejection too — the seat is free either way', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    await participation.reject(hostId, rows[0]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('sets the promoted request a 12-hour deadline, not the 24 a fresh one gets', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    clock.set(new Date('2026-08-16T09:00:00.000Z'));
    await participation.cancel(holder, rows[0]!.publicId);

    const promoted = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: rows[1]!.publicId },
      select: { hostDeadlineAt: true, promotedAt: true },
    });

    expect(promoted.promotedAt).toEqual(new Date('2026-08-16T09:00:00.000Z'));
    expect(promoted.hostDeadlineAt).toEqual(new Date('2026-08-16T21:00:00.000Z'));
  });

  it('leaves the queue alone while no seat is free', async () => {
    const eventPublicId = await createEvent(1);
    const users = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, users);

    // Accepting does not free anything — the seat was already held.
    await participation.accept(hostId, rows[0]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('WAITLISTED');
    expect(await seats(eventPublicId)).toBe(1);
  });
});

describe('concurrent cancellations', () => {
  /**
   * The property ADR-0011 asks for by name. Two seats free at the same instant
   * must reach two different people — never the same person twice, and never one
   * person into two seats.
   *
   * Promotion runs inside the cancelling transaction under the event lock, so the
   * two cancellations serialise and the second sees the first's promotion.
   */
  it('promote two distinct people, never the same person twice', async () => {
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const eventPublicId = await createEvent(2);
      const holders = await Promise.all([createJoiner(), createJoiner()]);
      const waiting = await Promise.all([createJoiner(), createJoiner()]);
      const rows = await joinInOrder(eventPublicId, [...holders, ...waiting]);

      await Promise.all([
        participation.cancel(holders[0], rows[0]!.publicId),
        participation.cancel(holders[1], rows[1]!.publicId),
      ]);

      const promoted = await prisma.eventParticipant.findMany({
        where: { event: { publicId: eventPublicId }, status: 'PENDING' },
        select: { userId: true },
      });

      const distinct = new Set(promoted.map((row) => row.userId));
      expect(promoted, `iteration ${iteration}`).toHaveLength(2);
      expect(distinct.size, `iteration ${iteration}`).toBe(2);
      expect(await seats(eventPublicId), `iteration ${iteration}`).toBe(2);
    }
  }, 120_000);

  it('never promotes more people than there are seats', async () => {
    const eventPublicId = await createEvent(2);
    const holders = await Promise.all([createJoiner(), createJoiner()]);
    const waiting = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [...holders, ...waiting]);

    // One seat freed, three people waiting.
    await participation.cancel(holders[0], rows[0]!.publicId);

    const pending = await prisma.eventParticipant.count({
      where: { event: { publicId: eventPublicId }, status: 'PENDING' },
    });
    expect(pending).toBe(2);
    expect(await seats(eventPublicId)).toBe(2);
    // The two who did not get it are still queued, in their original order.
    expect(await statusOf(rows[3]!.publicId)).toBe('WAITLISTED');
    expect(await statusOf(rows[4]!.publicId)).toBe('WAITLISTED');
  });
});

describe('an expired promotion moves to the next', () => {
  it('gives the seat to the following person when the host never answers', async () => {
    const eventPublicId = await createEvent(1);
    const users = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, users);

    await participation.cancel(users[0], rows[0]!.publicId);
    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');

    // Past the promoted request's 12-hour window.
    clock.set(new Date('2026-08-15T21:00:01.000Z'));
    expect(await participation.expireOverdue()).toBe(1);

    expect(await statusOf(rows[1]!.publicId)).toBe('EXPIRED');
    expect(await statusOf(rows[2]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('leaves the seat empty once the queue is exhausted', async () => {
    const eventPublicId = await createEvent(1);
    const joiner = await createJoiner();
    const rows = await joinInOrder(eventPublicId, [joiner]);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));
    await participation.expireOverdue();

    expect(await statusOf(rows[0]!.publicId)).toBe('EXPIRED');
    expect(await seats(eventPublicId)).toBe(0);
  });
});

describe('the 5-minute backstop sweep', () => {
  /**
   * The event-driven path fills a seat the moment it frees, so the sweep should
   * normally find nothing. It exists for the seat freed while the process was
   * dying — simulated here by freeing one behind the service's back.
   */
  it('fills a seat that came free without a promotion running', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    // A cancellation that committed but whose promotion never ran.
    await prisma.eventParticipant.update({
      where: { publicId: rows[0]!.publicId },
      data: { status: 'CANCELLED_BY_PARTICIPANT', cancelledAt: NOW },
    });
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { acceptedCount: { decrement: 1 } },
    });

    expect(await participation.sweepWaitlists()).toBe(1);

    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('finds nothing to do when the event-driven path already ran', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    await participation.cancel(holder, rows[0]!.publicId);

    expect(await participation.sweepWaitlists()).toBe(0);
  });

  it('is idempotent when the job runs twice', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    // Free the seat behind the service's back, so a promotion is genuinely owed.
    await prisma.eventParticipant.update({
      where: { publicId: rows[0]!.publicId },
      data: { status: 'CANCELLED_BY_PARTICIPANT', cancelledAt: NOW },
    });
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { acceptedCount: { decrement: 1 } },
    });

    const first = await participation.sweepWaitlists();
    const second = await participation.sweepWaitlists();

    // The first pass fills the seat; the second finds the event full and the
    // promoted row already out of the queue, so it promotes nobody a second time.
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(await seats(eventPublicId)).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: 'waitlist.promoted' } })).toBe(1);
  });

  it('ignores an event that has already started', async () => {
    const eventPublicId = await createEvent(2, new Date('2026-08-15T08:00:00.000Z'));
    // Seeded directly: joining a started event is refused, which is the point.
    const waiting = await createJoiner();
    await prisma.eventParticipant.create({
      data: {
        eventId: (
          await prisma.event.findUniqueOrThrow({
            where: { publicId: eventPublicId },
            select: { id: true },
          })
        ).id,
        userId: waiting,
        status: 'WAITLISTED',
      },
    });

    expect(await participation.sweepWaitlists()).toBe(0);
  });
});

describe('both parties are notified (D8)', () => {
  /**
   * ADR-0011 is explicit that notifying only the host is wrong: the promoted user
   * is the one whose status just changed, and this is the moment they need to
   * know. There is no delivery layer until M13, so what is asserted here is the
   * thing that guarantees delivery is possible — a domain event that committed
   * with the promotion and names both people.
   */
  it('emits one promotion event naming the promoted participant and the host', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    await participation.cancel(holder, rows[0]!.publicId);

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: 'waitlist.promoted' },
    });
    expect(events).toHaveLength(1);

    const payload = events[0]?.payload as Record<string, unknown>;
    const [hostUser, promotedUser] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: hostId }, select: { publicId: true } }),
      prisma.user.findUniqueOrThrow({ where: { id: waiting }, select: { publicId: true } }),
    ]);

    expect(payload['hostUserPublicId']).toBe(hostUser.publicId);
    expect(payload['promotedUserPublicId']).toBe(promotedUser.publicId);
    expect(payload['participantPublicId']).toBe(rows[1]!.publicId);
    expect(payload['hostDeadlineAt']).toBe('2026-08-15T21:00:00.000Z');
  });

  /**
   * The outbox exists so that a notification cannot be announced for something
   * that did not happen. A rolled-back promotion must leave no trace of either.
   */
  it('writes no event when the transaction that would have promoted rolls back', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    // Cancelling somebody else's request fails after the lock is taken and before
    // anything is written.
    await expect(participation.cancel(waiting, rows[0]!.publicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    expect(await prisma.outboxEvent.count({ where: { eventType: 'waitlist.promoted' } })).toBe(0);
    expect(await statusOf(rows[1]!.publicId)).toBe('WAITLISTED');
  });

  it('records the join that started it all, so the host can be told somebody asked', async () => {
    const eventPublicId = await createEvent(1);
    const joiner = await createJoiner();
    await joinInOrder(eventPublicId, [joiner]);

    const requested = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'participation.requested' },
    });
    const payload = requested.payload as Record<string, unknown>;

    expect(payload['status']).toBe('PENDING');
    expect(requested.processedAt).toBeNull();
    expect(requested.attempts).toBe(0);
  });

  /**
   * Every payload in this module is an allowlist of public ids. A Telegram
   * identifier reaching an outbox row would reach a Telegram message body, which
   * is the one place invariant 7 must hold absolutely.
   */
  it('never puts an internal or Telegram identifier in a payload', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);
    await participation.accept(hostId, rows[0]!.publicId);
    await participation.cancel(holder, rows[0]!.publicId);

    const events = await prisma.outboxEvent.findMany();
    const serialized = JSON.stringify(events.map((row) => row.payload));

    expect(events.length).toBeGreaterThan(0);
    for (const internalId of [hostId, holder, waiting]) {
      expect(serialized).not.toContain(internalId);
    }

    const accounts = await prisma.telegramAccount.findMany({ select: { telegramUserId: true } });
    for (const account of accounts) {
      expect(serialized).not.toContain(String(account.telegramUserId));
    }
  });
});
