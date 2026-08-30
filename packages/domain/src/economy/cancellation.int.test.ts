import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { CancellationBucket, PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
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
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { CoinService } from './coin.service';
import { PenaltyService } from './penalty.service';
import { TrustService } from './trust.service';

/**
 * Cancellation penalties against a real database (M10).
 *
 * The plan asks for "a parameterised table across every threshold — inside grace,
 * 25 h, 23 h, 3 h 01 m, 2 h 59 m, no-show — each asserting exact coin + trust
 * deltas". `penalty.test.ts` proves the bucket boundaries without a database;
 * this proves the money, which is the half only Postgres can answer: the ledger
 * rows, the balance that must never go negative, and the fact that the charge and
 * the cancellation commit together or not at all.
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

/** Far enough out that a fresh request is never refused for being too close. */
const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');

let fixture: CatalogFixture;
let hostId: string;

async function createProfiledUser(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
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
      endsAt: new Date(STARTS_AT.getTime() + 3 * 3_600_000),
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

/** Coins in hand, granted the only way anything may: through the ledger. */
async function fund(userId: string, amount: number): Promise<void> {
  // A zero movement is rejected as a bug, correctly — an account with no coins is
  // one that has simply never had any.
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

/**
 * A user accepted onto an event, with coins, ready to cancel.
 *
 * Goes through the real join and accept rather than seeding rows, so the grace
 * window, the seat accounting and the chat are all in the states the product
 * actually produces.
 */
async function acceptedParticipant(balance = 500): Promise<{
  userId: string;
  participantPublicId: string;
  eventPublicId: string;
}> {
  const eventPublicId = await publishEvent();
  const userId = await createProfiledUser();
  await fund(userId, balance);

  const request = await participation.join(userId, eventPublicId);
  await participation.accept(hostId, request.publicId);

  return { userId, participantPublicId: request.publicId, eventPublicId };
}

/** `hours` before the event starts. */
function at(hours: number): Date {
  return new Date(STARTS_AT.getTime() - hours * 3_600_000);
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

/**
 * The plan's table, with the exact numbers from §11 attached.
 *
 * The grace row is the one worth reading twice: it is *inside* the 15-minute
 * window and less than three hours before the event, so it would be the most
 * expensive bucket in the product if grace were checked after the clock
 * thresholds rather than before them.
 */
const TABLE: Array<{
  label: string;
  when: Date;
  bucket: CancellationBucket;
  coins: number;
  trust: number;
}> = [
  { label: 'inside the grace window', when: NOW, bucket: 'GRACE', coins: 0, trust: 0 },
  { label: '25 hours before', when: at(25), bucket: 'GT_24H', coins: 0, trust: 0 },
  { label: '23 hours before', when: at(23), bucket: 'H24_TO_H3', coins: 15, trust: 3 },
  {
    label: '3 hours 1 minute before',
    when: at(3 + 1 / 60),
    bucket: 'H24_TO_H3',
    coins: 15,
    trust: 3,
  },
  {
    label: '2 hours 59 minutes before',
    when: at(2 + 59 / 60),
    bucket: 'LT_3H',
    coins: 40,
    trust: 8,
  },
];

describe('what a cancellation costs (plan §11)', () => {
  it.each(TABLE)('charges $coins coins and $trust trust $label', async (row) => {
    const { userId, participantPublicId } = await acceptedParticipant();
    const scoreBefore = await trust.scoreOf(userId);

    clock.set(row.when);
    const cancelled = await participation.cancel(userId, participantPublicId);

    expect(cancelled.cancellationBucket).toBe(row.bucket);
    await expect(coins.balanceOf(userId)).resolves.toBe(500 - row.coins);
    await expect(trust.scoreOf(userId)).resolves.toBe(scoreBefore - row.trust);
  });

  /**
   * Inside grace is free *however late the event is*.
   *
   * A participant accepted two hours before the event has not been given a chance
   * to think about it yet, so the grace window has to win over the clock
   * thresholds. This is the case that fails if the two checks are reordered.
   */
  it('is free inside grace even minutes before the event', async () => {
    const eventPublicId = await publishEvent();
    const userId = await createProfiledUser();
    await fund(userId, 500);

    const request = await participation.join(userId, eventPublicId);
    clock.set(at(2));
    await participation.accept(hostId, request.publicId);

    // Five minutes later: still inside the 15-minute grace, and two hours out.
    clock.set(new Date(at(2).getTime() + 5 * 60_000));
    const cancelled = await participation.cancel(userId, request.publicId);

    expect(cancelled.cancellationBucket).toBe('GRACE');
    await expect(coins.balanceOf(userId)).resolves.toBe(500);
  });

  /** Withdrawing from a queue costs nothing, and is not even priced. */
  it('does not price a waitlisted request at all', async () => {
    const eventPublicId = await publishEvent(1);
    const seated = await createProfiledUser();
    await participation.accept(hostId, (await participation.join(seated, eventPublicId)).publicId);

    const queued = await createProfiledUser();
    await fund(queued, 500);
    const request = await participation.join(queued, eventPublicId);
    expect(request.status).toBe('WAITLISTED');

    clock.set(at(1));
    const cancelled = await participation.cancel(queued, request.publicId);

    expect(cancelled.cancellationBucket).toBeNull();
    await expect(coins.balanceOf(queued)).resolves.toBe(500);
    await expect(
      prisma.coinLedger.count({ where: { type: 'CANCELLATION_PENALTY' } }),
    ).resolves.toBe(0);
  });

  /** A PENDING request holds a seat but was never accepted, so nothing is owed. */
  it('does not price a request the host never answered', async () => {
    const eventPublicId = await publishEvent();
    const userId = await createProfiledUser();
    await fund(userId, 500);
    const request = await participation.join(userId, eventPublicId);

    clock.set(at(1));
    const cancelled = await participation.cancel(userId, request.publicId);

    expect(cancelled.cancellationBucket).toBeNull();
    await expect(coins.balanceOf(userId)).resolves.toBe(500);
  });
});

describe('the penalty and the cancellation are one write', () => {
  it('links the ledger row to the participation that caused it', async () => {
    const { userId, participantPublicId } = await acceptedParticipant();

    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    const row = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: participantPublicId },
      select: { id: true, penaltyLedgerId: true, cancellationBucket: true },
    });
    expect(row.penaltyLedgerId).not.toBeNull();

    const entry = await prisma.coinLedger.findUniqueOrThrow({
      where: { id: row.penaltyLedgerId ?? '' },
    });
    expect(entry.amount).toBe(-40);
    expect(entry.type).toBe('CANCELLATION_PENALTY');
    expect(entry.refType).toBe('event_participant');
    expect(entry.refId).toBe(row.id);
  });

  it('records the trust movement with a reason somebody can read', async () => {
    const { userId, participantPublicId } = await acceptedParticipant();

    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    const entries = await trust.historyOf(userId);
    expect(entries[0]).toMatchObject({
      delta: -8,
      type: 'CANCELLATION',
      reasonCode: 'cancellation.participant_penalty',
    });
  });

  /**
   * A penalty takes what is there rather than refusing.
   *
   * Refusing would let somebody dodge a late-cancellation charge by spending down
   * to nothing first, and a negative balance is forbidden by the CHECK. So the
   * charge is capped and the shortfall is recorded — visible rather than
   * forgiven in silence.
   */
  it('takes what the account has when the policy asks for more', async () => {
    const { userId, participantPublicId } = await acceptedParticipant(10);

    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    await expect(coins.balanceOf(userId)).resolves.toBe(0);
    const entry = await prisma.coinLedger.findFirstOrThrow({
      where: { userId, type: 'CANCELLATION_PENALTY' },
    });
    expect(entry.amount).toBe(-10);
    expect(entry.metadata).toMatchObject({ requestedAmount: 40 });
  });

  it('writes no ledger row at all when there is nothing to take', async () => {
    const { userId, participantPublicId } = await acceptedParticipant(0);

    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    await expect(coins.balanceOf(userId)).resolves.toBe(0);
    await expect(
      prisma.coinLedger.count({ where: { userId, type: 'CANCELLATION_PENALTY' } }),
    ).resolves.toBe(0);
    // The reputation half is not capped by a balance, so it still lands.
    await expect(trust.scoreOf(userId)).resolves.toBe(42);
  });

  /**
   * Rollback without a deploy, which is the plan's stated escape hatch for this
   * whole milestone: set the numbers to zero in `app_setting` and cancellation
   * stops costing anything.
   */
  it('stops charging when the settings are zeroed', async () => {
    await prisma.appSetting.createMany({
      data: [
        { key: 'cancellation.coins_lt_3h', value: 0 },
        { key: 'cancellation.trust_lt_3h', value: 0 },
      ],
    });

    const { userId, participantPublicId } = await acceptedParticipant();
    const scoreBefore = await trust.scoreOf(userId);

    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    await expect(coins.balanceOf(userId)).resolves.toBe(500);
    await expect(trust.scoreOf(userId)).resolves.toBe(scoreBefore);
  });

  /** The price is read at the moment of charging, not baked in at acceptance. */
  it('charges the price in force when the cancellation happens', async () => {
    const { userId, participantPublicId } = await acceptedParticipant();
    await prisma.appSetting.create({ data: { key: 'cancellation.coins_lt_3h', value: 25 } });

    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    await expect(coins.balanceOf(userId)).resolves.toBe(475);
  });
});

describe('the dry run (§6)', () => {
  it('quotes what cancelling would cost, and takes nothing', async () => {
    const { userId, participantPublicId } = await acceptedParticipant();

    clock.set(at(1));
    const preview = await participation.previewCancellation(userId, participantPublicId);

    expect(preview).toEqual({ bucket: 'LT_3H', price: { coins: 40, trust: 8 } });
    await expect(coins.balanceOf(userId)).resolves.toBe(500);
    await expect(prisma.coinLedger.count({ where: { userId, amount: { lt: 0 } } })).resolves.toBe(
      0,
    );
  });

  it('agrees with what the cancellation then charges, at every threshold', async () => {
    for (const row of TABLE) {
      // Back to the start before each acceptance, or the grace window is measured
      // from the previous row's clock and the last case silently becomes GRACE —
      // which is a bug in the loop, not in the policy, and it found it.
      clock.set(NOW);
      const { userId, participantPublicId } = await acceptedParticipant();
      clock.set(row.when);

      const preview = await participation.previewCancellation(userId, participantPublicId);
      const balanceBefore = await coins.balanceOf(userId);
      await participation.cancel(userId, participantPublicId);
      const balanceAfter = await coins.balanceOf(userId);

      expect(preview.bucket, row.label).toBe(row.bucket);
      expect(balanceBefore - balanceAfter, row.label).toBe(preview.price.coins);
    }
  });

  it('tells a stranger the participation does not exist', async () => {
    const { participantPublicId } = await acceptedParticipant();
    const stranger = await createProfiledUser();

    await expect(
      participation.previewCancellation(stranger, participantPublicId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to quote a price for something already cancelled', async () => {
    const { userId, participantPublicId } = await acceptedParticipant();
    clock.set(at(1));
    await participation.cancel(userId, participantPublicId);

    await expect(
      participation.previewCancellation(userId, participantPublicId),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});

/**
 * Invariant 9, stated as a test.
 *
 * There is no parameter anywhere on this path that a client could use to say when
 * it thinks the cancellation happened — the only clock is the injected one, which
 * in production reads the server's. The test that proves it is a compile-time
 * fact expressed at runtime: the same call at two different server times produces
 * two different prices, and nothing the caller passes can change either.
 */
describe('the server clock is the only clock (invariant 9)', () => {
  it('prices from server time, and the caller has no way to say otherwise', async () => {
    const early = await acceptedParticipant();
    clock.set(at(25));
    await participation.cancel(early.userId, early.participantPublicId);
    await expect(coins.balanceOf(early.userId)).resolves.toBe(500);

    const late = await acceptedParticipant();
    clock.set(at(1));
    await participation.cancel(late.userId, late.participantPublicId);
    await expect(coins.balanceOf(late.userId)).resolves.toBe(460);
  });
});
