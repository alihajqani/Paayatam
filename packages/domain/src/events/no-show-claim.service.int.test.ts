import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, MetricsRegistry } from '@payetam/platform';
import { ErrorCode } from '@payetam/shared';
import { TEMPLATES } from '@payetam/telegram';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import type { AdminSession } from '../adminaccess/admin-access.service';
import { PERMISSIONS } from '../adminaccess/permissions';
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
import { planNotifications } from '../notifications/fanout';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { ReviewService } from '../reviews/review.service';
import { hostDepositRefundKey } from './host-reward.service';
import { EventLifecycleService } from './lifecycle.service';
import { NoShowClaimService } from './no-show-claim.service';

/**
 * No-shows in both directions (plan 08).
 *
 * Every consequence here is money or reputation, so everything is asserted on
 * the ledgers and the rows the decision writes — and every message from the row
 * the real emitter wrote, through `planNotifications` (the lesson of review H1).
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-09-10T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
const moderation = new ModerationService(service, new BlacklistService(service));
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
const claims = new NoShowClaimService(
  service,
  clock,
  settings,
  penalties,
  coins,
  trust,
  audit,
  outbox,
);

const STARTS_AT = new Date('2026-09-10T15:00:00.000Z');
const ENDS_AT = new Date(STARTS_AT.getTime() + 3 * 3_600_000);
const AFTER_END = new Date(ENDS_AT.getTime() + 3_600_000);

const JOIN_COST = SETTING_DEFAULTS['economy.event_join_coins'];
const NO_SHOW_COINS = SETTING_DEFAULTS['cancellation.coins_no_show'];
const NO_SHOW_TRUST = SETTING_DEFAULTS['cancellation.trust_no_show'];
const WINDOW_DAYS = SETTING_DEFAULTS['cancellation.dispute_window_days'];
const RESPONSE_HOURS = SETTING_DEFAULTS['cancellation.response_window_hours'];
const HOST_PRICE = Math.round(
  NO_SHOW_COINS * SETTING_DEFAULTS['cancellation.host_penalty_multiplier'],
);
const BUDGET = 20 * JOIN_COST;

const SAID = 'من سر وقت آنجا بودم و میزبان را هم دیدم.';

const MODERATOR: AdminSession = {
  adminUserId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  email: 'mod@payetam.test',
  displayName: 'داور',
  roles: [],
  permissions: [PERMISSIONS.EVENT_MODERATE, PERMISSIONS.REPORT_REVIEW],
};

let fixture: CatalogFixture;
let hostId: string;

async function person(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: BUDGET });
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

async function evening(): Promise<{ id: string; publicId: string }> {
  return prisma.event.create({
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
}

async function seated(eventPublicId: string): Promise<{ userId: string; seat: string }> {
  const userId = await person();
  const request = await participation.join(userId, eventPublicId);
  await participation.accept(hostId, request.publicId);
  return { userId, seat: request.publicId };
}

/** What the relay would send for every outbox row of this type. */
async function sent(eventType: string): Promise<{ templateKey: string; to: string }[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: { eventType },
    orderBy: { createdAt: 'asc' },
    select: { id: true, eventType: true, aggregateId: true, payload: true },
  });
  return rows.flatMap((row) =>
    planNotifications({ ...row, payload: row.payload as Record<string, unknown> }).map((plan) => ({
      templateKey: plan.templateKey,
      to: plan.userPublicId,
    })),
  );
}

