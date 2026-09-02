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
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
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
/**
 * The channel-membership gate, in its permissive default state.
 *
 * `event_channel_config` is truncated between tests, so `membershipRequired` is
 * false and every check answers NOT_REQUIRED — the gate is a no-op here, which is
 * what these suites want. `membership.int.test.ts` is where it is switched on.
 */
const membership = new ChannelMembershipService(
  service,
  new ChannelConfigService(service, clock, audit),
);

const participation = new ParticipationService(
  service,
  clock,
  env,
  settings,
  audit,
  outbox,
  chat,
  penalties,
  membership,
  coins,
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
    select: { publicId: true, title: true },
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

/**
 * ── What "a seat frees" means from v0.6.5 ───────────────────────────────────
 *
 * `accepted_count` counts **accepted people only**. What promotion moves is a
 * *slot in the host's queue*: `join` admits while `accepted_count + PENDING <
 * capacity`, and a rejection, an expiry or a cancellation frees one of those.
 * The counter is therefore zero throughout most of this file, and that is the
 * point — an activity nobody has been accepted to has all its places free,
 * whatever is happening in the queue in front of it.
 */
describe('promotion is FIFO by (requested_at, id)', () => {
  it('gives a freed slot to the person who has waited longest', async () => {
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
    // Nobody was accepted, so the place is still free.
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('walks the queue in order as slots keep freeing', async () => {
    const eventPublicId = await createEvent(1);
    const users = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, users);

    await participation.cancel(users[0], rows[0]!.publicId);
    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');

    await participation.cancel(users[1], rows[1]!.publicId);
    expect(await statusOf(rows[2]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('promotes on a rejection too — the slot is free either way', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    await participation.reject(hostId, rows[0]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(0);
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

  it('leaves the queue alone while no slot is free', async () => {
    const eventPublicId = await createEvent(1);
    const users = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, users);

    // Accepting frees nothing: the pending slot becomes a taken seat, and the
    // sum the queue is bounded by is unchanged.
    await participation.accept(hostId, rows[0]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('WAITLISTED');
    expect(await seats(eventPublicId)).toBe(1);
  });
});

describe('concurrent cancellations', () => {
  /**
   * The property ADR-0011 asks for by name. Two slots free at the same instant
   * must reach two different people — never the same person twice, and never one
   * person into two slots.
   *
   * Promotion runs inside the cancelling transaction under the event lock, so the
   * two cancellations serialise and the second sees the first's promotion.
   */
  it('promote two distinct people, never the same person twice, 50 times over', async () => {
    // Fifty, because §14 names this test and that number: "the 20-concurrent-joins and
    // concurrent-promotion/spend tests run 50 iterations in CI". It ran 25 until M17.
    for (let iteration = 0; iteration < 50; iteration += 1) {
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
      // Two places, two people being asked about, nobody accepted — so both
      // places are still free (v0.6.5).
      expect(await seats(eventPublicId), `iteration ${iteration}`).toBe(0);
    }
  }, 120_000);

  it('never promotes more people than the host has room to be asked about', async () => {
    const eventPublicId = await createEvent(2);
    const holders = await Promise.all([createJoiner(), createJoiner()]);
    const waiting = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [...holders, ...waiting]);

    // One slot freed, three people waiting.
    await participation.cancel(holders[0], rows[0]!.publicId);

    const pending = await prisma.eventParticipant.count({
      where: { event: { publicId: eventPublicId }, status: 'PENDING' },
    });
    expect(pending).toBe(2);
    expect(await seats(eventPublicId)).toBe(0);
    // The two who did not get it are still queued, in their original order.
    expect(await statusOf(rows[3]!.publicId)).toBe('WAITLISTED');
    expect(await statusOf(rows[4]!.publicId)).toBe('WAITLISTED');
  });
});

describe('an expired promotion moves to the next', () => {
  it('gives the slot to the following person when the host never answers', async () => {
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
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('leaves the queue empty once it is exhausted', async () => {
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
   * The event-driven path fills a freed slot the moment it frees, so the sweep
   * should normally find nothing. It exists for the slot freed while the process
   * was dying — simulated here by settling a row behind the service's back, so
   * no promotion runs with it.
   */
  it('fills a slot that came free without a promotion running', async () => {
    const eventPublicId = await createEvent(1);
    const [holder, waiting] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [holder, waiting]);

    // A cancellation that committed but whose promotion never ran. No counter to
    // adjust: a PENDING request holds a queue slot rather than a seat (v0.6.5).
    await prisma.eventParticipant.update({
      where: { publicId: rows[0]!.publicId },
      data: { status: 'CANCELLED_BY_PARTICIPANT', cancelledAt: NOW },
    });

    expect(await participation.sweepWaitlists()).toBe(1);

    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(0);
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

    // Free the slot behind the service's back, so a promotion is genuinely owed.
    await prisma.eventParticipant.update({
      where: { publicId: rows[0]!.publicId },
      data: { status: 'CANCELLED_BY_PARTICIPANT', cancelledAt: NOW },
    });

    const first = await participation.sweepWaitlists();
    const second = await participation.sweepWaitlists();

    // The first pass fills the slot; the second finds the queue full and the
    // promoted row already out of it, so it promotes nobody a second time.
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(await seats(eventPublicId)).toBe(0);
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

    /**
     * Both templates built from this row say «…» about the event and one of them
     * deep-links the conversation. Neither key was ever written, so both promotion
     * notifications reached real users reading `«»` with a link to `chats/`.
     */
    expect(payload['eventTitle']).toEqual(expect.stringContaining('دورهمی'));
    expect(payload['chatPublicId']).toEqual(expect.any(String));
    expect(payload['chatPublicId']).not.toBe('');
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
    // The host's notification names the event; without this it read «».
    expect(payload['eventTitle']).toEqual(expect.stringContaining('دورهمی'));
    // The guest is told too, and the fan-out only plans that half when it is named.
    expect(payload['participantUserPublicId']).toEqual(expect.any(String));
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

/**
 * The host deciding a waitlisted request directly (v0.7.0).
 *
 * «مهمان‌ها» has drawn «✅ پذیرش» and «✖️ رد» on every WAITLISTED row since
 * v0.6.2, and the host's request notification carries the same two buttons for a
 * waitlisted request — so both were offered and both were refused with «این
 * عملیات در وضعیت فعلی ممکن نیست». What is asserted here is that they now work
 * *and* that the seat check is what keeps them honest.
 */
describe('a host decides a waitlisted request', () => {
  it('rejects one, and the queue moves', async () => {
    const eventPublicId = await createEvent(1);
    const [first, second] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [first, second]);

    expect(rows[1]?.status).toBe('WAITLISTED');

    await participation.reject(hostId, rows[1]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('REJECTED');
    // Nobody was accepted, so no seat moved.
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('accepts one straight off the queue when a seat is free', async () => {
    const eventPublicId = await createEvent(1);
    const [first, second] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [first, second]);

    // The first request goes away, which frees the *slot* — and promotes the
    // second into PENDING. Rejecting the promoted row would put us back where we
    // started, so instead the host refuses the first and accepts the second,
    // which by then is PENDING. The interesting case is the one below.
    await participation.reject(hostId, rows[0]!.publicId);
    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
  });

  /**
   * The case the buttons actually produced: capacity of two, one accepted, two
   * outstanding — so the third is WAITLISTED with a seat still free.
   */
  it('accepts a waitlisted guest into a seat that is genuinely empty', async () => {
    const eventPublicId = await createEvent(2);
    const [a, b, c] = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [a, b, c]);

    expect(rows[2]?.status).toBe('WAITLISTED');

    await participation.accept(hostId, rows[2]!.publicId);

    expect(await statusOf(rows[2]!.publicId)).toBe('ACCEPTED');
    expect(await seats(eventPublicId)).toBe(1);
  });

  /**
   * And the check that stops it being a way round capacity. FIFO is no longer
   * enforced by the state machine, so it has to be enforced by the seat.
   */
  it('refuses one when every seat is taken', async () => {
    const eventPublicId = await createEvent(1);
    const [first, second] = await Promise.all([createJoiner(), createJoiner()]);
    const rows = await joinInOrder(eventPublicId, [first, second]);

    await participation.accept(hostId, rows[0]!.publicId);
    expect(await seats(eventPublicId)).toBe(1);

    await expect(participation.accept(hostId, rows[1]!.publicId)).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    });
    expect(await statusOf(rows[1]!.publicId)).toBe('WAITLISTED');
  });
});

/**
 * A request for an activity that starts soon is not born expired (v0.7.0).
 *
 * `min(now + 24h, starts_at - 3h)` goes negative inside three hours, so the
 * request was created with a deadline already behind it: the guest was told it
 * had been sent, the host was notified with two buttons, and the expiry sweep
 * retired it in between. Whichever of them pressed first was refused about a
 * state nobody had chosen.
 */
describe('the host decision window has a floor', () => {
  it('never hands out a deadline that has already passed', async () => {
    const soon = new Date(NOW.getTime() + 60 * 60 * 1000);
    const eventPublicId = await createEvent(2, soon);
    const guest = await createJoiner();

    const row = await participation.join(guest, eventPublicId);

    expect(row.hostDeadlineAt).not.toBeNull();
    expect(row.hostDeadlineAt!.getTime()).toBeGreaterThan(NOW.getTime());
    // And never past the activity it is about.
    expect(row.hostDeadlineAt!.getTime()).toBeLessThanOrEqual(soon.getTime());
  });

  /** The one that was the bug: the sweep must not retire it on sight. */
  it('leaves the request answerable rather than expiring it immediately', async () => {
    const soon = new Date(NOW.getTime() + 60 * 60 * 1000);
    const eventPublicId = await createEvent(2, soon);
    const guest = await createJoiner();
    const row = await participation.join(guest, eventPublicId);

    await participation.expireOverdue();

    expect(await statusOf(row.publicId)).toBe('PENDING');
    await expect(participation.accept(hostId, row.publicId)).resolves.toMatchObject({
      status: 'ACCEPTED',
    });
  });

  /** The plentiful case is unchanged: `starts_at - 3h` still binds. */
  it('still shortens the window for an activity a few hours out', async () => {
    const inFiveHours = new Date(NOW.getTime() + 5 * 60 * 60 * 1000);
    const eventPublicId = await createEvent(2, inFiveHours);
    const guest = await createJoiner();

    const row = await participation.join(guest, eventPublicId);

    expect(row.hostDeadlineAt).toEqual(new Date(inFiveHours.getTime() - 3 * 60 * 60 * 1000));
  });
});
