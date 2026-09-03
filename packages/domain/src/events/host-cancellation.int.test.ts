import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { CatalogService } from '../catalog/catalog.service';
import { ChannelService } from '../channel/channel.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { EventService } from './event.service';

/**
 * Host cancellation and the event lifecycle (M10, ADR-0011 D9).
 *
 * The property this file exists for is **atomicity across five things**: the
 * event retires, everyone holding a seat is cancelled, every chat closes, the
 * host pays, and one outbox row goes out naming everybody. A partial commit here
 * is the specific failure M8 asked M10 not to ship — two strangers left messaging
 * each other about a meeting that is not happening.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
/**
 * `CatalogService` reads `TELEGRAM_BOT_USERNAME` for the deep link the Mini App
 * builds (report 6). Never the token — there is no code path here that reads one.
 */
const catalogEnv = { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as unknown as Env;

const catalog = new CatalogService(service, settings, catalogEnv);
const blacklist = new BlacklistService(service);
const moderation = new ModerationService(service, blacklist);
const channel = new ChannelService(service, clock, settings);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
/**
 * Enough coins to ask to join, several times over.
 *
 * `economy.event_join_coins` is 5 from v0.7.0 and `join` charges it inside the
 * same transaction, so a joiner with an empty account is refused with
 * `INSUFFICIENT_COINS` before reaching any of the behaviour this suite is about.
 * **Exactly one join's worth**, so a participant's balance is back to zero the
 * moment they have joined — which is the baseline every `fund(…, 100)` below
 * counts from, and keeps those assertions about the refund rather than about the
 * endowment.
 */
const JOIN_BUDGET = 5;

/**
 * What the host holds before they cancel anything.
 *
 * `fund(hostId, 500)` on top of the endowment every profiled user now gets, so
 * the number the penalty is subtracted from is written down once rather than
 * assumed at seven call sites.
 */
const HOST_BALANCE = 500 + JOIN_BUDGET;

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

const events = new EventService(
  service,
  clock,
  env,
  catalog,
  settings,
  moderation,
  channel,
  membership,
  coins,
  penalties,
  outbox,
  audit,
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

const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');
const ENDS_AT = new Date(STARTS_AT.getTime() + 3 * 3_600_000);

let fixture: CatalogFixture;
let hostId: string;

async function createProfiledUser(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: JOIN_BUDGET });
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

async function publishEvent(capacity = 5): Promise<string> {
  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title: 'شب بازی رومیزی',
      description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      titleNormalized: 'شب بازی رومیزی',
      descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
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

async function fund(userId: string, amount: number): Promise<void> {
  if (amount === 0) return;
  await coins.apply({
    userId,
    amount,
    type: 'ADMIN_ADJUSTMENT',
    reasonCode: 'test.funding',
    idempotencyKey: `fund:${userId}`,
    actorType: 'ADMIN',
  });
}

/** Somebody accepted onto the event, returning their ids. */
async function accepted(eventPublicId: string): Promise<{ userId: string; publicId: string }> {
  const userId = await createProfiledUser();
  const request = await participation.join(userId, eventPublicId);
  await participation.accept(hostId, request.publicId);
  return { userId, publicId: request.publicId };
}

function at(hours: number): Date {
  return new Date(STARTS_AT.getTime() - hours * 3_600_000);
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await createProfiledUser();
  await fund(hostId, 500);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('what a host cancellation does (ADR-0011, D9)', () => {
  it('retires the event, empties the seats and cancels everyone who held one', async () => {
    const eventPublicId = await publishEvent();
    const first = await accepted(eventPublicId);
    const second = await accepted(eventPublicId);

    clock.set(at(1));
    const result = await events.cancelByHost(hostId, eventPublicId, 'جای رزرو نشد');

    expect(result.cancelled).toBe(2);
    expect(result.hadSeats).toBe(2);
    expect(result.event.status).toBe('CANCELLED_BY_HOST');
    expect(result.event.acceptedCount).toBe(0);

    for (const person of [first, second]) {
      const row = await prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: person.publicId },
        select: { status: true, cancelledAt: true },
      });
      expect(row.status).toBe('CANCELLED_BY_HOST');
      expect(row.cancelledAt).not.toBeNull();
    }
  });

  /**
   * The note M8 left for M10, discharged.
   *
   * A chat left open after its event was cancelled is two strangers arranging a
   * meeting that will not happen — and neither of them has any way to find out
   * from the conversation that it is off.
   */
  it('closes every conversation the event opened', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);
    await accepted(eventPublicId);

    clock.set(at(1));
    await events.cancelByHost(hostId, eventPublicId);

    const chats = await prisma.anonymousChat.findMany({ select: { status: true } });
    expect(chats).toHaveLength(2);
    expect(chats.every((row) => row.status === 'CLOSED')).toBe(true);
  });

  /**
   * A pending or waitlisted request EXPIRES rather than being cancelled.
   *
   * The participation state machine has said so since M6: somebody still waiting
   * was never given a seat, so there is nothing to take away — and
   * `WAITLISTED → CANCELLED_BY_HOST` is not a legal edge.
   */
  it('expires the requests that never got a seat', async () => {
    const eventPublicId = await publishEvent(1);
    await accepted(eventPublicId);

    const pendingUser = await createProfiledUser();
    const queued = await participation.join(pendingUser, eventPublicId);
    expect(queued.status).toBe('WAITLISTED');

    clock.set(at(1));
    const result = await events.cancelByHost(hostId, eventPublicId);

    expect(result.cancelled).toBe(2);
    expect(result.hadSeats).toBe(1);

    const row = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: queued.publicId },
      select: { status: true, cancelledAt: true },
    });
    expect(row.status).toBe('EXPIRED');
    expect(row.cancelledAt).toBeNull();
  });

  /** One row naming everyone, so a crash cannot tell some of them and lose the rest. */
  it('emits one domain event naming every affected person by public id', async () => {
    const eventPublicId = await publishEvent();
    const first = await accepted(eventPublicId);

    clock.set(at(1));
    await events.cancelByHost(hostId, eventPublicId);

    const emitted = await prisma.outboxEvent.findMany({
      where: { eventType: 'event.cancelled_by_host' },
    });
    expect(emitted).toHaveLength(1);

    const payload = JSON.stringify(emitted[0]?.payload);
    expect(payload).toContain(first.publicId);
    // Internal ids never reach a payload that becomes a Telegram message.
    expect(payload).not.toContain(hostId);
    expect(payload).not.toContain(first.userId);
  });
});