async function publicIdOf(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return user.publicId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await person();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('«من حاضر بودم» — a guest disputes a no-show', () => {
  async function markedAbsent(): Promise<{ userId: string; seat: string; eventId: string }> {
    const event = await evening();
    const guest = await seated(event.publicId);
    clock.set(AFTER_END);
    await lifecycle.markNoShow(hostId, guest.seat);
    return { ...guest, eventId: event.id };
  }

  it('is open for the configured days from the moment the guest was told', async () => {
    const { userId, seat } = await markedAbsent();

    const ready = await claims.disputeReadiness(userId, seat);
    expect(ready.eventTitle).toBe('شب بازی رومیزی');
    expect(ready.closesAt).toEqual(new Date(AFTER_END.getTime() + WINDOW_DAYS * 86_400_000));

    clock.set(new Date(ready.closesAt.getTime() + 60_000));
    await expect(claims.disputeReadiness(userId, seat)).rejects.toMatchObject({
      code: ErrorCode.CLAIM_WINDOW_CLOSED,
    });
  });

  it('opens one case about the participation, once', async () => {
    const { userId, seat } = await markedAbsent();

    await claims.dispute(userId, seat, SAID);

    const opened = await prisma.moderationCase.findFirstOrThrow({
      select: { subjectType: true, trigger: true, status: true, id: true },
    });
    expect(opened).toMatchObject({
      subjectType: 'PARTICIPATION',
      trigger: 'DISPUTE',
      status: 'OPEN',
    });
    await expect(claims.claimsForCase(opened.id)).resolves.toMatchObject([
      { kind: 'GUEST_ABSENT_DISPUTE', authorRole: 'GUEST', statement: SAID },
    ]);

    await expect(claims.dispute(userId, seat, SAID)).rejects.toMatchObject({
      code: ErrorCode.ALREADY_CLAIMED,
    });
  });

  it('refuses somebody else’s no-show as not found, and a sentence too short to weigh', async () => {
    const { seat, userId } = await markedAbsent();
    const stranger = await person();

    await expect(claims.dispute(stranger, seat, SAID)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    await expect(claims.dispute(userId, seat, 'بودم')).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('upheld: gives back exactly what the no-show took, and the guest attended', async () => {
    const { userId, seat } = await markedAbsent();
    const beforeTrust = await trust.scoreOf(userId);
    await claims.dispute(userId, seat, SAID);
    const opened = await prisma.moderationCase.findFirstOrThrow({ select: { id: true } });

    await claims.decide(MODERATOR, opened.id, {
      upheld: true,
      note: 'میزبان تأیید کرد اشتباه زده',
    });

    expect(await coins.balanceOf(userId)).toBe(BUDGET - JOIN_COST);
    expect(await trust.scoreOf(userId)).toBe(beforeTrust + NO_SHOW_TRUST);
    await expect(
      prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: seat },
        select: { status: true, attended: true },
      }),
    ).resolves.toEqual({ status: 'COMPLETED', attended: true });
    await expect(
      prisma.moderationCase.findUniqueOrThrow({
        where: { id: opened.id },
        select: { status: true, decision: true, decidedBy: true },
      }),
    ).resolves.toEqual({
      status: 'APPROVED',
      decision: 'UPHELD',
      decidedBy: MODERATOR.adminUserId,
    });

    const messages = await sent('no_show.claim_decided');
    expect(messages).toEqual(
      expect.arrayContaining([
        { templateKey: TEMPLATES.NO_SHOW_CLAIM_DECIDED, to: await publicIdOf(userId) },
        { templateKey: TEMPLATES.NO_SHOW_CLAIM_DECIDED, to: await publicIdOf(hostId) },
      ]),
    );
  });

  it('rejected: moves nothing, and tells only the guest', async () => {
    const { userId, seat } = await markedAbsent();
    const balance = await coins.balanceOf(userId);
    await claims.dispute(userId, seat, SAID);
    const opened = await prisma.moderationCase.findFirstOrThrow({ select: { id: true } });

    await claims.decide(MODERATOR, opened.id, {
      upheld: false,
      note: 'دو مهمان دیگر هم تأیید کردند',
    });

    expect(await coins.balanceOf(userId)).toBe(balance);
    await expect(
      prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: seat },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'NO_SHOW' });
    await expect(sent('no_show.claim_decided')).resolves.toEqual([
      { templateKey: TEMPLATES.NO_SHOW_CLAIM_DECIDED, to: await publicIdOf(userId) },
    ]);
  });

  it('cannot be decided twice, or without report.review', async () => {
    const { userId, seat } = await markedAbsent();
    await claims.dispute(userId, seat, SAID);
    const opened = await prisma.moderationCase.findFirstOrThrow({ select: { id: true } });

    await expect(
      claims.decide({ ...MODERATOR, permissions: [PERMISSIONS.EVENT_MODERATE] }, opened.id, {
        upheld: true,
        note: 'بدون مجوز',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    await claims.decide(MODERATOR, opened.id, { upheld: true, note: 'درست است' });
    await expect(
      claims.decide(MODERATOR, opened.id, { upheld: true, note: 'دوباره' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE_TRANSITION });
    // Once, however often: the reversal is keyed on the row it undoes.
    expect(await coins.balanceOf(userId)).toBe(BUDGET - JOIN_COST);
  });

  it('refuses a content case', async () => {
    const content = await prisma.moderationCase.create({
      data: { subjectType: 'USER', subjectId: hostId, trigger: 'REPORT_THRESHOLD' },
      select: { id: true },
    });
    await expect(
      claims.decide(MODERATOR, content.id, { upheld: true, note: 'اشتباهی' }),
    ).rejects.toMatchObject({ code: ErrorCode.WRONG_CASE_DECISION });
  });
});

describe('«میزبان نیامد» — guests report the host', () => {
  it('is refused before the evening has ended, and after the window', async () => {
    const event = await evening();
    const guest = await seated(event.publicId);

    await expect(claims.hostAbsentReadiness(guest.userId, guest.seat)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    });

    clock.set(new Date(ENDS_AT.getTime() + WINDOW_DAYS * 86_400_000 + 60_000));
    await expect(claims.hostAbsentReadiness(guest.userId, guest.seat)).rejects.toMatchObject({
      code: ErrorCode.CLAIM_WINDOW_CLOSED,
    });
  });

  it('opens one case per evening, asks the host once, and counts the reporters', async () => {
    const event = await evening();
    const first = await seated(event.publicId);
    const second = await seated(event.publicId);
    clock.set(AFTER_END);

    await claims.reportHostAbsent(first.userId, first.seat, SAID);
    await claims.reportHostAbsent(second.userId, second.seat, SAID);

    await expect(
      prisma.moderationCase.findMany({
        select: { subjectType: true, trigger: true, reportCount: true },
      }),
    ).resolves.toEqual([{ subjectType: 'EVENT', trigger: 'DISPUTE', reportCount: 2 }]);
    await expect(sent('no_show.host_absent_reported')).resolves.toEqual([
      { templateKey: TEMPLATES.HOST_ABSENT_REPORTED, to: await publicIdOf(hostId) },
    ]);
    // Money moves on the decision, never on the report.
    expect(await coins.balanceOf(hostId)).toBe(BUDGET);
  });

  it('takes the host’s answer once, inside the response window', async () => {
    const event = await evening();
    const guest = await seated(event.publicId);
    clock.set(AFTER_END);

    await expect(claims.responseReadiness(hostId, event.publicId)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE_TRANSITION,
    });

    await claims.reportHostAbsent(guest.userId, guest.seat, SAID);
    await claims.respondAsHost(hostId, event.publicId, 'من آنجا بودم، مهمان دیر رسید.');
    await expect(
      claims.respondAsHost(hostId, event.publicId, 'دوباره می‌نویسم که بودم.'),
    ).rejects.toMatchObject({ code: ErrorCode.ALREADY_CLAIMED });

    const opened = await prisma.moderationCase.findFirstOrThrow({ select: { id: true } });
    const said = await claims.claimsForCase(opened.id);
    expect(said.map((claim) => claim.authorRole)).toEqual(['GUEST', 'HOST']);
  });

  it('closes the host’s window after the configured hours', async () => {
    const event = await evening();
    const guest = await seated(event.publicId);
    clock.set(AFTER_END);
    await claims.reportHostAbsent(guest.userId, guest.seat, SAID);

    clock.set(new Date(AFTER_END.getTime() + RESPONSE_HOURS * 3_600_000 + 60_000));
    await expect(claims.responseReadiness(hostId, event.publicId)).rejects.toMatchObject({
      code: ErrorCode.CLAIM_WINDOW_CLOSED,
    });
  });

  it('upheld: the host pays, every seat is refunded, and the host’s no-shows are undone', async () => {
    const event = await evening();
    const reporter = await seated(event.publicId);
    const quiet = await seated(event.publicId);
    const markedAbsent = await seated(event.publicId);
    clock.set(AFTER_END);

    // The abuse this plan exists for: an absent host marks a guest absent.
    await lifecycle.markNoShow(hostId, markedAbsent.seat);
    await claims.dispute(markedAbsent.userId, markedAbsent.seat, SAID);
    // And the deposit was already paid back by the hourly sweep.
    await coins.apply({
      userId: hostId,
      amount: 25,
      type: 'EVENT_DEPOSIT_REFUND',
      reasonCode: 'host.deposit_refund',
      idempotencyKey: hostDepositRefundKey(event.id),
      actorType: 'SYSTEM',
      refType: 'event',
      refId: event.id,
    });

    await claims.reportHostAbsent(reporter.userId, reporter.seat, SAID);
    const hostCase = await prisma.moderationCase.findFirstOrThrow({
      where: { subjectType: 'EVENT' },
      select: { id: true },
    });

    const hostTrust = await trust.scoreOf(hostId);
    await claims.decide(MODERATOR, hostCase.id, { upheld: true, note: 'سه مهمان مستقل گفتند' });

    // The host: the no-show price, and the deposit taken back.
    expect(await coins.balanceOf(hostId)).toBe(BUDGET - HOST_PRICE);
    expect(await trust.scoreOf(hostId)).toBeLessThan(hostTrust);
    // Every seat's join deposit, reporter or not.
    expect(await coins.balanceOf(reporter.userId)).toBe(BUDGET);
    expect(await coins.balanceOf(quiet.userId)).toBe(BUDGET);
    // The guest the host marked absent: the deposit and the penalty both back.
    expect(await coins.balanceOf(markedAbsent.userId)).toBe(BUDGET);
    await expect(
      prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: markedAbsent.seat },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'COMPLETED' });
    // …and nobody has to argue that dispute separately.
    await expect(
      prisma.moderationCase.findFirstOrThrow({
        where: { subjectType: 'PARTICIPATION' },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'APPROVED' });

    await expect(
      prisma.event.findUniqueOrThrow({ where: { id: event.id }, select: { hostAbsentAt: true } }),
    ).resolves.toEqual({ hostAbsentAt: AFTER_END });

    const recipients = (await sent('no_show.claim_decided')).map((message) => message.to).sort();
    expect(recipients).toEqual(
      (
        await Promise.all(
          [hostId, reporter.userId, quiet.userId, markedAbsent.userId].map(publicIdOf),
        )
      ).sort(),
    );
  });

  it('rejected: nothing moves, and the reporters and the host are told', async () => {
    const event = await evening();
    const reporter = await seated(event.publicId);
    const quiet = await seated(event.publicId);
    clock.set(AFTER_END);
    await claims.reportHostAbsent(reporter.userId, reporter.seat, SAID);
    const hostCase = await prisma.moderationCase.findFirstOrThrow({ select: { id: true } });

    await claims.decide(MODERATOR, hostCase.id, { upheld: false, note: 'میزبان عکس جلسه فرستاد' });

    expect(await coins.balanceOf(hostId)).toBe(BUDGET);
    expect(await coins.balanceOf(reporter.userId)).toBe(BUDGET - JOIN_COST);
    const recipients = (await sent('no_show.claim_decided')).map((message) => message.to).sort();
    expect(recipients).toEqual(
      (await Promise.all([hostId, reporter.userId].map(publicIdOf))).sort(),
    );
    void quiet;
  });
});

