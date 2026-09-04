import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { EventStatus, GenderPreference, PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { render } from '@payetam/telegram';
import { ErrorCode } from '@payetam/shared';
import { planNotifications } from '../notifications/fanout';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import {
  EVENT_JOIN_EXPIRY_REFUND_REASON,
  EVENT_JOIN_REASON,
  EVENT_JOIN_REFUND_REASON,
  ParticipationService,
} from './participation.service';
import { SEAT_HOLDING_STATUSES } from './state-machine';

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

/**
 * Enough coins to ask to join, several times over.
 *
 * `economy.event_join_coins` is 5 from v0.7.0 and `join` charges it inside the
 * same transaction, so a joiner with an empty account is refused with
 * `INSUFFICIENT_COINS` before reaching any of the behaviour this suite is about.
 * The endowment is deliberately generous and round: nothing here asserts a bare
 * balance, so the number only has to be out of the way.
 */
const JOIN_BUDGET = 500;

async function createJoiner(
  overrides: { birthYear?: number; gender?: 'MALE' | 'FEMALE' | 'PREFER_NOT_SAY' | null } = {},
): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: JOIN_BUDGET });
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

/**
 * ── What `accepted_count` counts, from v0.6.5 ───────────────────────────────
 *
 * **Accepted people, and nothing else.** A PENDING request used to hold a seat
 * too, and the behaviour that produced is the report this changed for: an event
 * with two places showed «ظرفیت تکمیل» while one request had been rejected and
 * another had expired, because each release promoted somebody who took the seat
 * again.
 *
 * What bounds the queue instead is `accepted_count + PENDING` — the same
 * arithmetic, with the two quantities kept apart rather than summed into one
 * column. So every assertion below reads: **the queue is bounded at capacity,
 * and the counter is zero until a host says yes.**
 */
