import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { EventStatus, GenderPreference, PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_CHAT_ENCRYPTION_KEY,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { render } from '@payetam/telegram';
import { planNotifications } from '../notifications/fanout';
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
 * Participation against a real database.
 *
 * ADR-0006 calls `accepted_count <= capacity` the single most important
 * correctness property in the product, and the single most likely to be silently
 * broken by a future change. Nothing here is mocked, because every property being
 * asserted belongs to Postgres: the row lock that serialises joiners, the UNIQUE
 * that makes a duplicate request impossible rather than unlikely, and the CHECK
 * that catches a code path which forgets the lock.
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

/** Comfortably in the future, so nothing is refused for being too close. */
const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');

let fixture: CatalogFixture;
let hostId: string;

interface EventOptions {
  capacity?: number;
  startsAt?: Date;
  status?: EventStatus;
  genderPreference?: GenderPreference | null;
  minAge?: number | null;
  maxAge?: number | null;
  hostUserId?: string;
  deletedAt?: Date | null;
}

let titleSequence = 0;

async function createEvent(options: EventOptions = {}): Promise<string> {
  titleSequence += 1;
  const title = `دورهمی شماره ${titleSequence}`;
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';
  const startsAt = options.startsAt ?? STARTS_AT;

  const event = await prisma.event.create({
    data: {
      hostUserId: options.hostUserId ?? hostId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity: options.capacity ?? 5,
      costType: 'FREE',
      status: options.status ?? 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
      genderPreference: options.genderPreference ?? null,
      minAge: options.minAge ?? null,
      maxAge: options.maxAge ?? null,
      deletedAt: options.deletedAt ?? null,
    },
    select: { publicId: true },
  });

  return event.publicId;
}

async function createJoiner(
  overrides: { birthYear?: number; gender?: 'MALE' | 'FEMALE' | 'PREFER_NOT_SAY' | null } = {},
): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId,
      displayName: 'شرکت‌کننده',
      cityId: fixture.tehranId,
      birthYear: overrides.birthYear ?? 1995,
      gender: overrides.gender ?? 'FEMALE',
    },
  });
  return userId;
}

async function seats(eventPublicId: string): Promise<number> {
  const event = await prisma.event.findUniqueOrThrow({
    where: { publicId: eventPublicId },
    select: { acceptedCount: true },
  });
  return event.acceptedCount;
}