describe('the no-shows recorded before disputes existed', () => {
  it('offers each one a dispute once, with the window running from the offer', async () => {
    const event = await evening();
    const guest = await seated(event.publicId);
    clock.set(AFTER_END);
    await lifecycle.markNoShow(hostId, guest.seat);
    // As it was before plan 08: never told with a way to dispute.
    await prisma.eventParticipant.update({
      where: { publicId: guest.seat },
      data: { noShowNotifiedAt: null },
    });
    await expect(claims.disputeReadiness(guest.userId, guest.seat)).rejects.toMatchObject({
      code: ErrorCode.CLAIM_WINDOW_CLOSED,
    });

    const later = new Date(AFTER_END.getTime() + 30 * 86_400_000);
    clock.set(later);
    await expect(claims.offerPastDisputes()).resolves.toBe(1);
    await expect(claims.offerPastDisputes()).resolves.toBe(0);

    await expect(sent('participation.no_show_dispute_offer')).resolves.toEqual([
      { templateKey: TEMPLATES.NO_SHOW_DISPUTE_OFFER, to: await publicIdOf(guest.userId) },
    ]);
    await expect(claims.disputeReadiness(guest.userId, guest.seat)).resolves.toMatchObject({
      closesAt: new Date(later.getTime() + WINDOW_DAYS * 86_400_000),
    });
  });

  it('offers nothing to a no-show recorded with a button', async () => {
    const event = await evening();
    const guest = await seated(event.publicId);
    clock.set(AFTER_END);
    await lifecycle.markNoShow(hostId, guest.seat);

    await expect(claims.offerPastDisputes()).resolves.toBe(0);
  });
});
