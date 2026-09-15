import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry } from '@payetam/platform';
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
import { SETTING_DEFAULTS, SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { ReferralService } from '../economy/referral.service';
import { TrustService } from '../economy/trust.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { ReviewService } from '../reviews/review.service';
import { eventCreateSpendKey } from './event.service';
import { hostDepositRefundKey, hostRewardKey, HostRewardService } from './host-reward.service';
import { EventLifecycleService } from './lifecycle.service';

/**
 * The other half of the host deposit (docs/coin-economy-plan.md §3, §4).
 *
 * ── What is actually being asserted ─────────────────────────────────────────
 *
 * Not "coins arrive". The three properties that make this a deposit rather than
 * a giveaway, each of which is a way the feature could quietly become a mint:
 *
 *  1. **It never returns more than was charged.** The refund is floored at what
 *     that host actually paid for that event, read back from the ledger, so a
 *     setting raised past the registration price cannot print coins.
 *  2. **It requires the reviews.** A hosting bonus with no quality gate pays for
 *     holding an event, and two friends can hold one in a kitchen.
 *  3. **It is exactly once.** Both halves are keyed on the event, so the hourly
 *     sweep re-running over the same few days of history is a no-op.
 *
 * Nothing here is mocked: the ledger's UNIQUE key and the balance CHECK are the
 * guarantees under test, and both are the database's.
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
const hostRewards = new HostRewardService(service, clock, settings, coins, audit, outbox);

const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');
const ENDS_AT = new Date(STARTS_AT.getTime() + 3 * 3_600_000);
/** Past the end and past the settlement delay, so both sweeps will act. */
const AFTER_SETTLEMENT = new Date(ENDS_AT.getTime() + 25 * 3_600_000);

const JOIN_COST = SETTING_DEFAULTS['economy.event_join_coins'];
const JOIN_BUDGET = 20 * JOIN_COST;
const REFUND: number = SETTING_DEFAULTS['economy.host_deposit_refund_coins'];
const PER_ATTENDEE = SETTING_DEFAULTS['economy.host_reward_per_attendee_coins'];

let fixture: CatalogFixture;
let hostId: string;

async function createProfiledUser(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: JOIN_BUDGET });
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

/**
 * An activity the host **paid to register**.
 *
 * The charge is written here rather than by going through `EventService.create`,
 * because what this suite needs is the ledger row the refund reads back — and
 * building it directly keeps the suite about the settlement instead of about the
 * create path, which has its own file.
 */
async function publishPaidEvent(charged = REFUND): Promise<{ id: string; publicId: string }> {
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
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { id: true, publicId: true },
  });

  if (charged > 0) {
    await coins.apply({
      userId: hostId,
      amount: -charged,
      type: 'EVENT_CREATE_SPEND',
      reasonCode: 'event.create',
      idempotencyKey: eventCreateSpendKey(event.id),
      actorType: 'USER',
      actorId: hostId,
      refType: 'event',
      refId: event.id,
    });
  }

  return event;
}

/**
 * Puts `count` guests through join → accept → attendance settlement.
 *
 * The first `noShows` of them are reported absent by the host after the end and
 * before settlement — the order a real host acts in.
 */
async function heldWith(
  count: number,
  charged = REFUND,
  noShows = 0,
): Promise<{ id: string; guests: string[] }> {
  const event = await publishPaidEvent(charged);
  const guests: string[] = [];
  const seats: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const userId = await createProfiledUser();
    const request = await participation.join(userId, event.publicId);
    await participation.accept(hostId, request.publicId);
    guests.push(userId);
    seats.push(request.publicId);
  }

  clock.set(AFTER_SETTLEMENT);
  await lifecycle.retireStarted();
  for (const seat of seats.slice(0, noShows)) {
    await lifecycle.markNoShow(hostId, seat);
  }
  await lifecycle.settleAttendance();

  return { id: event.id, guests };
}

