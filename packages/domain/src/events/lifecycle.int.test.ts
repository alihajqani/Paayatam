import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { ChatService } from '../chat/chat.service';
import { MessageCipher } from '../chat/message-cipher';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { ReferralService } from '../economy/referral.service';
import { TrustService } from '../economy/trust.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { ReviewService } from '../reviews/review.service';
import { EventLifecycleService } from './lifecycle.service';

/**
 * What happens to an event after it is over (M10).
 *
 * **This is the file that makes `COMPLETED` reachable.** M9 built the referral
 * payout against `event_participant.status = 'COMPLETED'` and recorded, as an
 * open gap, that nothing in the product ever wrote it. `settleAttendance` is what
 * writes it — so the tests here close M9's gap as well as proving M10's own.
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
const blacklist = new BlacklistService(service);
const moderation = new ModerationService(service, blacklist);
const referrals = new ReferralService(
  service,
  clock,
  settings,
  coins,
  audit,
  outbox,
  new MetricsRegistry(),
);
const reviews = new ReviewService(
  service,
  clock,
  settings,
  coins,
  trust,
  moderation,
  audit,
  outbox,
);
const lifecycle = new EventLifecycleService(
  service,
  clock,
  env,
  settings,
  trust,
  referrals,
  penalties,
  reviews,
  audit,
  outbox,
);
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
const ENDS_AT = new Date(STARTS_AT.getTime() + 3 * 3_600_000);
/**
 * What asking to join costs, and enough of it (`economy.event_join_coins`).
 *
 * Five from v0.7.0, charged by `join` inside the same transaction — so a joiner
 * with an empty account is refused with `INSUFFICIENT_COINS` before reaching any
 * of the behaviour this suite is about. The endowment covers several, because
 * the attendance-cap test deliberately joins one person to three activities.
 *
 * The balance assertions below are written **relative to these two**, rather
 * than as bare numbers, so they stay about the reward or the penalty they are
 * testing when the join price changes again.
 */
const JOIN_COST = 5;
const JOIN_BUDGET = 100;

/** Past the end and past the settlement delay, so a sweep will act. */
const AFTER_SETTLEMENT = new Date(ENDS_AT.getTime() + 25 * 3_600_000);

let fixture: CatalogFixture;
let hostId: string;

async function createProfiledUser(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: JOIN_BUDGET });
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

async function publishEvent(overrides: { startsAt?: Date; endsAt?: Date } = {}): Promise<string> {
  const startsAt = overrides.startsAt ?? STARTS_AT;
  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title: 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: overrides.endsAt ?? new Date(startsAt.getTime() + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return event.publicId;
}

async function accepted(eventPublicId: string): Promise<{ userId: string; publicId: string }> {
  const userId = await createProfiledUser();
  const request = await participation.join(userId, eventPublicId);
  await participation.accept(hostId, request.publicId);
  return { userId, publicId: request.publicId };
}

/** Runs the two sweeps in the order the scheduler will (§3.5). */
async function sweep(): Promise<void> {
  await lifecycle.retireStarted();
  await lifecycle.settleAttendance();
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await createProfiledUser();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('retiring an event that has begun (plan §7)', () => {
  it('marks it ONGOING once it starts and COMPLETED once it ends', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(new Date(STARTS_AT.getTime() + 60_000));
    await lifecycle.retireStarted();
    await expect(statusOf(eventPublicId)).resolves.toBe('ONGOING');

    clock.set(new Date(ENDS_AT.getTime() + 60_000));
    await lifecycle.retireStarted();
    await expect(statusOf(eventPublicId)).resolves.toBe('COMPLETED');
  });

  /**
   * `PUBLISHED → COMPLETED` is not a legal edge, so an event whose whole duration
   * elapsed between two sweeps still passes through ONGOING. The state machine is
   * the authority on the shape of the path, not how often the job happens to run.
   */
  it('passes through ONGOING even when the whole event elapsed between sweeps', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(new Date(ENDS_AT.getTime() + 60_000));
    await lifecycle.retireStarted();

    await expect(statusOf(eventPublicId)).resolves.toBe('COMPLETED');
  });

  /** §7: "EXPIRED (start passed, 0 accepted)". Nobody came, so nothing happened. */
  it('expires an event that reached its start with nobody accepted', async () => {
    const eventPublicId = await publishEvent();

    clock.set(new Date(STARTS_AT.getTime() + 60_000));
    await lifecycle.retireStarted();

    await expect(statusOf(eventPublicId)).resolves.toBe('EXPIRED');
  });

  /**
   * An event can reach zero seated *after* it has begun: everybody accepted can
   * still cancel once it has started, and a no-show report empties a seat too.
   * `ONGOING → EXPIRED` is not a legal edge, so deciding EXPIRED there would throw
   * out of the sweep and take the rest of the batch with it.
   */
  it('completes an ongoing event whose participants all dropped out', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);

    clock.set(new Date(STARTS_AT.getTime() + 60_000));
    await lifecycle.retireStarted();
    await expect(statusOf(eventPublicId)).resolves.toBe('ONGOING');

    await participation.cancel(person.userId, person.publicId);

    clock.set(new Date(ENDS_AT.getTime() + 60_000));
    await lifecycle.retireStarted();
    await expect(statusOf(eventPublicId)).resolves.toBe('COMPLETED');
  });

  it('leaves an event that has not started alone', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    await lifecycle.retireStarted();
    await expect(statusOf(eventPublicId)).resolves.toBe('PUBLISHED');
  });

  it('is safe to run twice', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(new Date(ENDS_AT.getTime() + 60_000));
    const first = await lifecycle.retireStarted();
    const second = await lifecycle.retireStarted();

    expect(first.completed).toBe(1);
    expect(second.completed).toBe(0);
  });
});