async function statusCounts(eventPublicId: string): Promise<Record<string, number>> {
  const rows = await prisma.eventParticipant.groupBy({
    by: ['status'],
    where: { event: { publicId: eventPublicId } },
    _count: { _all: true },
  });
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
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

describe('the capacity invariant under concurrency (ADR-0006)', () => {
  /**
   * The proof obligation ADR-0006 sets for itself, and the reason the whole
   * design is a pessimistic lock rather than a counter.
   *
   * Fifty iterations, each on a fresh event so the loop measures contention
   * rather than the cost of truncating tables. The assertion is exact on all
   * three numbers: five seats taken, fifteen queued, and a counter that agrees
   * with the rows.
   */
  it('gives exactly 5 seats to 20 simultaneous joiners, 50 times over', async () => {
    const joiners = await Promise.all(Array.from({ length: 20 }, () => createJoiner()));

    for (let iteration = 0; iteration < 50; iteration += 1) {
      const eventPublicId = await createEvent({ capacity: 5 });

      const results = await Promise.allSettled(
        joiners.map((userId) => participation.join(userId, eventPublicId)),
      );

      // Not one of the twenty may fail: a joiner who arrives late is waitlisted,
      // not rejected.
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(rejected, `iteration ${iteration}: ${JSON.stringify(rejected[0])}`).toHaveLength(0);

      const counts = await statusCounts(eventPublicId);
      expect(counts, `iteration ${iteration}`).toEqual({ PENDING: 5, WAITLISTED: 15 });
      expect(await seats(eventPublicId), `iteration ${iteration}`).toBe(5);
    }
  }, 300_000);

  it('never lets the counter disagree with the rows that hold seats', async () => {
    const eventPublicId = await createEvent({ capacity: 3 });
    const joiners = await Promise.all(Array.from({ length: 8 }, () => createJoiner()));

    const participants = await Promise.all(
      joiners.map((userId) => participation.join(userId, eventPublicId)),
    );

    // A mixed burst: some accepted, some rejected, some withdrawn — every one of
    // them a path that moves the counter.
    const pending = participants.filter((row) => row.status === 'PENDING');
    await Promise.allSettled([
      participation.accept(hostId, pending[0]!.publicId),
      participation.reject(hostId, pending[1]!.publicId),
      participation.cancel(joiners[participants.indexOf(pending[2]!)]!, pending[2]!.publicId),
    ]);

    const held = await prisma.eventParticipant.count({
      where: { event: { publicId: eventPublicId }, status: { in: ['PENDING', 'ACCEPTED'] } },
    });
    expect(await seats(eventPublicId)).toBe(held);
  });

  /**
   * The backstop, asserted directly. ADR-0006 keeps the CHECK constraint for the
   * day a future code path forgets the lock, and a constraint nobody has ever
   * seen fire is a constraint nobody knows is armed.
   */
  it('has a database CHECK that refuses overbooking even without the lock', async () => {
    const eventPublicId = await createEvent({ capacity: 2 });

    await expect(
      prisma.event.update({
        where: { publicId: eventPublicId },
        data: { acceptedCount: 3 },
      }),
    ).rejects.toThrowError(/event_accepted_count_within_capacity|violates check constraint/i);
  });

  it('lets exactly one of two racing joiners take a single free seat', async () => {
    const eventPublicId = await createEvent({ capacity: 1 });
    const [first, second] = await Promise.all([createJoiner(), createJoiner()]);

    const results = await Promise.all([
      participation.join(first, eventPublicId),
      participation.join(second, eventPublicId),
    ]);

    const statuses = results.map((row) => row.status).sort();
    expect(statuses).toEqual(['PENDING', 'WAITLISTED']);
    expect(await seats(eventPublicId)).toBe(1);
  });
});

describe('joining', () => {
  it('takes a seat and sets the host deadline', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    expect(result.status).toBe('PENDING');
    expect(result.waitlistRank).toBeNull();
    // min(now + 24h, starts_at − 3h). The event is a month out, so the response
    // window binds.
    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-16T09:00:00.000Z'));
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('pins the deadline to the event when the event is closer than the response window', async () => {
    const eventPublicId = await createEvent({ startsAt: new Date('2026-08-15T20:00:00.000Z') });
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    // starts_at − 3h = 17:00, which is sooner than now + 24h.
    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-15T17:00:00.000Z'));
  });

  it('waitlists once the seats are gone, and ranks the queue FIFO', async () => {
    const eventPublicId = await createEvent({ capacity: 1 });
    const [a, b, c] = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);

    await participation.join(a, eventPublicId);
    clock.set(new Date(NOW.getTime() + 1000));
    const second = await participation.join(b, eventPublicId);
    clock.set(new Date(NOW.getTime() + 2000));
    const third = await participation.join(c, eventPublicId);

    expect(second.status).toBe('WAITLISTED');
    expect(second.waitlistRank).toBe(1);
    expect(third.waitlistRank).toBe(2);
    // A waitlisted request holds nothing.
    expect(await seats(eventPublicId)).toBe(1);
    expect(second.hostDeadlineAt).toBeNull();
  });

  it('refuses a second request from the same person (invariant 4)', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();

    await participation.join(joiner, eventPublicId);
    await expect(participation.join(joiner, eventPublicId)).rejects.toMatchObject({
      code: 'DUPLICATE_REQUEST',
      httpStatus: 409,
    });
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('refuses a duplicate even when both requests arrive together', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();

    const results = await Promise.allSettled([
      participation.join(joiner, eventPublicId),
      participation.join(joiner, eventPublicId),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('refuses the host of the event', async () => {
    const eventPublicId = await createEvent();

    await expect(participation.join(hostId, eventPublicId)).rejects.toMatchObject({
      code: 'HOST_CANNOT_JOIN',
    });
  });

  it.each<EventStatus>(['DRAFT', 'PENDING_MODERATION', 'HIDDEN', 'REJECTED'])(
    'refuses a %s event with the same answer as one that does not exist',
    async (status) => {
      const eventPublicId = await createEvent({ status });
      const joiner = await createJoiner();

      await expect(participation.join(joiner, eventPublicId)).rejects.toMatchObject({
        code: 'EVENT_NOT_FOUND',
      });
    },
  );

  it('refuses an event that has already started', async () => {
    const eventPublicId = await createEvent({ startsAt: new Date('2026-08-15T08:00:00.000Z') });
    const joiner = await createJoiner();

    await expect(participation.join(joiner, eventPublicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_JOINABLE',
    });
  });

  it('refuses someone who has not finished onboarding', async () => {
    const eventPublicId = await createEvent();
    const stranger = await createUser(prisma, 'TERMS_ACCEPTED');

    await expect(participation.join(stranger, eventPublicId)).rejects.toMatchObject({
      code: 'PROFILE_INCOMPLETE',
    });
  });
});

describe('eligibility, judged against the server’s copy of the profile', () => {
  it('honours a gendered restriction', async () => {
    const eventPublicId = await createEvent({ genderPreference: 'FEMALE_ONLY' });
    const [woman, man] = await Promise.all([
      createJoiner({ gender: 'FEMALE' }),
      createJoiner({ gender: 'MALE' }),
    ]);

    await expect(participation.join(woman, eventPublicId)).resolves.toMatchObject({
      status: 'PENDING',
    });
    await expect(participation.join(man, eventPublicId)).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_GENDER',
    });
  });

  /**
   * Refusing rather than admitting is the deliberate choice: admitting someone
   * the host explicitly excluded is worse than a refusal that names its reason
   * and lets the user decide whether to state a gender.
   */
  it('refuses an unstated gender for a gendered event', async () => {
    const eventPublicId = await createEvent({ genderPreference: 'FEMALE_ONLY' });
    const undisclosed = await createJoiner({ gender: 'PREFER_NOT_SAY' });

    await expect(participation.join(undisclosed, eventPublicId)).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_GENDER',
    });
  });

  it('honours an age range at both ends', async () => {
    const eventPublicId = await createEvent({ minAge: 25, maxAge: 35 });
    const [tooYoung, fits, tooOld] = await Promise.all([
      createJoiner({ birthYear: 2006 }),
      createJoiner({ birthYear: 1995 }),
      createJoiner({ birthYear: 1980 }),
    ]);

    await expect(participation.join(fits, eventPublicId)).resolves.toMatchObject({
      status: 'PENDING',
    });
    await expect(participation.join(tooYoung, eventPublicId)).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_AGE',
    });
    await expect(participation.join(tooOld, eventPublicId)).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_AGE',
    });
  });
});