describe('the capacity invariant under concurrency (ADR-0006)', () => {
  /**
   * The proof obligation ADR-0006 sets for itself, and the reason the whole
   * design is a pessimistic lock rather than a counter.
   *
   * Fifty iterations, each on a fresh event so the loop measures contention
   * rather than the cost of truncating tables. The assertion is exact on all
   * three numbers: five asked about, fifteen queued, and no seat taken by any of
   * them until the host decides.
   */
  it('asks the host about exactly 5 of 20 simultaneous joiners, 50 times over', async () => {
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
      // Nobody has been accepted, so every seat is still free — which is the
      // number «۵ جای خالی از ۵» is rendered from.
      expect(await seats(eventPublicId), `iteration ${iteration}`).toBe(0);
    }
  }, 300_000);

  /**
   * And the other half of the same property: accepting is what fills them, and
   * twenty simultaneous acceptances cannot overfill.
   */
  it('fills exactly 5 seats when the host accepts all 5', async () => {
    const eventPublicId = await createEvent({ capacity: 5 });
    const joiners = await Promise.all(Array.from({ length: 20 }, () => createJoiner()));
    const rows = await Promise.all(
      joiners.map((userId) => participation.join(userId, eventPublicId)),
    );

    const pending = rows.filter((row) => row.status === 'PENDING');
    await Promise.allSettled(pending.map((row) => participation.accept(hostId, row.publicId)));

    expect(await seats(eventPublicId)).toBe(5);
  });

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

    // `SEAT_HOLDING_STATUSES` is `['ACCEPTED']` from v0.6.5, and this is the
    // assertion that says so against a real counter rather than a constant.
    const held = await prisma.eventParticipant.count({
      where: { event: { publicId: eventPublicId }, status: { in: [...SEAT_HOLDING_STATUSES] } },
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

  it('lets exactly one of two racing joiners into the host’s queue', async () => {
    const eventPublicId = await createEvent({ capacity: 1 });
    const [first, second] = await Promise.all([createJoiner(), createJoiner()]);

    const results = await Promise.all([
      participation.join(first, eventPublicId),
      participation.join(second, eventPublicId),
    ]);

    const statuses = results.map((row) => row.status).sort();
    expect(statuses).toEqual(['PENDING', 'WAITLISTED']);
    // The seat is untouched: one of them is being asked about, not seated.
    expect(await seats(eventPublicId)).toBe(0);
  });
});

describe('joining', () => {
  it('enters the host’s queue and sets the deadline, without taking a seat', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    expect(result.status).toBe('PENDING');
    expect(result.waitlistRank).toBeNull();
    // min(now + 24h, starts_at − 3h). The event is a month out, so the response
    // window binds.
    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-16T09:00:00.000Z'));
    // A question is not a seat (v0.6.5). `accept` is what fills one.
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('pins the deadline to the event when the event is closer than the response window', async () => {
    const eventPublicId = await createEvent({ startsAt: new Date('2026-08-15T20:00:00.000Z') });
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    // starts_at − 3h = 17:00, which is sooner than now + 24h.
    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-15T17:00:00.000Z'));
  });

  it('waitlists once the host’s queue is full, and ranks it FIFO', async () => {
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
    // Neither a waitlisted nor a pending request holds a seat: one place, nobody
    // accepted, one place free.
    expect(await seats(eventPublicId)).toBe(0);
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
    expect(await seats(eventPublicId)).toBe(0);
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
    expect(await seats(eventPublicId)).toBe(0);
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
  /**
   * The inversion, as a test. Before v0.6.5 accepting moved nothing, because the
   * request had held the seat since it was made. Now it is the **only**
   * transition that takes one.
   */
  it('takes the seat — this is the moment a place is filled', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    expect(await seats(eventPublicId)).toBe(0);

    const accepted = await participation.accept(hostId, request.publicId);

    expect(accepted.status).toBe('ACCEPTED');
    expect(accepted.acceptedAt).toEqual(NOW);
    // 15 minutes of free withdrawal (plan §11).
    expect(accepted.graceExpiresAt).toEqual(new Date('2026-08-15T09:15:00.000Z'));
    expect(await seats(eventPublicId)).toBe(1);
  });

  it('leaves the counter alone on a rejection — no seat was ever taken', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    const rejected = await participation.reject(hostId, request.publicId);

    expect(rejected.status).toBe('REJECTED');
    expect(await seats(eventPublicId)).toBe(0);
  });
});

/**
 * What asking costs, and when it comes back (v0.8.1).
 *
 * `economy.event_join_coins` is 5 and the charge lands inside the join
 * transaction. What changed is the other end: a **rejection** reverses it, so
 * the charge is a deposit against a host's attention rather than a fee for being
 * turned down. Nothing else reverses it — an expiry held the host's queue slot
 * for a day, and a withdrawal is priced on its own thresholds by `cancel`.
 */
describe('the join charge and its refund', () => {
  const JOIN_COST = 5;

  /**
   * Only the rows this participation caused.
   *
   * `createJoiner` endows the account, and that endowment is a `coin_ledger` row
   * like any other — so a bare `where: { userId }` counts it and every assertion
   * about "the charge and its refund" would be off by one. `reverse` copies
   * `ref_type` and `ref_id` from the row it undoes, which is what makes this
   * filter catch both halves of the pair and nothing else.
   */
  async function ledgerFor(userId: string) {
    return prisma.coinLedger.findMany({
      where: { userId, refType: 'event_participant' },
      orderBy: { createdAt: 'asc' },
      select: { amount: true, type: true, reasonCode: true, reversesLedgerId: true },
    });
  }

  it('takes five coins at the moment the request is made', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();

    await participation.join(joiner, eventPublicId);

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET - JOIN_COST);
    expect(await ledgerFor(joiner)).toMatchObject([
      { amount: -JOIN_COST, type: 'EVENT_JOIN_SPEND', reasonCode: EVENT_JOIN_REASON },
    ]);
  });

  it('gives them back when the host says no', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.reject(hostId, request.publicId);

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET);

    const ledger = await ledgerFor(joiner);
    expect(ledger).toHaveLength(2);
    // A reversal, not a fresh credit: the refund points at the row it undoes, so
    // a ledger filtered by this participant shows the charge and its refund
    // together and the price cannot drift between the two.
    expect(ledger[1]).toMatchObject({
      amount: JOIN_COST,
      type: 'REVERSAL',
      reasonCode: EVENT_JOIN_REFUND_REASON,
    });
    expect(ledger[1]?.reversesLedgerId).not.toBeNull();
  });

  /**
   * A second rejection cannot pay twice.
   *
   * Three guards stand between here and a double refund and any one would do:
   * `assertParticipantTransition` refuses a terminal-to-terminal move,
   * `reverse` derives its idempotency key from the row it undoes, and there is a
   * UNIQUE on `reverses_ledger_id`. The test is about the outcome rather than
   * about which of them fired.
   */
  it('refunds once however many times the host taps', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.reject(hostId, request.publicId);
    await expect(participation.reject(hostId, request.publicId)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    });

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET);
    expect(await ledgerFor(joiner)).toHaveLength(2);
  });

  /** An acceptance is what the coins bought. Nothing comes back. */
  it('keeps the charge when the host says yes', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.accept(hostId, request.publicId);

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET - JOIN_COST);
  });

  /**
   * A guest who withdraws pays for their own decision.
   *
   * The join charge stays and the cancellation is priced by its own bucket on
   * top — refunding the ask here would make standing down cheaper than never
   * asking, which is the opposite of what the penalty is for.
   */
  it('keeps the charge when the guest withdraws', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.cancel(joiner, request.publicId);

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET - JOIN_COST);
    expect(
      (await ledgerFor(joiner)).some((row) => row.reasonCode === EVENT_JOIN_REFUND_REASON),
    ).toBe(false);
  });

  /** The rejected guest is told, and the message carries the figure. */
  it('tells the guest how much came back', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    await participation.reject(hostId, request.publicId);

    const emitted = await prisma.outboxEvent.findFirst({
      where: { eventType: 'participation.rejected', aggregateId: { not: '' } },
      orderBy: { createdAt: 'desc' },
    });

    expect(emitted?.payload).toMatchObject({ coinsRefunded: JOIN_COST });
  });

  /** …and an accepted person who is then cancelled does give one back. */
  it('gives the seat back when an accepted place is given up', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);
    expect(await seats(eventPublicId)).toBe(1);

    await participation.cancel(joiner, request.publicId);

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
    // Nobody was accepted, so nothing was ever taken to give back.
    expect(await seats(eventPublicId)).toBe(0);
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
    // Accepted first, because from v0.6.5 that is what puts a seat in a state to
    // be freed — the property this test is about is the *decrementing*, and a
    // counter that was never incremented would demonstrate nothing.
    for (const request of requests) await participation.accept(hostId, request.publicId);
    expect(await seats(eventPublicId)).toBe(3);

    await Promise.all(
      requests.map((request, index) => participation.cancel(joiners[index]!, request.publicId)),
    );

    expect(await seats(eventPublicId)).toBe(0);
  });
});