/**
 * The host's price (§11: participant penalties ×1.5, trust −5 / −12).
 *
 * The multiplier is the interesting half, because it reads the *participant*
 * table for the same lateness — so a change to what a participant pays moves what
 * a host pays, which is what "symmetrical thresholds" in ADR-0011 means.
 */
describe('what it costs the host', () => {
  const CASES = [
    // 5 × 1.5 = 7.5, rounded. GT_24H stopped being free in v0.7.0, and the host
    // price is the participant price for the same lateness times the multiplier —
    // which is what "symmetrical thresholds" buys: pricing one moved the other.
    { label: 'more than a day out', when: at(25), coins: 8, trust: 5 },
    // 15 × 1.5 = 22.5, rounded rather than floored.
    { label: 'inside 24 hours', when: at(23), coins: 23, trust: 12 },
    // 40 × 1.5 = 60.
    { label: 'inside 3 hours', when: at(1), coins: 60, trust: 12 },
  ];

  it.each(CASES)('charges $coins coins and $trust trust $label', async (row) => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);
    const scoreBefore = await trust.scoreOf(hostId);

    clock.set(row.when);
    const result = await events.cancelByHost(hostId, eventPublicId);

    expect(result.coinsCharged).toBe(row.coins);
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_BALANCE - row.coins);
    await expect(trust.scoreOf(hostId)).resolves.toBe(scoreBefore - row.trust);
  });

  /**
   * Calling off something nobody joined is free.
   *
   * ADR-0011 prices "a host cancelling a published event **with accepted
   * participants**". Charging for an empty event would teach hosts to leave dead
   * listings standing, which is worse for everyone reading discovery than the
   * cancellation is.
   */
  it('charges nothing when nobody had a seat', async () => {
    const eventPublicId = await publishEvent();
    const scoreBefore = await trust.scoreOf(hostId);

    clock.set(at(1));
    const result = await events.cancelByHost(hostId, eventPublicId);

    expect(result.cancelled).toBe(0);
    expect(result.coinsCharged).toBe(0);
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_BALANCE);
    await expect(trust.scoreOf(hostId)).resolves.toBe(scoreBefore);
  });

  it('takes what the host has when the penalty is more than the balance', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);
    await prisma.coinAccount.update({ where: { userId: hostId }, data: { balance: 10 } });
    await prisma.coinLedger.deleteMany({ where: { userId: hostId } }).catch(() => undefined);

    clock.set(at(1));
    const result = await events.cancelByHost(hostId, eventPublicId);

    expect(result.coinsRequested).toBe(60);
    expect(result.coinsCharged).toBe(10);
    await expect(coins.balanceOf(hostId)).resolves.toBe(0);
  });

  it('stops charging when the multiplier is zeroed, with no deploy', async () => {
    await prisma.appSetting.createMany({
      data: [
        { key: 'cancellation.host_penalty_multiplier', value: 0 },
        { key: 'cancellation.host_trust_lt24h', value: 0 },
      ],
    });

    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);
    const scoreBefore = await trust.scoreOf(hostId);

    clock.set(at(1));
    await events.cancelByHost(hostId, eventPublicId);

    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_BALANCE);
    await expect(trust.scoreOf(hostId)).resolves.toBe(scoreBefore);
  });
});

/**
 * D9a, stated rather than hidden.
 *
 * "100% automatic coin refund to all accepted participants" currently refunds
 * nothing, because **joining costs a participant nothing**. The mechanism is
 * generic and is tested here with a synthetic participant-side charge, so it is
 * known to work rather than assumed to — and it becomes live the moment any
 * participant-side cost is introduced.
 */