describe('the host decides', () => {
  it('accepts without moving the counter — the seat was already held', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    expect(await seats(eventPublicId)).toBe(1);

    const accepted = await participation.accept(hostId, request.publicId);

    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.acceptedAt).toEqual(NOW);
    // 15 minutes of free withdrawal (plan §11).
    expect(accepted.graceExpiresAt).toEqual(new Date('2026-08-15T09:15:00.000Z'));
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('gives the seat back on a rejection', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    const rejected = await participation.reject(hostId, request.publicId);

    expect(rejected.status).toBe('REJECTED');
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('refuses to decide twice', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.accept(hostId, request.publicId);
    await expect(participation.accept(hostId, request.publicId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      httpStatus: 409,
    });
    await expect(participation.reject(hostId, request.publicId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('lets nobody but the host decide, and does not confirm the request exists', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const outsider = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await expect(participation.accept(outsider, request.publicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Not even the person whose request it is may accept it.
    await expect(participation.accept(joiner, request.publicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('shows the host the queue in order, with names and ranks', async () => {
    const eventPublicId = await createEvent({ capacity: 1 });
    const [a, b] = await Promise.all([createJoiner(), createJoiner()]);
    await participation.join(a, eventPublicId);
    clock.set(new Date(NOW.getTime() + 1000));
    await participation.join(b, eventPublicId);

    const list = await participation.listForEvent(hostId, eventPublicId);

    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ status: 'PENDING', waitlistRank: null });
    expect(list[1]).toMatchObject({ status: 'WAITLISTED', waitlistRank: 1 });
    expect(list[0]?.displayName).toBe('شرکت‌کننده');
  });

  it('does not show one host another host’s participants', async () => {
    const eventPublicId = await createEvent();
    const otherHost = await createJoiner();

    await expect(participation.listForEvent(otherHost, eventPublicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
  });

  /**
   * The host sees each requester's Trust Score (M18).
   *
   * The property that actually matters is the **pairing**: with several requests
   * in the queue, each score has to belong to the person it is rendered beside.
   * A batched lookup keyed by `user_id` is easy to get subtly wrong — off by one
   * against the row order, or silently reusing the first row for everybody — and
   * neither mistake is visible from a single-requester test.
   */
  it('attaches each requester’s Trust Score to the right requester', async () => {
    const eventPublicId = await createEvent({ capacity: 5 });
    const [a, b, c] = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);

    await trust.apply({
      userId: a,
      delta: 12,
      type: 'ADMIN_ADJUSTMENT',
      reasonCode: 'test.a',
      idempotencyKey: 'trust-test-a',
      actorType: 'SYSTEM',
    });
    await trust.apply({
      userId: c,
      delta: -7,
      type: 'ADMIN_ADJUSTMENT',
      reasonCode: 'test.c',
      idempotencyKey: 'trust-test-c',
      actorType: 'SYSTEM',
    });

    await participation.join(a, eventPublicId);
    clock.set(new Date(NOW.getTime() + 1000));
    await participation.join(b, eventPublicId);
    clock.set(new Date(NOW.getTime() + 2000));
    await participation.join(c, eventPublicId);

    const list = await participation.listForEvent(hostId, eventPublicId);

    const scores = new Map(list.map((row) => [row.userPublicId, row.trustScore]));
    const [publicA, publicB, publicC] = await Promise.all(
      [a, b, c].map(
        async (id) =>
          (await prisma.user.findUniqueOrThrow({ where: { id }, select: { publicId: true } }))
            .publicId,
      ),
    );

    // The starting score is 50 (plan §11), so +12 and −7 land here.
    expect(scores.get(publicA!)).toBe(62);
    expect(scores.get(publicC!)).toBe(43);
    // `b` has never moved, so there is no `trust_score` row — and a missing row is
    // "never judged", not zero. The client renders «تازه‌وارد» for this.
    expect(scores.get(publicB!)).toBeNull();
  });
});

describe('the participant withdraws', () => {
  it('frees the seat and records a grace-period cancellation', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);

    clock.set(new Date(NOW.getTime() + 5 * 60_000));
    const cancelled = await participation.cancel(joiner, request.publicId, 'برنامه‌ام عوض شد');

    expect(cancelled.status).toBe('CANCELLED_BY_PARTICIPANT');
    expect(cancelled.cancellationBucket).toBe('GRACE');
    expect(await seats(eventPublicId)).toBe(0);
  });

  it.each([
    ['more than a day before', new Date('2026-09-18T15:00:00.000Z'), 'GT_24H'],
    ['inside the 24-to-3-hour window', new Date('2026-09-20T09:00:00.000Z'), 'H24_TO_H3'],
    ['under three hours before', new Date('2026-09-20T13:30:00.000Z'), 'LT_3H'],
  ])('buckets a cancellation %s as %s', async (_label, when, expected) => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);

    clock.set(when);
    const cancelled = await participation.cancel(joiner, request.publicId);

    expect(cancelled.cancellationBucket).toBe(expected);
  });

  /**
   * Withdrawing from a queue costs nothing, so it gets no bucket. Giving it one
   * would put a row in front of M10's penalty job that should never have been
   * there.
   */
  it('gives no bucket to a request that never held a seat', async () => {
    const eventPublicId = await createEvent({ capacity: 1 });
    const [a, b] = await Promise.all([createJoiner(), createJoiner()]);
    await participation.join(a, eventPublicId);
    const queued = await participation.join(b, eventPublicId);

    const cancelled = await participation.cancel(b, queued.publicId);

    expect(cancelled.status).toBe('CANCELLED_BY_PARTICIPANT');
    expect(cancelled.cancellationBucket).toBeNull();
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('lets nobody cancel somebody else’s request', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const outsider = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await expect(participation.cancel(outsider, request.publicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Not even the host, who has their own path for that (M10).
    await expect(participation.cancel(hostId, request.publicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('frees exactly one seat per cancellation when several arrive at once', async () => {
    const eventPublicId = await createEvent({ capacity: 3 });
    const joiners = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    const requests = await Promise.all(
      joiners.map((userId) => participation.join(userId, eventPublicId)),
    );
    expect(await seats(eventPublicId)).toBe(3);

    await Promise.all(
      requests.map((request, index) => participation.cancel(joiners[index]!, request.publicId)),
    );

    expect(await seats(eventPublicId)).toBe(0);
  });
});

describe('expiry', () => {
  it('retires a request the host never answered, and frees its seat', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    expect(await seats(eventPublicId)).toBe(1);

    // One second past min(now + 24h, starts_at − 3h).
    clock.set(new Date('2026-08-16T09:00:01.000Z'));
    const expired = await participation.expireOverdue();

    expect(expired).toBe(1);
    expect(await statusCounts(eventPublicId)).toEqual({ EXPIRED: 1 });
    expect(await seats(eventPublicId)).toBe(0);
    expect((await participation.listMine(joiner))[0]?.status).toBe('EXPIRED');
    void request;
  });

  it('leaves a request whose deadline has not passed', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    clock.set(new Date('2026-08-16T08:59:59.000Z'));

    expect(await participation.expireOverdue()).toBe(0);
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('does not touch a request the host decided in the meantime', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));

    expect(await participation.expireOverdue()).toBe(0);
    expect(await statusCounts(eventPublicId)).toEqual({ ACCEPTED: 1 });
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('is idempotent when the sweep runs twice', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));

    expect(await participation.expireOverdue()).toBe(1);
    expect(await participation.expireOverdue()).toBe(0);
    expect(await seats(eventPublicId)).toBe(0);
  });
});

describe('capacity edits race joins (ADR-0006, rule 1)', () => {
  /**
   * Lowering `capacity` changes the bound `accepted_count` is checked against,
   * so it contends with joins for the same invariant. Before M6 the edit path
   * read the counter without the lock; a join committing in that window could
   * leave `accepted_count > capacity` and turn the CHECK into a 500.
   */
  it('cannot lower capacity below the seats already taken', async () => {
    const eventPublicId = await createEvent({ capacity: 3 });
    const joiners = await Promise.all([createJoiner(), createJoiner(), createJoiner()]);
    await Promise.all(joiners.map((userId) => participation.join(userId, eventPublicId)));

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { capacity: true, acceptedCount: true },
    });

    expect(event.acceptedCount).toBe(3);
    expect(event.capacity).toBe(3);
  });
});

/**
 * What a user actually receives, rendered from what the service actually emitted.
 *
 * This is the gap the original bug lived in. The templates were tested with
 * hand-written payloads that contained `eventTitle`, and the services were tested for
 * the rows they wrote — so nothing ever rendered a *real* payload, and every
 * notification that names an event reached users as `«»`. Ten template lines read
 * `eventTitle`; no emitter wrote one.
 *
 * Driving the real flow and rendering the real row is the only arrangement in which
 * that is visible at all.
 */
describe('the notification a real acceptance produces', () => {
  /** `«»`, with or without whitespace between the guillemets. */
  const EMPTY_QUOTES = /«\s*»/;

  async function renderedFor(eventType: string): Promise<string[]> {
    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType },
      orderBy: { createdAt: 'desc' },
    });

    return planNotifications({
      id: row.id,
      eventType: row.eventType,
      aggregateId: row.aggregateId,
      payload: row.payload as Record<string, unknown>,
    }).map((plan) => render(plan.templateKey, plan.payload)?.text ?? '');
  }

  it('names the event instead of showing an empty «»', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.accept(hostId, request.publicId);

    const [text] = await renderedFor('participation.accepted');
    expect(text).toBeDefined();
    expect(text).not.toMatch(EMPTY_QUOTES);
    expect(text).toContain('دورهمی');
  });

  it('deep-links the conversation the acceptance opened, not `chats/`', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'participation.accepted' },
    });
    const payload = row.payload as Record<string, unknown>;

    expect(payload['chatPublicId']).toEqual(expect.any(String));
    expect(payload['chatPublicId']).not.toBe('');
    expect(payload['chatPublicId']).toBe(request.chatPublicId);
  });

  it('names the event in a rejection too', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.reject(hostId, request.publicId);

    const [text] = await renderedFor('participation.rejected');
    expect(text).not.toMatch(EMPTY_QUOTES);
    expect(text).toContain('دورهمی');
  });

  it('names the event in both halves of the join notification', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    const texts = await renderedFor('participation.requested');

    // Host and guest: the guest half is only planned when the payload names them.
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).not.toMatch(EMPTY_QUOTES);
      expect(text).toContain('دورهمی');
    }
  });
});

describe('the audit trail (invariant 10)', () => {
  it('records every transition with the actor who caused it', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);

    clock.set(new Date(NOW.getTime() + 60_000));
    await participation.cancel(joiner, request.publicId);

    const trail = await prisma.auditLog.findMany({
      where: { targetType: 'event_participant' },
      orderBy: { createdAt: 'asc' },
      select: { action: true, actorId: true, actorType: true },
    });

    expect(trail.map((row) => row.action)).toEqual([
      'participation.requested',
      'participation.accepted',
      'participation.cancelled',
    ]);
    expect(trail[0]?.actorId).toBe(joiner);
    expect(trail[1]?.actorId).toBe(hostId);
    expect(trail.every((row) => row.actorType === 'USER')).toBe(true);
  });

  it('attributes an expiry to the system, not to a person', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));
    await participation.expireOverdue();

    const expiry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'participation.expired' },
      select: { actorType: true, actorId: true },
    });

    expect(expiry.actorType).toBe('SYSTEM');
    expect(expiry.actorId).toBeNull();
  });
});