describe('expiry', () => {
  it('retires a request the host never answered, and frees its slot', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    // No seat to free — an unanswered request holds a slot in the queue, and the
    // deadline is the bound on how long it can (v0.6.5).
    expect(await seats(eventPublicId)).toBe(0);

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
    expect(await seats(eventPublicId)).toBe(0);
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

  /**
   * The coins come back, and the guest is told (v0.8.1).
   *
   * A stronger case than the rejection refund, not a weaker one: a rejected
   * guest at least got an answer. This one paid five coins, waited a day, and
   * got nothing — and until v0.8.1 was not even told the request had died.
   */
  it('gives the coins back when nobody answered', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);
    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET - 5);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));
    await participation.expireOverdue();

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET);

    const refund = await prisma.coinLedger.findFirstOrThrow({
      where: { userId: joiner, type: 'REVERSAL' },
      select: { amount: true, reasonCode: true, actorType: true, reversesLedgerId: true },
    });
    expect(refund).toMatchObject({
      amount: 5,
      // Its own code, so an operator can count unanswered requests without
      // joining back to `event_participant`.
      reasonCode: EVENT_JOIN_EXPIRY_REFUND_REASON,
      // Nobody acted. Writing the host's id against a refund caused by them not
      // deciding would put a fiction in the trail.
      actorType: 'SYSTEM',
    });
    expect(refund.reversesLedgerId).not.toBeNull();
  });

  it('tells the guest, and names the refund', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));
    await participation.expireOverdue();

    const emitted = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'participation.expired' },
    });
    expect(emitted.payload).toMatchObject({ coinsRefunded: 5, eventPublicId });

    // Only the guest: an expiry is the outcome the host's own inaction chose.
    const planned = planNotifications({
      id: emitted.id,
      aggregateId: emitted.aggregateId,
      eventType: emitted.eventType,
      payload: emitted.payload as Record<string, unknown>,
    });
    expect(planned).toHaveLength(1);
    expect(render(planned[0]!.templateKey, planned[0]!.payload)?.text).toContain('۵ سکه');
  });

  /** The sweep running twice must not pay twice. */
  it('refunds once however often the sweep runs', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    clock.set(new Date('2026-08-16T09:00:01.000Z'));
    await participation.expireOverdue();
    await participation.expireOverdue();

    expect(await coins.balanceOf(joiner)).toBe(JOIN_BUDGET);
    expect(await prisma.coinLedger.count({ where: { userId: joiner, type: 'REVERSAL' } })).toBe(1);
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
    const requests = await Promise.all(
      joiners.map((userId) => participation.join(userId, eventPublicId)),
    );
    // Accepted, because from v0.6.5 that is what a *taken* seat means — three
    // outstanding questions bound nothing about capacity.
    for (const request of requests) await participation.accept(hostId, request.publicId);

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { capacity: true, acceptedCount: true },
    });

    expect(event.acceptedCount).toBe(3);
    expect(event.capacity).toBe(3);

    // The CHECK is what refuses the shrink, whoever writes it.
    await expect(
      prisma.event.update({ where: { publicId: eventPublicId }, data: { capacity: 2 } }),
    ).rejects.toThrowError(/event_accepted_count_within_capacity|violates check constraint/i);
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

  /**
   * The acceptance payload carries no conversation id any more (v0.8.0).
   *
   * It used to, and the assertion here was that it was a real one rather than an
   * empty string — the template deep-linked `chats/<id>` and an empty id sent the
   * host to a screen that did not exist. There is no conversation and no such
   * screen; a payload still carrying the key would be a template one deploy away
   * from pointing at nothing again.
   */
  it('carries no conversation id', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);
    await participation.accept(hostId, request.publicId);

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'participation.accepted' },
    });

    expect(row.payload as Record<string, unknown>).not.toHaveProperty('chatPublicId');
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

