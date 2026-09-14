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
import { EventLifecycleService } from './lifecycle.service';

/**
 * The two reminders before an activity starts (migration 0050).
 *
 * ── Why this suite is worth its runtime ─────────────────────────────────────
 *
 * The unit tests beside it hold the wave boundary and the wording. Everything
 * that can actually hurt somebody is a **database** property and only shows up
 * here: that a cancelled evening sends nobody out of the house, that a withdrawn
 * guest is not reminded of something they left, and that a sweep running twice
 * does not tell the same person twice. Each of those is a join between two
 * tables whose statuses have to be read together, which is exactly the shape a
 * sweep written from one side gets wrong.
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

const HOUR = 3_600_000;
/** Read from the defaults, so these stay about behaviour when the hours move. */
const FIRST_WINDOW = SETTING_DEFAULTS['reminder.first_hours_before'] * HOUR;
const SECOND_WINDOW = SETTING_DEFAULTS['reminder.second_hours_before'] * HOUR;
const JOIN_BUDGET = 20 * SETTING_DEFAULTS['economy.event_join_coins'];

let fixture: CatalogFixture;
let hostId: string;

async function createProfiledUser(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: JOIN_BUDGET });
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

/** An activity starting `msFromNow` after the frozen clock. */
async function publishEvent(msFromNow: number): Promise<string> {
  const startsAt = new Date(NOW.getTime() + msFromNow);
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
      endsAt: new Date(startsAt.getTime() + 3 * HOUR),
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

/** Every reminder the outbox holds, by type. */
async function reminders(eventType: string): Promise<number> {
  return prisma.outboxEvent.count({ where: { eventType } });
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

describe('the day-ahead reminder', () => {
  it('reaches an accepted guest and the host', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);

    const result = await lifecycle.remindUpcoming();

    expect(result).toEqual({ guests: 1, hosts: 1 });
    await expect(reminders('event.reminder_guest')).resolves.toBe(1);
    await expect(reminders('event.reminder_host')).resolves.toBe(1);
  });

  /**
   * The claim is the `updateMany` filtered on NULL, not the scan — so a second
   * pass finds nothing rather than sending a second message. This is the
   * property that makes a quarter-hourly schedule safe at all.
   */
  it('is sent exactly once, however often the sweep runs', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);

    await lifecycle.remindUpcoming();
    const second = await lifecycle.remindUpcoming();
    await lifecycle.remindUpcoming();

    expect(second).toEqual({ guests: 0, hosts: 0 });
    await expect(reminders('event.reminder_guest')).resolves.toBe(1);
    await expect(reminders('event.reminder_host')).resolves.toBe(1);
  });

  it('says nothing about an activity further out than the first window', async () => {
    const eventPublicId = await publishEvent(FIRST_WINDOW + HOUR);
    await accepted(eventPublicId);

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 0, hosts: 0 });
  });

  /** Everybody accepted, not just the first. */
  it('reaches every accepted guest', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);
    await accepted(eventPublicId);
    await accepted(eventPublicId);

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 3, hosts: 1 });
  });
});

describe('the last-call reminder', () => {
  it('is the only one an activity inside the second window gets', async () => {
    const eventPublicId = await publishEvent(2 * HOUR);
    await accepted(eventPublicId);

    const result = await lifecycle.remindUpcoming();

    // The guest is told once; the host is not told at all, because the
    // day-ahead wave is the only one they receive and it was never sendable.
    expect(result).toEqual({ guests: 1, hosts: 0 });
    await expect(reminders('event.reminder_host')).resolves.toBe(0);
  });

  /**
   * Both waves over an activity's life, and **not** in the same pass. The first
   * is claimed on `reminded_first_at` and the second on `reminded_second_at`, so
   * the same guest is reminded twice in total and never twice in one wave.
   */
  it('follows the day-ahead one as the activity draws near', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 1, hosts: 1 });

    clock.set(new Date(NOW.getTime() + 12 * HOUR - SECOND_WINDOW));
    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 1, hosts: 0 });

    await expect(reminders('event.reminder_guest')).resolves.toBe(2);
  });
});

describe('who must never be reminded', () => {
  /**
   * The worst message this feature could produce. A cancelled activity whose
   * guests are still ACCEPTED would send somebody out of the house for a meeting
   * that is not happening — and it is exactly what a sweep reading only the
   * participant's status would do.
   */
  it('says nothing about a cancelled activity', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { status: 'CANCELLED_BY_HOST' },
    });

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 0, hosts: 0 });
    await expect(reminders('event.reminder_guest')).resolves.toBe(0);
  });

  /**
   * The exception, and the reason the sweep names states rather than excluding a
   * few. A moderation hide takes an activity out of discovery and does **not**
   * cancel it — `CONTENT_HIDDEN` promises the host that accepted guests keep
   * their place. Skipping the reminder would quietly apply a punishment the
   * product said it would not apply, and apply it to the guests.
   */
  it('still reminds the guests of an activity under moderation', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { status: 'HIDDEN' },
    });

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 1, hosts: 1 });
  });

  it('says nothing about a deleted one', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { deletedAt: NOW },
    });

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 0, hosts: 0 });
  });

  /** The other half of the same join: a guest who withdrew is not ACCEPTED. */
  it('says nothing to a guest who cancelled their own place', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    const guest = await accepted(eventPublicId);
    await participation.cancel(guest.userId, guest.publicId);

    const result = await lifecycle.remindUpcoming();

    // The host still gets theirs — their evening is still happening.
    expect(result.guests).toBe(0);
    await expect(reminders('event.reminder_guest')).resolves.toBe(0);
  });

  /** A request the host has not answered is not a place anybody holds. */
  it('says nothing to somebody still waiting for an answer', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    const userId = await createProfiledUser();
    await participation.join(userId, eventPublicId);

    await expect(reminders('event.reminder_guest')).resolves.toBe(0);
    const result = await lifecycle.remindUpcoming();
    expect(result.guests).toBe(0);
  });

  /**
   * An activity that has already begun belongs to `retireStarted`. A reminder
   * for one would arrive as an apology.
   */
  it('says nothing about an activity that has already started', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);

    clock.set(new Date(NOW.getTime() + 13 * HOUR));

    await expect(lifecycle.remindUpcoming()).resolves.toEqual({ guests: 0, hosts: 0 });
  });
});

describe('what the reminder carries', () => {
  /**
   * Public ids and a title. This payload becomes the text of a Telegram message,
   * so invariant 7 applies to it exactly as it does to an API response.
   */
  it('carries public ids and no internal one', async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    const guest = await accepted(eventPublicId);
    await lifecycle.remindUpcoming();

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'event.reminder_guest' },
    });
    const payload = row.payload as Record<string, unknown>;

    expect(payload['eventPublicId']).toBe(eventPublicId);
    expect(payload['eventTitle']).toBe('شب بازی رومیزی');
    expect(payload['wave']).toBe('FIRST');
    expect(typeof payload['startsAt']).toBe('string');
    // The participation, so «✖️ لغو شرکت» can name it (plan 11).
    expect(payload['participantPublicId']).toBe(guest.publicId);
    expect(JSON.stringify(payload)).not.toContain(guest.userId);
  });

  /** The head count is `accepted_count`, the column invariant 1 is enforced on. */
  it("carries the host's head count", async () => {
    const eventPublicId = await publishEvent(12 * HOUR);
    await accepted(eventPublicId);
    await accepted(eventPublicId);
    await lifecycle.remindUpcoming();

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'event.reminder_host' },
    });

    expect((row.payload as Record<string, unknown>)['acceptedCount']).toBe(2);
  });
});
