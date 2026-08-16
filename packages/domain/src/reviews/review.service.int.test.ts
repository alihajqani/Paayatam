import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
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
import { SettingsService } from '../catalog/settings.service';
import { ChatService } from '../chat/chat.service';
import { MessageCipher } from '../chat/message-cipher';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { ReferralService } from '../economy/referral.service';
import { TrustService } from '../economy/trust.service';
import { EventLifecycleService } from '../events/lifecycle.service';
import { BlacklistService } from '../moderation/blacklist.service';
import { ModerationService } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { normalize } from '../moderation/persian-normalizer';
import { ReviewService } from './review.service';

/**
 * Blind reviews against a real database (M11, ADR-0011 D7/D7a).
 *
 * The property under test is stated once and asserted from every angle:
 * **neither party can read the other's review while writing their own**. The plan
 * is explicit that this must hold at the API layer rather than in the interface,
 * so the tests reach for the service the API calls, and there is a companion
 * assertion over HTTP in the response-leak scan.
 *
 * Everything goes through the real settlement sweep rather than seeding
 * `review_pair` rows, because "you can only review an evening you were actually
 * at" is a property of where the pair is created, and a seeded pair would prove
 * nothing about it.
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
const referrals = new ReferralService(service, clock, settings, coins, audit);
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
const ENDS_AT = new Date(STARTS_AT.getTime() + 3 * 3_600_000);
/** Past the end and past the settlement delay, so the sweep acts. */
const AFTER_SETTLEMENT = new Date(ENDS_AT.getTime() + 25 * 3_600_000);
/** Inside the review window: opens at end + 24 h, closes at end + 7 d. */
const IN_WINDOW = new Date(ENDS_AT.getTime() + 48 * 3_600_000);
/** Past the deadline. */
const AFTER_DEADLINE = new Date(ENDS_AT.getTime() + 8 * 24 * 3_600_000);

let fixture: CatalogFixture;
let hostId: string;
let hostPublicId: string;

async function createProfiledUser(): Promise<{ id: string; publicId: string }> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return { id: userId, publicId: user.publicId };
}

async function publishEvent(): Promise<string> {
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
    select: { publicId: true },
  });
  return event.publicId;
}

/**
 * A completed participation with its review window open — through the real join,
 * accept and settlement path, so the pair exists for the reason it does in
 * production.
 */
async function reviewableParticipation(): Promise<{
  participantPublicId: string;
  guestId: string;
  guestPublicId: string;
}> {
  const eventPublicId = await publishEvent();
  const guest = await createProfiledUser();
  const request = await participation.join(guest.id, eventPublicId);
  await participation.accept(hostId, request.publicId);

  clock.set(AFTER_SETTLEMENT);
  await lifecycle.retireStarted();
  await lifecycle.settleAttendance();
  clock.set(IN_WINDOW);

  return {
    participantPublicId: request.publicId,
    guestId: guest.id,
    guestPublicId: guest.publicId,
  };
}