describe('settling who attended', () => {
  it('completes everyone still accepted, once the delay has passed', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);

    clock.set(AFTER_SETTLEMENT);
    await sweep();

    const row = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: person.publicId },
      select: { status: true, attended: true },
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.attended).toBe(true);
  });

  /**
   * The delay is what gives a host time to report a no-show. Without it the sweep
   * would settle everybody as attended before anybody could say otherwise, and
   * `COMPLETED` is terminal.
   */
  it('waits out the settlement delay before deciding anything', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);

    // An hour after the end: retired, but not yet settled.
    clock.set(new Date(ENDS_AT.getTime() + 3_600_000));
    await sweep();

    const row = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: person.publicId },
      select: { status: true },
    });
    expect(row.status).toBe('ACCEPTED');
  });

  it('credits trust for turning up (plan §11: +2)', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);
    const before = await trust.scoreOf(person.userId);

    clock.set(AFTER_SETTLEMENT);
    await sweep();

    await expect(trust.scoreOf(person.userId)).resolves.toBe(before + 2);
  });

  /**
   * The daily cap (+2/day), which is what stops two people running six events a
   * day to trade reputation with each other — the same reasoning that puts the
   * referral reward behind an attended event (T6).
   */
  it('caps attendance trust at the daily maximum', async () => {
    const person = await createProfiledUser();
    const before = await trust.scoreOf(person);

    // Three events finishing at the same moment, so one sweep settles all three.
    // Staggering their ends would leave the last one outside the settlement
    // window and quietly turn this into a test of two attendances.
    for (let index = 0; index < 3; index += 1) {
      const eventPublicId = await publishEvent();
      const request = await participation.join(person, eventPublicId);
      await participation.accept(hostId, request.publicId);
    }

    clock.set(AFTER_SETTLEMENT);
    await sweep();

    const settled = await prisma.eventParticipant.count({
      where: { userId: person, status: 'COMPLETED' },
    });
    expect(settled).toBe(3);
    // Three attendances, one day, +2 in total rather than +6.
    await expect(trust.scoreOf(person)).resolves.toBe(before + 2);
  });

  it('is safe to run twice, and credits trust once', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);
    const before = await trust.scoreOf(person.userId);

    clock.set(AFTER_SETTLEMENT);
    await sweep();
    await sweep();

    await expect(trust.scoreOf(person.userId)).resolves.toBe(before + 2);
    await expect(
      prisma.trustScoreLedger.count({ where: { userId: person.userId, type: 'ATTENDANCE' } }),
    ).resolves.toBe(1);
  });

  /**
   * M9's open gap, closed.
   *
   * The referral payout has always required an attended event and nothing wrote
   * one, so the programme paid out only in tests. This is the path that makes it
   * real.
   */
  it('qualifies a referral, which nothing in the product could do before', async () => {
    const referrer = await createProfiledUser();
    const code = (await referrals.summaryFor(referrer)).code;

    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);
    const claim = await referrals.claim(person.userId, code);
    expect(claim.status).toBe('PENDING');

    clock.set(AFTER_SETTLEMENT);
    await sweep();

    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredUserId: person.userId },
      select: { status: true },
    });
    expect(referral.status).toBe('QUALIFIED');

    /**
     * And both of them are told (v0.7.0).
     *
     * The condition — the referred user attended something — is the whole product
     * decision behind referrals, and until now nothing announced that it had been
     * met: both sides were promised coins and then found out by checking a
     * balance. One outbox row, two recipients; the fan-out makes the split.
     */
    const announced = await prisma.outboxEvent.findFirst({
      where: { eventType: 'referral.qualified' },
      select: { payload: true },
    });
    expect(announced).not.toBeNull();
    const payload = announced?.payload as Record<string, unknown>;
    expect(payload['referrerCoins']).toBe(30);
    expect(payload['referredCoins']).toBe(10);
    // Public ids only: an outbox payload becomes a message body (invariant 7).
    expect(JSON.stringify(payload)).not.toContain(referrer);
    expect(JSON.stringify(payload)).not.toContain(person.userId);

    // The referrer never joined anything, so their endowment is untouched.
    await expect(coins.balanceOf(referrer)).resolves.toBe(JOIN_BUDGET + 30);
    await expect(coins.balanceOf(person.userId)).resolves.toBe(JOIN_BUDGET - JOIN_COST + 10);
  });
});