/** The host writes their review of every guest — the condition on the reward. */
async function hostReviewsEveryone(eventId: string): Promise<void> {
  const pairs = await prisma.reviewPair.findMany({
    where: { eventId },
    select: { participant: { select: { publicId: true } } },
  });
  for (const pair of pairs) {
    await reviews.submit(hostId, pair.participant.publicId, { rating: 5 });
  }
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

describe('the hosting settlement', () => {
  it('returns the deposit and pays per attendee once the host has reviewed', async () => {
    const { id } = await heldWith(3);
    await hostReviewsEveryone(id);
    const before = await coins.balanceOf(hostId);

    const result = await hostRewards.settle();

    expect(result.events).toBe(1);
    expect(result.coins).toBe(REFUND + 3 * PER_ATTENDEE);
    await expect(coins.balanceOf(hostId)).resolves.toBe(before + REFUND + 3 * PER_ATTENDEE);
  });

  /**
   * The quality gate, and the reason the sweep is a sweep.
   *
   * A host who has not written their reviews is not refused forever — the next
   * pass asks again, and the seven-day review window is how long they have. This
   * is the property that makes an hourly job the right shape.
   */
  it('pays nothing until the host has reviewed every attendee', async () => {
    const { id } = await heldWith(3);
    const pairs = await prisma.reviewPair.findMany({
      where: { eventId: id },
      select: { participant: { select: { publicId: true } } },
    });

    // Two of the three.
    await reviews.submit(hostId, pairs[0]!.participant.publicId, { rating: 5 });
    await reviews.submit(hostId, pairs[1]!.participant.publicId, { rating: 5 });

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0, coins: 0 });

    // And then the third, on a later pass.
    await reviews.submit(hostId, pairs[2]!.participant.publicId, { rating: 5 });
    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 1 });
  });

  /**
   * Changed on purpose by plan 10: this used to expect **nothing** at all.
   *
   * One attendee is still a coffee with a friend, so the per-guest bonus — which
   * is earning, and which two people could trade back and forth — stays behind
   * its threshold. The deposit is not earning; it is what the host paid, and the
   * activity took place.
   */
  it('returns the deposit but pays no bonus when too few guests turned up', async () => {
    const { id } = await heldWith(1);
    await hostReviewsEveryone(id);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 1, coins: REFUND });
  });

  /**
   * Plan 10 — the honest host is no longer the one who loses.
   *
   * Two guests, one does not come. Reporting it used to drop the count below the
   * threshold and forfeit the deposit, while staying silent paid 29 coins and
   * required writing a review for somebody who was not there.
   */
  it('returns the deposit to a host who reported a no-show honestly', async () => {
    const { id } = await heldWith(2, REFUND, 1);
    await hostReviewsEveryone(id);
    const before = await coins.balanceOf(hostId);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 1, coins: REFUND });
    await expect(coins.balanceOf(hostId)).resolves.toBe(before + REFUND);
  });

  /** Reviews are owed for the guests who came — there is no pair for an absentee. */
  it('asks for a review of every guest who came, and none of the one who did not', async () => {
    const { id } = await heldWith(2, REFUND, 1);
    const pairs = await prisma.reviewPair.count({ where: { eventId: id } });
    expect(pairs).toBe(1);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0 });
    await hostReviewsEveryone(id);
    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 1 });
  });

  /** The only guest did not come: the deposit comes back, with nothing to review. */
  it('returns the deposit when the only guest was absent', async () => {
    await heldWith(1, REFUND, 1);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 1, coins: REFUND });
  });

  /**
   * The same evening, with the guest saying the host never came (plan 08).
   *
   * A host who did not come and marked the only guest absent is exactly the
   * case above — so the deposit is held while «میزبان نیامد» is open, refused
   * once it is upheld, and paid only if the report is not.
   */
  it('holds the deposit while a report that the host did not come is open', async () => {
    const { id, guests } = await heldWith(1, REFUND, 1);
    const seat = await prisma.eventParticipant.findFirstOrThrow({
      where: { eventId: id },
      select: { id: true },
    });
    const opened = await prisma.moderationCase.create({
      data: { subjectType: 'EVENT', subjectId: id, trigger: 'DISPUTE' },
      select: { id: true },
    });
    await prisma.noShowClaim.create({
      data: {
        eventId: id,
        kind: 'HOST_ABSENT_REPORT',
        participantId: seat.id,
        authorUserId: guests[0] ?? '',
        statement: 'میزبان اصلاً نیامد و کسی آنجا نبود.',
        moderationCaseId: opened.id,
      },
    });

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0 });

    await prisma.moderationCase.update({
      where: { id: opened.id },
      data: {
        status: 'REJECTED',
        decision: 'DISMISSED',
        decisionNote: 'میزبان حاضر بود',
        decidedBy: 'moderator',
        decidedAt: AFTER_SETTLEMENT,
      },
    });
    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 1, coins: REFUND });
  });

  it('never returns the deposit of a host found absent', async () => {
    const { id } = await heldWith(1, REFUND, 1);
    await prisma.event.update({ where: { id }, data: { hostAbsentAt: AFTER_SETTLEMENT } });

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0, coins: 0 });
  });

  /**
   * Nobody ever held a seat: the deposit is kept, so registering activities that
   * never happen still costs what it was meant to.
   */
  it('keeps the deposit for an activity nobody was accepted to', async () => {
    await heldWith(0);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0, coins: 0 });
  });

  /** The host is told how many came, not how many seats there were. */
  it('tells the host the number who actually came', async () => {
    const { id } = await heldWith(3, REFUND, 1);
    await hostReviewsEveryone(id);

    await hostRewards.settle();

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'host.settled' },
      select: { payload: true },
    });
    const payload = row.payload as Record<string, unknown>;
    expect(payload['attendees']).toBe(2);
    expect(payload['bonus']).toBe(2 * PER_ATTENDEE);
  });

  /**
   * **The structural guard against a mint.**
   *
   * `economy.host_deposit_refund_coins` is a setting an operator can raise above
   * what registration costs. If the refund trusted it, hosting would print coins
   * — and the first anybody would know is the nightly ledger reconciliation.
   */
  it('never returns more than the host was actually charged', async () => {
    // Charged a fraction of the configured refund.
    const charged = Math.max(1, Math.floor(REFUND / 5));
    const { id } = await heldWith(2, charged);
    await hostReviewsEveryone(id);
    const before = await coins.balanceOf(hostId);

    await hostRewards.settle();

    await expect(coins.balanceOf(hostId)).resolves.toBe(before + charged + 2 * PER_ATTENDEE);
  });

  it('pays no deposit back for an activity that was never charged', async () => {
    // Registration is free in any deployment that has not set a price. Returning
    // a deposit nobody paid would be a grant wearing a refund's name — and would
    // make the leak-rate metric read every free registration as a hole.
    const { id } = await heldWith(2, 0);
    await hostReviewsEveryone(id);
    const before = await coins.balanceOf(hostId);

    await hostRewards.settle();

    await expect(coins.balanceOf(hostId)).resolves.toBe(before + 2 * PER_ATTENDEE);
  });

  it('is exactly once, however many times the sweep runs', async () => {
    const { id } = await heldWith(3);
    await hostReviewsEveryone(id);

    await hostRewards.settle();
    const after = await coins.balanceOf(hostId);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0, coins: 0 });
    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0, coins: 0 });
    await expect(coins.balanceOf(hostId)).resolves.toBe(after);

    // One row each, keyed on the event.
    await expect(
      prisma.coinLedger.count({
        where: { idempotencyKey: { in: [hostDepositRefundKey(id), hostRewardKey(id)] } },
      }),
    ).resolves.toBe(2);
  });

  /**
   * The rolling cap, on the bonus only.
   *
   * Returning what somebody paid is not earning, so the deposit must not eat the
   * allowance — a cap that counted it would punish a host for hosting often,
   * which is the opposite of what the whole deposit mechanism is for.
   */
  it('caps the per-attendee bonus without capping the deposit', async () => {
    await prisma.appSetting.create({ data: { key: 'economy.host_reward_cap', value: 2 } });

    const { id } = await heldWith(4);
    await hostReviewsEveryone(id);
    const before = await coins.balanceOf(hostId);

    await hostRewards.settle();

    // Four attendees would have earned `4 * PER_ATTENDEE`; the cap allows 2.
    await expect(coins.balanceOf(hostId)).resolves.toBe(before + REFUND + 2);
  });

  it('tells the host, in the transaction that pays them', async () => {
    const { id } = await heldWith(3);
    await hostReviewsEveryone(id);

    await hostRewards.settle();

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: 'host.settled', aggregateId: id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ attendees: 3, refund: REFUND });
    // No internal id and no Telegram anything (invariant 7).
    expect(JSON.stringify(events[0]?.payload)).not.toContain(hostId);
  });

  it('writes an audit row for the settlement', async () => {
    const { id } = await heldWith(2);
    await hostReviewsEveryone(id);

    await hostRewards.settle();

    await expect(
      prisma.auditLog.count({ where: { action: 'host.settled', targetId: id } }),
    ).resolves.toBe(1);
  });

  it('does nothing at all when both halves are switched off', async () => {
    await prisma.appSetting.createMany({
      data: [
        { key: 'economy.host_deposit_refund_coins', value: 0 },
        { key: 'economy.host_reward_per_attendee_coins', value: 0 },
      ],
    });

    const { id } = await heldWith(3);
    await hostReviewsEveryone(id);
    const before = await coins.balanceOf(hostId);

    await expect(hostRewards.settle()).resolves.toMatchObject({ events: 0, coins: 0 });
    await expect(coins.balanceOf(hostId)).resolves.toBe(before);
  });
});