async function seedBlacklist(): Promise<void> {
  await prisma.blacklistVersion.create({ data: { version: 3 } });
  await prisma.blacklistTerm.createMany({
    data: [
      {
        termRaw: 'مشروب',
        termNormalized: normalize('مشروب'),
        patternType: 'SUBSTRING',
        severity: 'BLOCK',
      },
      {
        termRaw: 'شیشه',
        termNormalized: normalize('شیشه'),
        patternType: 'EXACT',
        severity: 'FLAG',
      },
    ],
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  await seedBlacklist();
  const host = await createProfiledUser();
  hostId = host.id;
  hostPublicId = host.publicId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the window opens when attendance is settled', () => {
  it('gives a completed participation a pair, measured from the event end', async () => {
    const { participantPublicId } = await reviewableParticipation();

    const pair = await prisma.reviewPair.findFirstOrThrow({
      where: { participant: { publicId: participantPublicId } },
    });
    expect(pair.status).toBe('PENDING');
    expect(pair.opensAt).toEqual(new Date(ENDS_AT.getTime() + 24 * 3_600_000));
    expect(pair.deadlineAt).toEqual(new Date(ENDS_AT.getTime() + 7 * 24 * 3_600_000));
  });

  /**
   * Reviewing somebody for not turning up is what the no-show penalty already is.
   * Asking the two of them to rate an evening that did not happen would produce a
   * rating about nothing.
   */
  it('gives a no-show no pair at all', async () => {
    const eventPublicId = await publishEvent();
    const guest = await createProfiledUser();
    const request = await participation.join(guest.id, eventPublicId);
    await participation.accept(hostId, request.publicId);

    clock.set(new Date(ENDS_AT.getTime() + 3_600_000));
    await lifecycle.retireStarted();
    await lifecycle.markNoShow(hostId, request.publicId);

    clock.set(AFTER_SETTLEMENT);
    await lifecycle.settleAttendance();

    await expect(prisma.reviewPair.count()).resolves.toBe(0);
  });

  it('gives a cancelled participation no pair', async () => {
    const eventPublicId = await publishEvent();
    const guest = await createProfiledUser();
    const request = await participation.join(guest.id, eventPublicId);
    await participation.accept(hostId, request.publicId);
    await participation.cancel(guest.id, request.publicId);

    clock.set(AFTER_SETTLEMENT);
    await lifecycle.retireStarted();
    await lifecycle.settleAttendance();

    await expect(prisma.reviewPair.count()).resolves.toBe(0);
  });

  it('opens one window however many times the sweep runs', async () => {
    const { participantPublicId } = await reviewableParticipation();
    clock.set(AFTER_SETTLEMENT);
    await lifecycle.settleAttendance();

    await expect(
      prisma.reviewPair.count({ where: { participant: { publicId: participantPublicId } } }),
    ).resolves.toBe(1);
  });
});

/**
 * D7, the whole reason this milestone exists.
 *
 * Asserted at the service layer, which is what the API calls — the plan's "at the
 * API layer, not the UI". A UI-level check would protect one client; the bot will
 * reach the same methods.
 */
describe('a review is unreadable before reveal (D7, invariant 8)', () => {
  it('does not show the guest the host’s review while theirs is unwritten', async () => {
    const { participantPublicId, guestPublicId } = await reviewableParticipation();

    await reviews.submit(hostId, participantPublicId, { rating: 2, comment: 'دیر آمد' });

    // The guest looks up their own public profile — the only read path there is.
    const visible = await reviews.listForUser(guestPublicId);
    expect(visible).toEqual([]);
  });

  it('does not show the host the guest’s review either', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();

    await reviews.submit(guestId, participantPublicId, { rating: 1, comment: 'میزبان نیامد' });

    await expect(reviews.listForUser(hostPublicId)).resolves.toEqual([]);
  });

  /**
   * The subtle way this invariant breaks: an average that moves when an unrevealed
   * rating lands leaks the rating through arithmetic, without ever returning it.
   */
  it('leaves the reviewee’s visible history completely empty, not merely unlisted', async () => {
    const { participantPublicId, guestPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 5 });

    const visible = await reviews.listForUser(guestPublicId);
    expect(visible).toHaveLength(0);

    // And the row does exist — so the emptiness above is the filter working, not
    // the write having failed.
    await expect(prisma.review.count()).resolves.toBe(1);
  });

  it('reveals both the moment the second one lands', async () => {
    const { participantPublicId, guestId, guestPublicId } = await reviewableParticipation();

    await reviews.submit(hostId, participantPublicId, { rating: 4, comment: 'خوب بود' });
    const second = await reviews.submit(guestId, participantPublicId, { rating: 5 });

    expect(second.revealed).toBe(true);

    const aboutGuest = await reviews.listForUser(guestPublicId);
    const aboutHost = await reviews.listForUser(hostPublicId);
    expect(aboutGuest).toHaveLength(1);
    expect(aboutHost).toHaveLength(1);
    expect(aboutGuest[0]?.rating).toBe(4);
    expect(aboutHost[0]?.rating).toBe(5);
    expect(aboutGuest[0]?.withoutCounterpart).toBe(false);
  });

  /** A reviewer may always read back what they themselves wrote. */
  it('lets the author read their own unrevealed review', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 3, comment: 'معمولی' });

    const own = await reviews.findOwn(hostId, participantPublicId);
    expect(own?.rating).toBe(3);
    expect(own?.revealed).toBe(false);
  });

  /** And cannot read the counterparty's through that path either. */
  it('tells the counterparty they have written nothing, not what the other wrote', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 1, comment: 'افتضاح' });

    await expect(reviews.findOwn(guestId, participantPublicId)).resolves.toBeNull();
  });
});