/**
 * The no-show (plan §11: −60 coins, −15 trust).
 *
 * §11 prices it and §7 draws the transition, but the plan never says who decides
 * one — and the platform is not at the café. A host report is the only signal
 * available, so this is a host action, which is an addition to §6's endpoint
 * list and recorded as a deviation.
 */
describe('reporting a no-show', () => {
  async function finishedEventWithAttendee(): Promise<{ userId: string; publicId: string }> {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);
    await coins.apply({
      userId: person.userId,
      amount: 500,
      type: 'ADMIN_ADJUSTMENT',
      reasonCode: 'test.funding',
      idempotencyKey: `fund:${person.userId}`,
      actorType: 'ADMIN',
    });
    clock.set(new Date(ENDS_AT.getTime() + 3_600_000));
    return person;
  }

  it('charges the no-show price and records why', async () => {
    const person = await finishedEventWithAttendee();
    const before = await trust.scoreOf(person.userId);

    await lifecycle.markNoShow(hostId, person.publicId);

    const row = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: person.publicId },
      select: { status: true, attended: true, cancellationBucket: true, penaltyLedgerId: true },
    });
    expect(row.status).toBe('NO_SHOW');
    expect(row.attended).toBe(false);
    expect(row.cancellationBucket).toBe('NO_SHOW');
    expect(row.penaltyLedgerId).not.toBeNull();

    await expect(coins.balanceOf(person.userId)).resolves.toBe(JOIN_BUDGET - JOIN_COST + 500 - 60);
    await expect(trust.scoreOf(person.userId)).resolves.toBe(before - 15);
  });

  it('cannot be claimed before the event has finished', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);

    clock.set(new Date(STARTS_AT.getTime() + 60_000));
    await expect(lifecycle.markNoShow(hostId, person.publicId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('cannot be claimed by anybody but the host', async () => {
    const person = await finishedEventWithAttendee();
    const stranger = await createProfiledUser();

    await expect(lifecycle.markNoShow(stranger, person.publicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('cannot be claimed twice', async () => {
    const person = await finishedEventWithAttendee();
    await lifecycle.markNoShow(hostId, person.publicId);

    await expect(lifecycle.markNoShow(hostId, person.publicId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  /** A reported no-show is not then settled as an attendance by the sweep. */
  it('keeps the settlement sweep from crediting them for turning up', async () => {
    const person = await finishedEventWithAttendee();
    const before = await trust.scoreOf(person.userId);
    await lifecycle.markNoShow(hostId, person.publicId);

    clock.set(AFTER_SETTLEMENT);
    await sweep();

    const row = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: person.publicId },
      select: { status: true },
    });
    expect(row.status).toBe('NO_SHOW');
    await expect(trust.scoreOf(person.userId)).resolves.toBe(before - 15);
  });
});

async function statusOf(publicId: string): Promise<string> {
  const row = await prisma.event.findUniqueOrThrow({
    where: { publicId },
    select: { status: true },
  });
  return row.status;
}