/**
 * The deadline floor (v0.7.0).
 *
 * `min(now + 24h, starts_at − 3h)` goes **negative** for an activity starting in
 * under three hours, and the request was then born already expired: the guest was
 * told it had been sent, the host was notified with two buttons, and whichever of
 * them pressed first was refused with «این عملیات در وضعیت فعلی ممکن نیست» about a
 * state nobody had chosen. The sweep had retired it somewhere in between.
 *
 * `participation.min_response_minutes` is the floor that fixed it, and until now
 * it was the one setting in this service with no test at all — so the fix was one
 * refactor away from being undone silently, and the symptom would have reappeared
 * as a refusal nobody could reproduce.
 *
 * The cases below move the **clock**, not the settings, because the floor is a
 * property of how close the activity is; the two that do write `app_setting` are
 * the ones asserting the number is a policy rather than a constant.
 */
describe('the deadline floor (v0.7.0)', () => {
  /** Two hours out: `starts_at − 3h` is an hour in the past. */
  const IMMINENT = new Date('2026-08-15T11:00:00.000Z');

  it('gives an imminent activity a window instead of a deadline in the past', async () => {
    const eventPublicId = await createEvent({ startsAt: IMMINENT });
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    // Without the floor this would be 08:00 — before `now`, which is the whole bug.
    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-15T09:30:00.000Z'));
    expect(result.hostDeadlineAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(result.status).toBe('PENDING');
  });

  /**
   * The floor is itself bounded by the start.
   *
   * A deadline after the activity has begun is a decision nobody can act on
   * either, so `min(now + 30m, starts_at)` is what the floor actually is — and for
   * an activity ten minutes away the second term is the one that binds.
   */
  it('never pushes the deadline past the start of the activity', async () => {
    const startsAt = new Date('2026-08-15T09:10:00.000Z');
    const eventPublicId = await createEvent({ startsAt });
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    expect(result.hostDeadlineAt).toEqual(startsAt);
  });

  /**
   * The reported symptom, from the host's side.
   *
   * This is the assertion that would have failed before v0.7.0: the request was
   * already past its deadline when it was written, so the sweep retired it and the
   * host's «پذیرش» met `INVALID_STATE_TRANSITION`.
   */
  it('lets the host accept inside that window', async () => {
    const eventPublicId = await createEvent({ startsAt: IMMINENT });
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    const accepted = await participation.accept(hostId, request.publicId);

    expect(accepted.status).toBe('ACCEPTED');
    expect(await seats(eventPublicId)).toBe(1);
  });

  /** And from the guest's side, which is the same bug reached by the other button. */
  it('lets the guest stand down inside that window', async () => {
    const eventPublicId = await createEvent({ startsAt: IMMINENT });
    const joiner = await createJoiner();
    const request = await participation.join(joiner, eventPublicId);

    const cancelled = await participation.cancel(joiner, request.publicId);

    expect(cancelled.status).toBe('CANCELLED_BY_PARTICIPANT');
  });

  /**
   * The sweep is the third party to this, and the one that actually did the
   * damage: it selects `hostDeadlineAt <= now`, so a deadline born in the past was
   * collected on the very next pass — within a minute, by `SCHEDULE`.
   */
  it('does not let the expiry sweep retire it on the next pass', async () => {
    const eventPublicId = await createEvent({ startsAt: IMMINENT });
    const joiner = await createJoiner();
    await participation.join(joiner, eventPublicId);

    expect(await participation.expireOverdue()).toBe(0);
    expect(await statusCounts(eventPublicId)).toEqual({ PENDING: 1 });

    // …and the window does close, one second past the floor.
    clock.set(new Date('2026-08-15T09:30:01.000Z'));
    expect(await participation.expireOverdue()).toBe(1);
    expect(await statusCounts(eventPublicId)).toEqual({ EXPIRED: 1 });
  });

  /** The floor is a policy number, so a longer one is a config change. */
  it('honours a wider floor from app_setting, with no deploy', async () => {
    await prisma.appSetting.create({
      data: { key: 'participation.min_response_minutes', value: 90 },
    });
    const eventPublicId = await createEvent({ startsAt: IMMINENT });
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-15T10:30:00.000Z'));
  });

  /**
   * Zero is the rollback, and what it actually restores is worth stating exactly.
   *
   * It does **not** put the deadline back to `starts_at − 3h`. The floor is
   * `min(now + 0, starts_at)`, which is `now` — so the deadline lands on the
   * current instant rather than an hour behind it. The effect is the same as the
   * bug, because `expireOverdue` selects `hostDeadlineAt <= now`: the request is
   * collected by the very next sweep, within a minute. Reaching that deliberately
   * is the point; reaching it by accident was the report.
   */
  it('is disabled by zero, which collapses the window onto the present', async () => {
    await prisma.appSetting.create({
      data: { key: 'participation.min_response_minutes', value: 0 },
    });
    const eventPublicId = await createEvent({ startsAt: IMMINENT });
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    expect(result.hostDeadlineAt).toEqual(NOW);
    expect(await participation.expireOverdue()).toBe(1);
  });

  /**
   * The floor must not reach an activity that is comfortably away, or it would be
   * silently widening every ordinary deadline by half an hour.
   */
  it('leaves an ordinary deadline exactly where it was', async () => {
    const eventPublicId = await createEvent();
    const joiner = await createJoiner();

    const result = await participation.join(joiner, eventPublicId);

    expect(result.hostDeadlineAt).toEqual(new Date('2026-08-16T09:00:00.000Z'));
  });
});