describe('D7a — the deadline with one side written', () => {
  it('reveals the one that was written, and marks it as unanswered', async () => {
    const { participantPublicId, guestPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 4, comment: 'خوب بود' });

    clock.set(AFTER_DEADLINE);
    const settled = await reviews.settleExpired();
    expect(settled).toEqual({ partial: 1, empty: 0 });

    const visible = await reviews.listForUser(guestPublicId);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.withoutCounterpart).toBe(true);
  });

  /**
   * The heart of D7a: the reviewer's effort stays visible, but somebody who never
   * reviewed cannot have their score moved by a counterparty they had no
   * opportunity to answer.
   */
  it('does not move the reviewee’s trust score', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();
    const before = await trust.scoreOf(guestId);

    await reviews.submit(hostId, participantPublicId, { rating: 5 });
    clock.set(AFTER_DEADLINE);
    await reviews.settleExpired();

    await expect(trust.scoreOf(guestId)).resolves.toBe(before);
  });

  /** The override the plan explicitly flags, working without a deploy. */
  it('does move it when the setting says so', async () => {
    await prisma.appSetting.create({
      data: { key: 'review.partial_reveal_affects_trust', value: 1 },
    });

    const { participantPublicId, guestId } = await reviewableParticipation();
    const before = await trust.scoreOf(guestId);

    await reviews.submit(hostId, participantPublicId, { rating: 5 });
    clock.set(AFTER_DEADLINE);
    await reviews.settleExpired();

    await expect(trust.scoreOf(guestId)).resolves.toBe(before + 3);
  });

  it('settles a pair nobody wrote as empty, revealing nothing', async () => {
    await reviewableParticipation();

    clock.set(AFTER_DEADLINE);
    const settled = await reviews.settleExpired();

    expect(settled).toEqual({ partial: 0, empty: 1 });
    const pair = await prisma.reviewPair.findFirstOrThrow();
    expect(pair.status).toBe('EXPIRED_EMPTY');
  });

  it('is safe to run twice', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 4 });

    clock.set(AFTER_DEADLINE);
    const first = await reviews.settleExpired();
    const second = await reviews.settleExpired();

    expect(first.partial).toBe(1);
    expect(second).toEqual({ partial: 0, empty: 0 });
  });

  it('refuses a review submitted after the deadline', async () => {
    const { participantPublicId } = await reviewableParticipation();
    clock.set(AFTER_DEADLINE);

    await expect(reviews.submit(hostId, participantPublicId, { rating: 5 })).rejects.toMatchObject({
      code: 'REVIEW_WINDOW_CLOSED',
    });
  });

  it('refuses a review submitted before the window opens', async () => {
    const { participantPublicId } = await reviewableParticipation();
    clock.set(new Date(ENDS_AT.getTime() + 60_000));

    await expect(reviews.submit(hostId, participantPublicId, { rating: 5 })).rejects.toMatchObject({
      code: 'REVIEW_WINDOW_CLOSED',
    });
  });
});

describe('what a review is worth (plan §11)', () => {
  it('pays the reviewer on submission, whatever the other side does', async () => {
    const { participantPublicId } = await reviewableParticipation();

    await reviews.submit(hostId, participantPublicId, { rating: 5 });

    await expect(coins.balanceOf(hostId)).resolves.toBe(10);
  });

  it.each([
    [5, 3],
    [4, 1],
    [2, -2],
    [1, -5],
  ])('moves the reviewee by %i stars → %i trust at reveal', async (rating, delta) => {
    const { participantPublicId, guestId } = await reviewableParticipation();
    const before = await trust.scoreOf(guestId);

    await reviews.submit(hostId, participantPublicId, { rating });
    // The guest's own review is what completes the pair and triggers the reveal.
    await reviews.submit(guestId, participantPublicId, { rating: 3 });

    await expect(trust.scoreOf(guestId)).resolves.toBe(before + delta);
  });

  /** Three stars is worth nothing by policy, and writes no movement at all. */
  it('writes no trust movement for a neutral rating', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();

    await reviews.submit(hostId, participantPublicId, { rating: 3 });
    await reviews.submit(guestId, participantPublicId, { rating: 3 });

    await expect(prisma.trustScoreLedger.count({ where: { type: 'REVIEW' } })).resolves.toBe(0);
  });

  it('moves nothing until the pair actually reveals', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();
    const before = await trust.scoreOf(guestId);

    await reviews.submit(hostId, participantPublicId, { rating: 5 });

    await expect(trust.scoreOf(guestId)).resolves.toBe(before);
  });
});

