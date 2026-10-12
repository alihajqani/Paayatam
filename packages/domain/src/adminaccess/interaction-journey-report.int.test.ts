import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import { ErrorCode, INTERACTION_QUIET_DAYS } from '@payetam/shared';
import {
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { InteractionJourneyReportService } from './interaction-journey-report.service';
import { ROLE_KEYS } from './permissions';

/**
 * Funnels, drop-off and return, against real rows (release 2 of migration 0065).
 *
 * Each of these is a question about a *sequence* — which step came last, what
 * came before a block, whether anything happened a week later — and every one
 * of them is answered by a window function or a correlated subquery whose
 * off-by-one is invisible until it is run on rows that were built to catch it.
 * So there is one small cast, and each person in it exists to make one number
 * come out differently from the number beside it.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-10-10T12:00:00.000Z');
const clock = new FakeClock(NOW);

const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const access = new AdminAccessService(
  service,
  clock,
  { client: {} } as unknown as RedisService,
  credentials,
  audit,
);
const report = new InteractionJourneyReportService(service, clock, access);

const ANALYST: AdminSession = {
  adminUserId: 'admin-analyst',
  email: 'analyst@payetam.test',
  displayName: 'ANALYST',
  roles: [ROLE_KEYS.ANALYST],
  permissions: permissionsFor([ROLE_KEYS.ANALYST]),
};
const NOBODY: AdminSession = { ...ANALYST, roles: [], permissions: [] };

/** Minutes in a day: every time below is "this many minutes before now". */
const DAY = 24 * 60;

function ago(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

let fixture: CatalogFixture;
let updateId = 0n;
let telegramId = 920_000_000n;

type Person = { id: string; telegramUserId: bigint };

let ali: Person;
let sara: Person;
let reza: Person;
let mina: Person;
let staff: Person;
let eventId: string;
let eventPublicId: string;

async function person(
  arrivedMinutesAgo: number,
  onboardingState: 'NEW' | 'TERMS_ACCEPTED' | 'PROFILE_COMPLETE',
  acquisition: { source: 'CAMPAIGN' | 'DIRECT' | 'EVENT_LINK'; ref: string | null } | null,
): Promise<Person> {
  telegramId += 1n;
  const user = await prisma.user.create({
    data: {
      onboardingState,
      createdAt: ago(arrivedMinutesAgo),
      telegramAccount: { create: { telegramUserId: telegramId } },
      ...(acquisition === null ? {} : { acquisition: { create: acquisition } }),
    },
    select: { id: true },
  });
  return { id: user.id, telegramUserId: telegramId };
}

interface Seen {
  kind?: 'START' | 'COMMAND' | 'CALLBACK' | 'KEYBOARD' | 'TEXT' | 'UNSUPPORTED' | 'BLOCKED';
  ref?: string;
  created?: boolean;
  messageId?: number;
  /** `[kind, step]` left on screen. */
  form?: [string | null, string];
  finished?: string;
  outcome?: 'OK' | 'REFUSED' | 'GATED' | 'STALE' | 'FAILED';
  detail?: string;
  screen?: string;
}

async function seen(
  who: Person,
  action: string,
  minutesAgo: number,
  extra: Seen = {},
): Promise<void> {
  updateId += 1n;
  await prisma.botInteraction.create({
    data: {
      updateId,
      userId: who.id,
      kind: extra.kind ?? 'CALLBACK',
      action,
      ref: extra.ref ?? null,
      createdAccount: extra.created ?? false,
      messageId: extra.messageId ?? null,
      wizardKind: extra.form?.[0] ?? null,
      wizardStep: extra.form?.[1] ?? null,
      finishedWizard: extra.finished ?? null,
      outcome: extra.outcome ?? 'OK',
      detail: extra.detail ?? null,
      screen: extra.screen ?? null,
      createdAt: ago(minutesAgo),
    },
  });
}

let notificationSequence = 0;

async function sent(
  to: Person,
  templateKey: string,
  minutesAgo: number,
  extra: { messageId?: number; dedupeKey?: string; pending?: boolean } = {},
): Promise<void> {
  notificationSequence += 1;
  await prisma.notification.create({
    data: {
      userId: to.id,
      templateKey,
      payload: {},
      dedupeKey: extra.dedupeKey ?? `outbox-${String(notificationSequence)}:guest`,
      status: extra.pending === true ? 'PENDING' : 'SENT',
      sentAt: extra.pending === true ? null : ago(minutesAgo),
      telegramMessageId: extra.messageId ?? null,
      createdAt: ago(minutesAgo),
    },
  });
}

const TERMS: [string, string] = ['ACCEPT_POLICIES', 'agree'];

/**
 * Ali came from an ad forty days ago, accepted the terms, finished his profile,
 * came back two days later to look around, and was here again the day before
 * yesterday after a notification. He is what "it worked" looks like.
 *
 * Sara followed a channel post ten days ago, accepted the terms, answered one
 * profile question and never came back. Two days after arriving she blocked.
 *
 * Reza opened the bot three days ago, was shown the terms, and blocked it two
 * minutes later without pressing anything.
 *
 * Mina has had an account for months. Three weeks ago she opened the bug form
 * and closed it, and the next day nothing she tried went through.
 */
async function tellTheStory(): Promise<void> {
  const A = 40 * DAY;
  await seen(ali, 'start:campaign', A, {
    kind: 'START',
    ref: 'tgads_1',
    created: true,
    form: TERMS,
    screen: 'bot.wizard',
  });
  // One update: the terms are submitted *and* the profile form is opened.
  await seen(ali, 'wz:agree', A - 1, {
    finished: 'ACCEPT_POLICIES',
    form: ['EDIT_PROFILE', 'name'],
    screen: 'bot.wizard',
  });
  await seen(ali, 'text:answer', A - 2, {
    kind: 'TEXT',
    form: ['EDIT_PROFILE', 'city'],
    screen: 'bot.wizard',
  });
  await seen(ali, 'wz:city', A - 3, { form: ['EDIT_PROFILE', '$summary'], screen: 'bot.wizard' });
  await seen(ali, 'wz:confirm', A - 4, { finished: 'EDIT_PROFILE', screen: 'bot.notice' });
  await seen(ali, 'kb:discover', 38 * DAY, { kind: 'KEYBOARD', screen: 'bot.discover' });
  await seen(ali, 'ev:show', 38 * DAY - 1, { ref: eventPublicId, screen: 'bot.event_detail' });
  await seen(ali, 'ev:show', 2 * DAY, {
    ref: eventPublicId,
    screen: 'bot.event_detail',
    messageId: 500,
  });
  await prisma.eventParticipant.create({
    data: { eventId, userId: ali.id, status: 'PENDING' },
  });

  const S = 10 * DAY;
  await seen(sara, 'start:event', S, {
    kind: 'START',
    ref: eventPublicId,
    created: true,
    form: TERMS,
    screen: 'bot.wizard',
  });
  await seen(sara, 'wz:agree', S - 1, {
    finished: 'ACCEPT_POLICIES',
    form: ['EDIT_PROFILE', 'name'],
    screen: 'bot.wizard',
  });
  await seen(sara, 'text:answer', S - 2, {
    kind: 'TEXT',
    form: ['EDIT_PROFILE', 'city'],
    screen: 'bot.wizard',
  });
  await seen(sara, 'blocked', 8 * DAY, { kind: 'BLOCKED' });

  const R = 3 * DAY;
  await seen(reza, 'start:direct', R, {
    kind: 'START',
    created: true,
    form: TERMS,
    screen: 'bot.wizard',
  });
  await seen(reza, 'blocked', R - 2, { kind: 'BLOCKED' });

  await seen(mina, 'cmd:bug', 21 * DAY, {
    kind: 'COMMAND',
    form: ['BUG_REPORT', 'what'],
    screen: 'bot.wizard',
  });
  // A cancelled form no longer knows its kind; the reports take it from the row before.
  await seen(mina, 'wz:cancel', 21 * DAY - 1, { form: [null, '$cancelled'], screen: 'bot.notice' });
  const M = 20 * DAY;
  await seen(mina, 'ev:join', M, { outcome: 'REFUSED', detail: 'EVENT_FULL' });
  await seen(mina, 'ev:join', M - 1, { outcome: 'REFUSED', detail: 'EVENT_FULL' });
  await seen(mina, 'ev:join', M - 2, { outcome: 'REFUSED', detail: 'PROFILE_INCOMPLETE' });
  await seen(mina, 'cmd:discover', M - 3, { kind: 'COMMAND', outcome: 'GATED', detail: 'profile' });
  await seen(mina, 'ad:list', M - 4, { outcome: 'STALE' });
  await seen(mina, 'ev:show', M - 5, { outcome: 'FAILED' });
  await seen(mina, 'unsupported', M - 6, { kind: 'UNSUPPORTED', screen: 'bot.notice' });
  await seen(mina, 'text:unclaimed', M - 7, { kind: 'TEXT', screen: 'bot.notice' });
  await seen(mina, 'text:unclaimed', M - 8, { kind: 'TEXT', screen: 'bot.notice' });

  // What the product sent on its own. Ali pressed a button on the first.
  await sent(ali, 'participation.accepted', 2 * DAY + 10, { messageId: 500 });
  await sent(ali, 'event.reminder_guest', 2 * DAY + 5, { messageId: 502 });
  await sent(mina, 'participation.accepted', 5 * DAY, { messageId: 501 });
  // A reply to somebody's own update is not something the product sent on its own.
  await sent(ali, 'bot.welcome', 2 * DAY, { dedupeKey: 'bot:9:bot.welcome' });
  // Never delivered.
  await sent(sara, 'participation.accepted', 9 * DAY, { pending: true });
}

/** The operator, pressing things. None of it may reach any number below. */
async function staffNoise(): Promise<void> {
  await seen(staff, 'start:direct', 5 * DAY, {
    kind: 'START',
    created: true,
    form: TERMS,
    screen: 'bot.wizard',
  });
  await seen(staff, 'wz:agree', 5 * DAY - 1, {
    finished: 'ACCEPT_POLICIES',
    form: ['EDIT_PROFILE', 'name'],
  });
  await seen(staff, 'ev:join', 20 * DAY, { outcome: 'REFUSED', detail: 'EVENT_FULL' });
  await seen(staff, 'ad:list', 20 * DAY, { outcome: 'STALE' });
  await seen(staff, 'text:unclaimed', 15 * DAY, { kind: 'TEXT', screen: 'bot.menu' });
  await seen(staff, 'blocked', 4 * DAY, { kind: 'BLOCKED' });
  await sent(staff, 'participation.accepted', DAY, { messageId: 900 });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  mina = await person(100 * DAY, 'PROFILE_COMPLETE', null);
  const event = await prisma.event.create({
    data: {
      hostUserId: mina.id,
      title: 'دورهمی بازی',
      description: 'یک شب بازی.',
      titleNormalized: 'دورهمی بازی',
      descriptionNormalized: 'یک شب بازی',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date(NOW.getTime() + 3 * 86_400_000),
      endsAt: new Date(NOW.getTime() + 3 * 86_400_000 + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { id: true, publicId: true },
  });
  eventId = event.id;
  eventPublicId = event.publicId;

  ali = await person(40 * DAY, 'PROFILE_COMPLETE', { source: 'CAMPAIGN', ref: 'tgads_1' });
  sara = await person(10 * DAY, 'TERMS_ACCEPTED', { source: 'EVENT_LINK', ref: eventPublicId });
  reza = await person(3 * DAY, 'NEW', { source: 'DIRECT', ref: null });

  staff = await person(5 * DAY, 'PROFILE_COMPLETE', { source: 'DIRECT', ref: null });
  const admin = await prisma.adminUser.create({
    data: {
      email: 'operator@payetam.test',
      passwordHash: 'not-a-real-hash',
      totpSecretEnc: 'not-a-real-secret',
      displayName: 'operator',
    },
    select: { id: true },
  });
  await prisma.adminTelegramLink.create({
    data: {
      adminUserId: admin.id,
      telegramUserId: staff.telegramUserId,
      grantedById: admin.id,
      reason: 'test fixture',
    },
  });

  await tellTheStory();
  await staffNoise();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('funnels', () => {
  it('says how far each source’s new accounts got', async () => {
    const funnels = await report.funnels(ANALYST, 90);

    expect(funnels.since).toEqual(ago(90 * DAY));
    expect(funnels.onboarding.rows).toEqual([
      {
        source: 'CAMPAIGN',
        arrived: 1,
        pressedAnything: 1,
        termsAccepted: 1,
        profileComplete: 1,
        openedDiscovery: 1,
        openedEvent: 1,
        requested: 1,
      },
      {
        // Reza: shown the terms, pressed nothing. A block is not a press.
        source: 'DIRECT',
        arrived: 1,
        pressedAnything: 0,
        termsAccepted: 0,
        profileComplete: 0,
        openedDiscovery: 0,
        openedEvent: 0,
        requested: 0,
      },
      {
        // Sara followed an *event* link and was shown the terms, not the event.
        source: 'EVENT_LINK',
        arrived: 1,
        pressedAnything: 1,
        termsAccepted: 1,
        profileComplete: 0,
        openedDiscovery: 0,
        openedEvent: 0,
        requested: 0,
      },
    ]);
    expect(funnels.onboarding.totals).toEqual({
      arrived: 3,
      pressedAnything: 2,
      termsAccepted: 2,
      profileComplete: 1,
      openedDiscovery: 1,
      openedEvent: 1,
      requested: 1,
    });
  });

  /** Ali arrived forty days ago: a thirty-day window is about Sara and Reza. */
  it('is about the accounts the window created, not everybody', async () => {
    const funnels = await report.funnels(ANALYST, 30);
    expect(funnels.onboarding.totals.arrived).toBe(2);
    expect(funnels.onboarding.rows.map((row) => row.source)).toEqual(['DIRECT', 'EVENT_LINK']);
  });

  /**
   * The terms are submitted by the same update that opens the profile form, so
   * "submitted" cannot be read off the step left on screen — it is read from
   * `finished_wizard`. Without that, this would say 0 of 3.
   */
  it('counts a form as finished when the update that sent it opened the next', async () => {
    const funnels = await report.funnels(ANALYST, 90);
    const terms = funnels.forms.find((form) => form.kind === 'ACCEPT_POLICIES');

    expect(terms).toEqual({
      kind: 'ACCEPT_POLICIES',
      started: 3,
      submitted: 2,
      cancelled: 0,
      // Reza was shown the question and left on it.
      steps: [{ step: 'agree', users: 3, leftHere: 1 }],
    });
  });

  it('names the step each form lost people on, in the order people meet them', async () => {
    const funnels = await report.funnels(ANALYST, 90);
    const profile = funnels.forms.find((form) => form.kind === 'EDIT_PROFILE');

    expect(profile).toEqual({
      kind: 'EDIT_PROFILE',
      started: 2,
      submitted: 1,
      cancelled: 0,
      steps: [
        { step: 'name', users: 2, leftHere: 0 },
        // Sara answered her name and was never seen again.
        { step: 'city', users: 2, leftHere: 1 },
        { step: '$summary', users: 1, leftHere: 0 },
      ],
    });
  });

  /** Closing a form is a decision, not a loss: it is counted apart from being left on a step. */
  it('attributes a cancelled form to the form that was open, and to no step', async () => {
    const funnels = await report.funnels(ANALYST, 90);
    const bug = funnels.forms.find((form) => form.kind === 'BUG_REPORT');

    expect(bug).toEqual({
      kind: 'BUG_REPORT',
      started: 1,
      submitted: 0,
      cancelled: 1,
      steps: [{ step: 'what', users: 1, leftHere: 0 }],
    });
  });

  it('lists the forms most people started first', async () => {
    const funnels = await report.funnels(ANALYST, 90);
    expect(funnels.forms.map((form) => form.kind)).toEqual([
      'ACCEPT_POLICIES',
      'EDIT_PROFILE',
      'BUG_REPORT',
    ]);
  });

  it('is refused without dashboard.read', async () => {
    await expect(report.funnels(NOBODY, 30)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

describe('drop-off', () => {
  /**
   * Sara and Mina were last seen inside the window and more than a week ago.
   * Ali was here the day before yesterday; Reza's last *action* was three days
   * ago. Each is listed by what was on their screen when they stopped.
   */
  it('says where the people who stopped coming were last seen', async () => {
    const dropoff = await report.dropoff(ANALYST, 30);

    expect(dropoff.quietDays).toBe(INTERACTION_QUIET_DAYS);
    expect(dropoff.quietUsers).toBe(2);
    expect(dropoff.lastSeen).toEqual([
      { screen: 'bot.notice', wizardKind: null, wizardStep: null, users: 1 },
      { screen: 'bot.wizard', wizardKind: 'EDIT_PROFILE', wizardStep: 'city', users: 1 },
    ]);
  });

  it('lists what was refused, by what was being attempted and why', async () => {
    const dropoff = await report.dropoff(ANALYST, 30);

    expect(dropoff.refusals).toEqual([
      { action: 'ev:join', detail: 'EVENT_FULL', count: 2, users: 1 },
      { action: 'ev:join', detail: 'PROFILE_INCOMPLETE', count: 1, users: 1 },
    ]);
    expect(dropoff.gates).toEqual([{ gate: 'profile', count: 1, users: 1 }]);
    expect(dropoff.stale).toEqual([{ action: 'ad:list', count: 1, users: 1 }]);
    expect(dropoff.failures).toEqual([{ action: 'ev:show', count: 1 }]);
  });

  it('counts text the bot had no use for, and messages it refuses', async () => {
    const dropoff = await report.dropoff(ANALYST, 30);

    expect(dropoff.unclaimedText).toEqual({ count: 2, users: 1 });
    expect(dropoff.unsupported).toEqual({ count: 1, users: 1 });
  });

  /**
   * Reza blocked two minutes after arriving; Sara two days after. Both had the
   * same screen in front of them — a form — which is the finding.
   */
  it('says how soon people blocked the bot, and what they were looking at', async () => {
    const dropoff = await report.dropoff(ANALYST, 30);

    expect(dropoff.blocks).toEqual({
      total: 2,
      withinFiveMinutes: 1,
      withinDay: 1,
      lastScreens: [{ screen: 'bot.wizard', blocks: 2 }],
    });
  });

  it('is refused without dashboard.read', async () => {
    await expect(report.dropoff(NOBODY, 30)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

describe('return', () => {
  /**
   * The denominators are the point. Reza arrived three days ago, so he can be
   * asked "were you back a day later" and cannot yet be asked about a week.
   * Counting him against day seven would make a new sign-up look like a loss.
   */
  it('asks each account only the questions it is old enough to answer', async () => {
    const result = await report.returning(ANALYST, 90);

    expect(result.cohorts.rows).toEqual([
      {
        source: 'CAMPAIGN',
        arrived: 1,
        eligibleDay1: 1,
        returnedDay1: 1,
        eligibleDay7: 1,
        returnedDay7: 1,
        eligibleDay30: 1,
        returnedDay30: 1,
      },
      {
        source: 'DIRECT',
        arrived: 1,
        eligibleDay1: 1,
        returnedDay1: 0,
        eligibleDay7: 0,
        returnedDay7: 0,
        eligibleDay30: 0,
        returnedDay30: 0,
      },
      {
        source: 'EVENT_LINK',
        arrived: 1,
        eligibleDay1: 1,
        returnedDay1: 0,
        eligibleDay7: 1,
        returnedDay7: 0,
        eligibleDay30: 0,
        returnedDay30: 0,
      },
    ]);
    expect(result.cohorts.totals).toEqual({
      arrived: 3,
      eligibleDay1: 3,
      returnedDay1: 1,
      eligibleDay7: 2,
      returnedDay7: 1,
      eligibleDay30: 1,
      returnedDay30: 1,
    });
  });

  /**
   * Two acceptances went out: Ali pressed a button on his, Mina did nothing.
   * The reminder was not pressed, and Ali was in the bot five minutes later
   * anyway — which the reminder may or may not deserve the credit for.
   */
  it('says which messages the product sent were followed by something', async () => {
    const result = await report.returning(ANALYST, 30);

    expect(result.notifications).toEqual([
      {
        templateKey: 'participation.accepted',
        sent: 2,
        recipients: 2,
        tapped: 1,
        followedWithinDay: 1,
      },
      {
        templateKey: 'event.reminder_guest',
        sent: 1,
        recipients: 1,
        tapped: 0,
        followedWithinDay: 1,
      },
    ]);
  });

  it('is refused without dashboard.read', async () => {
    await expect(report.returning(NOBODY, 30)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });
});

describe('staff', () => {
  /**
   * The operator arrived, accepted the terms, was refused, typed something,
   * blocked the bot and was sent a notification — one of everything these
   * reports count. Removing every one of those rows changes nothing.
   */
  it('are in none of the three reports', async () => {
    const before = {
      funnels: await report.funnels(ANALYST, 90),
      dropoff: await report.dropoff(ANALYST, 90),
      returning: await report.returning(ANALYST, 90),
    };

    await prisma.botInteraction.deleteMany({ where: { userId: staff.id } });
    await prisma.notification.deleteMany({ where: { userId: staff.id } });

    expect({
      funnels: await report.funnels(ANALYST, 90),
      dropoff: await report.dropoff(ANALYST, 90),
      returning: await report.returning(ANALYST, 90),
    }).toEqual(before);
  });
});