describe('the refund (D9a)', () => {
  /**
   * D9a went live in v0.7.0.
   *
   * This used to assert that the refund reversed an *empty set*, because joining
   * cost nothing — the mechanism was written generically and tested with a
   * synthetic charge so it would be known to work on the day a participant-side
   * cost appeared. `economy.event_join_coins` is that day: the guest paid five to
   * ask, the host called the activity off, and the five comes back.
   */
  it('gives back what taking part actually cost', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);
    await fund(person.userId, 100);

    clock.set(at(1));
    const result = await events.cancelByHost(hostId, eventPublicId);

    expect(result.coinsRefunded).toBe(5);
    await expect(coins.balanceOf(person.userId)).resolves.toBe(105);
  });

  it('gives back a synthetic participant-side charge in full', async () => {
    const eventPublicId = await publishEvent();
    const person = await accepted(eventPublicId);
    await fund(person.userId, 100);

    const participantId = (
      await prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: person.publicId },
        select: { id: true },
      })
    ).id;

    // A second, differently-typed participant-side charge on top of the join
    // fee. The refund is written generically — reverse every ledger row whose
    // subject is this participation — and this is what proves it is generic
    // rather than a hard-coded reversal of the one charge that exists today.
    await coins.apply({
      userId: person.userId,
      amount: -25,
      type: 'ADMIN_ADJUSTMENT',
      reasonCode: 'test.participation_fee',
      idempotencyKey: `fee:${participantId}`,
      actorType: 'SYSTEM',
      refType: 'event_participant',
      refId: participantId,
    });
    await expect(coins.balanceOf(person.userId)).resolves.toBe(75);

    clock.set(at(1));
    const result = await events.cancelByHost(hostId, eventPublicId);

    // Both of them: the synthetic 25 and the 5 the join actually cost.
    expect(result.coinsRefunded).toBe(30);
    await expect(coins.balanceOf(person.userId)).resolves.toBe(105);

    const reversals = await prisma.coinLedger.findMany({
      where: { userId: person.userId, type: 'REVERSAL' },
      select: { amount: true, reasonCode: true },
    });
    expect(reversals.map((row) => row.amount).sort((a, b) => a - b)).toEqual([5, 25]);
    for (const reversal of reversals) {
      expect(reversal.reasonCode).toBe('cancellation.host_refund');
    }
  });

  /**
   * A fine somebody earned by cancelling first is not handed back.
   *
   * Without the type filter, a host cancelling afterwards would refund the
   * participant's own late-cancellation penalty — turning "the host let you down"
   * into "and here are your coins back for letting *them* down".
   */
  it('does not reverse a penalty the participant earned themselves', async () => {
    const eventPublicId = await publishEvent();
    const stayer = await accepted(eventPublicId);
    const leaver = await accepted(eventPublicId);
    await fund(leaver.userId, 100);

    clock.set(at(1));
    await participation.cancel(leaver.userId, leaver.publicId);
    await expect(coins.balanceOf(leaver.userId)).resolves.toBe(60);

    const result = await events.cancelByHost(hostId, eventPublicId);

    // Only the one who still had a seat is in the count — and only their join
    // fee comes back. The leaver's is not refunded either: they gave up the seat
    // themselves, before the host called anything off.
    expect(result.hadSeats).toBe(1);
    expect(result.coinsRefunded).toBe(5);
    await expect(coins.balanceOf(leaver.userId)).resolves.toBe(60);
    expect(stayer.userId).toBeTruthy();
  });
});

describe('what a host cancellation refuses', () => {
  it('tells a stranger the event does not exist', async () => {
    const eventPublicId = await publishEvent();
    const stranger = await createProfiledUser();

    await expect(events.cancelByHost(stranger, eventPublicId)).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
  });

  it('refuses an event that has already started', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(new Date(STARTS_AT.getTime() + 60_000));
    await expect(events.cancelByHost(hostId, eventPublicId)).rejects.toMatchObject({
      code: 'EVENT_ALREADY_STARTED',
    });
  });

  it('refuses to cancel the same event twice', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(at(1));
    await events.cancelByHost(hostId, eventPublicId);

    await expect(events.cancelByHost(hostId, eventPublicId)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('the host dry run', () => {
  it('quotes the price and the headcount without changing anything', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(at(1));
    const preview = await events.previewHostCancellation(hostId, eventPublicId);

    expect(preview).toEqual({ bucket: 'LT_3H', affected: 1, price: { coins: 60, trust: 12 } });
    await expect(coins.balanceOf(hostId)).resolves.toBe(HOST_BALANCE);

    const row = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(row.status).toBe('PUBLISHED');
  });

  it('agrees with what the cancellation then charges', async () => {
    const eventPublicId = await publishEvent();
    await accepted(eventPublicId);

    clock.set(at(23));
    const preview = await events.previewHostCancellation(hostId, eventPublicId);
    const result = await events.cancelByHost(hostId, eventPublicId);

    expect(result.coinsCharged).toBe(preview.price.coins);
    expect(result.bucket).toBe(preview.bucket);
  });
});