describe('what submitting refuses', () => {
  it('refuses a second review of the same participation (invariant 6)', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 5 });

    await expect(reviews.submit(hostId, participantPublicId, { rating: 1 })).rejects.toMatchObject({
      code: 'ALREADY_REVIEWED',
    });
  });

  it('refuses a stranger, without confirming the participation exists', async () => {
    const { participantPublicId } = await reviewableParticipation();
    const stranger = await createProfiledUser();

    await expect(
      reviews.submit(stranger.id, participantPublicId, { rating: 5 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a rating outside the scale', async () => {
    const { participantPublicId } = await reviewableParticipation();

    await expect(reviews.submit(hostId, participantPublicId, { rating: 6 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('is refused by the database too, if the service ever stops checking', async () => {
    const { participantPublicId } = await reviewableParticipation();
    const participant = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: participantPublicId },
      select: { id: true, eventId: true },
    });

    await expect(
      prisma.review.create({
        data: {
          eventId: participant.eventId,
          participantId: participant.id,
          reviewerUserId: hostId,
          revieweeUserId: hostId,
          rating: 5,
          editDeadlineAt: IN_WINDOW,
        },
      }),
    ).rejects.toThrow(/review_not_self/);
  });
});

describe('editing (plan §11: one hour, never after reveal)', () => {
  it('replaces the review inside the hour', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 2, comment: 'بد بود' });

    clock.set(new Date(IN_WINDOW.getTime() + 30 * 60_000));
    const edited = await reviews.edit(hostId, participantPublicId, {
      rating: 4,
      comment: 'فکر کردم، بهتر بود',
    });

    expect(edited.rating).toBe(4);
    const own = await reviews.findOwn(hostId, participantPublicId);
    expect(own?.comment).toBe('فکر کردم، بهتر بود');
  });

  it('refuses after the hour has passed', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 2 });

    clock.set(new Date(IN_WINDOW.getTime() + 61 * 60_000));
    await expect(reviews.edit(hostId, participantPublicId, { rating: 5 })).rejects.toMatchObject({
      code: 'REVIEW_NOT_EDITABLE',
    });
  });

  /**
   * The interesting refusal. Once the counterparty can see what you wrote, an edit
   * is a reply — which is the exact dynamic D7 exists to prevent. Refused even
   * though the hour has not run out.
   */
  it('refuses after reveal, even inside the hour', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 2 });
    await reviews.submit(guestId, participantPublicId, { rating: 5 });

    clock.set(new Date(IN_WINDOW.getTime() + 5 * 60_000));
    await expect(reviews.edit(hostId, participantPublicId, { rating: 5 })).rejects.toMatchObject({
      code: 'REVIEW_NOT_EDITABLE',
    });
  });

  it('refuses to edit a review that was never written', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();

    await expect(reviews.edit(guestId, participantPublicId, { rating: 5 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the pending list', () => {
  it('shows both sides a window that is open', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();

    const forHost = await reviews.listPending(hostId);
    const forGuest = await reviews.listPending(guestId);

    expect(forHost).toHaveLength(1);
    expect(forHost[0]?.role).toBe('HOST');
    expect(forHost[0]?.participantPublicId).toBe(participantPublicId);
    expect(forGuest).toHaveLength(1);
    expect(forGuest[0]?.role).toBe('GUEST');
  });

  it('drops the side that has already written, and keeps the one that has not', async () => {
    const { participantPublicId, guestId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 5 });

    await expect(reviews.listPending(hostId)).resolves.toEqual([]);
    await expect(reviews.listPending(guestId)).resolves.toHaveLength(1);
  });

  it('shows nothing before the window opens or after it closes', async () => {
    const { guestId } = await reviewableParticipation();

    clock.set(new Date(ENDS_AT.getTime() + 60_000));
    await expect(reviews.listPending(guestId)).resolves.toEqual([]);

    clock.set(AFTER_DEADLINE);
    await expect(reviews.listPending(guestId)).resolves.toEqual([]);
  });

  it('names the counterparty, because by now the two of them have met', async () => {
    const { guestPublicId } = await reviewableParticipation();

    const forHost = await reviews.listPending(hostId);
    expect(forHost[0]?.revieweePublicId).toBe(guestPublicId);
    expect(forHost[0]?.revieweeDisplayName).toBe('کاربر');
  });
});

describe('the reveal announcement', () => {
  it('emits one domain event for the pair, naming both by public id', async () => {
    const { participantPublicId, guestId, guestPublicId } = await reviewableParticipation();

    await reviews.submit(hostId, participantPublicId, { rating: 4 });
    await reviews.submit(guestId, participantPublicId, { rating: 4 });

    const emitted = await prisma.outboxEvent.findMany({
      where: { eventType: 'review.revealed' },
    });
    expect(emitted).toHaveLength(1);

    const payload = JSON.stringify(emitted[0]?.payload);
    expect(payload).toContain(guestPublicId);
    expect(payload).toContain(hostPublicId);
    // Internal ids never reach a payload that becomes a Telegram message.
    expect(payload).not.toContain(guestId);
    expect(payload).not.toContain(hostId);
    // Nor does what anybody actually wrote.
    expect(payload).not.toContain('rating');
  });
});

/**
 * A review comment is public free text about another person, so it gets the same
 * blacklist an event description does (§4.6, ADR-0012).
 *
 * The one deliberate difference from event authoring: a blocked comment does not
 * *refuse* the submission. A review is one half of a pair, and refusing it would
 * let one party's bad language stop the other party's review from ever revealing.
 * The rating counts, the pair completes, and only the text is withheld.
 */
describe('a review comment is moderated (§4.6)', () => {
  it('approves a clean comment and opens no case', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 5, comment: 'عصر خوبی بود' });

    const row = await prisma.review.findFirstOrThrow();
    expect(row.moderationStatus).toBe('APPROVED');
    await expect(prisma.moderationCase.count()).resolves.toBe(0);
  });

  it('publishes a FLAG and opens a case anyway (ADR-0012)', async () => {
    const { participantPublicId, guestId, guestPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 4, comment: 'کافه شیشه ای بود' });
    await reviews.submit(guestId, participantPublicId, { rating: 4 });

    const row = await prisma.review.findFirstOrThrow({ where: { reviewerUserId: hostId } });
    expect(row.moderationStatus).toBe('FLAGGED');
    await expect(prisma.moderationCase.count({ where: { subjectType: 'REVIEW' } })).resolves.toBe(
      1,
    );

    // FLAG publishes. That is the tuning decision ADR-0012 makes explicitly.
    await expect(reviews.listForUser(guestPublicId)).resolves.toHaveLength(1);
  });

  it('withholds a BLOCK from the public read without refusing the submission', async () => {
    const { participantPublicId, guestId, guestPublicId } = await reviewableParticipation();

    const own = await reviews.submit(hostId, participantPublicId, {
      rating: 1,
      comment: 'میزبان مشروب آورده بود',
    });
    // The submission succeeded, so the pair can still complete.
    expect(own.rating).toBe(1);

    await reviews.submit(guestId, participantPublicId, { rating: 5 });

    const row = await prisma.review.findFirstOrThrow({ where: { reviewerUserId: hostId } });
    expect(row.moderationStatus).toBe('PENDING');
    // Revealed as far as the pair is concerned, but not publicly readable.
    expect(row.status).toBe('REVEALED');
    await expect(reviews.listForUser(guestPublicId)).resolves.toEqual([]);

    // And the other side, which was clean, is unaffected.
    await expect(reviews.listForUser(hostPublicId)).resolves.toHaveLength(1);
  });

  /**
   * Without re-judging on edit, "submit something clean, then edit it into
   * something else" would be the obvious way past the scanner.
   */
  it('re-judges an edit', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 5, comment: 'عالی بود' });

    await reviews.edit(hostId, participantPublicId, {
      rating: 5,
      comment: 'در واقع مشروب سرو می‌کردند',
    });

    const row = await prisma.review.findFirstOrThrow();
    expect(row.moderationStatus).toBe('PENDING');
    await expect(prisma.moderationCase.count({ where: { subjectType: 'REVIEW' } })).resolves.toBe(
      1,
    );
  });

  it('records the blacklist version that judged it', async () => {
    const { participantPublicId } = await reviewableParticipation();
    await reviews.submit(hostId, participantPublicId, { rating: 1, comment: 'مشروب بود' });

    const opened = await prisma.moderationCase.findFirstOrThrow({
      where: { subjectType: 'REVIEW' },
    });
    expect(opened.blacklistVersion).toBe(3);
    // The case names the rules that fired, never the text they fired on (ADR-0009).
    expect(JSON.stringify(opened.matchedTerms)).not.toContain('میزبان');
  });
});
