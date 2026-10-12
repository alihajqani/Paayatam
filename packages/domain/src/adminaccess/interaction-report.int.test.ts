import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import { ErrorCode } from '@payetam/shared';
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
import { InteractionReportService, TIMELINE_PAGE_SIZE } from './interaction-report.service';
import { ROLE_KEYS } from './permissions';

/**
 * The «رفتار کاربران» reports, against real rows (migration 0065).
 *
 * A database rather than a unit test for the reason the acquisition report
 * has one: everything worth asserting is a property of the queries. That a
 * visit is cut at a thirty-minute gap, that a day is a Tehran day, that staff
 * are in no total, that a link counts the members who followed it and not only
 * the accounts it created — none of that survives being mocked.
 *
 * Rows are inserted directly. How they come to be written is
 * `interaction-tracking.int.test.ts`'s subject; this one is about reading them.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

/** 15:30 in Tehran, so "ten hours ago" is still the same Tehran day. */
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
const report = new InteractionReportService(service, clock, access, {
  APP_TIMEZONE: 'Asia/Tehran',
} as Env);

function session(role: keyof typeof ROLE_KEYS): AdminSession {
  return {
    adminUserId: `admin-${role}`,
    email: `${role}@payetam.test`,
    displayName: role,
    roles: [ROLE_KEYS[role]],
    permissions: permissionsFor([ROLE_KEYS[role]]),
  };
}

const ANALYST = session('ANALYST');
const SUPER_ADMIN = session('SUPER_ADMIN');
const NOBODY: AdminSession = { ...ANALYST, roles: [], permissions: [] };

let fixture: CatalogFixture;
let updateId = 0n;
let telegramId = 910_000_000n;

let ali: { id: string; publicId: string };
let sara: { id: string; publicId: string };
let staff: { id: string; publicId: string };
let eventPublicId: string;

async function member(): Promise<{ id: string; publicId: string; telegramUserId: bigint }> {
  telegramId += 1n;
  const user = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: telegramId } },
    },
    select: { id: true, publicId: true },
  });
  return { ...user, telegramUserId: telegramId };
}

async function linkAsAdmin(telegramUserId: bigint): Promise<void> {
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
    data: { adminUserId: admin.id, telegramUserId, grantedById: admin.id, reason: 'test fixture' },
  });
}

interface Seen {
  kind?: 'START' | 'COMMAND' | 'CALLBACK' | 'KEYBOARD' | 'TEXT' | 'BLOCKED';
  ref?: string | null;
  createdAccount?: boolean;
  outcome?: 'OK' | 'REFUSED' | 'GATED' | 'STALE' | 'FAILED' | 'NO_ACCOUNT';
  detail?: string | null;
  durationMs?: number;
}

/** One recorded interaction, `minutesAgo` before the clock's now. */
async function seen(
  userId: string | null,
  action: string,
  minutesAgo: number,
  extra: Seen = {},
): Promise<void> {
  updateId += 1n;
  await prisma.botInteraction.create({
    data: {
      updateId,
      userId,
      kind: extra.kind ?? 'CALLBACK',
      action,
      ref: extra.ref ?? null,
      createdAccount: extra.createdAccount ?? false,
      outcome: extra.outcome ?? 'OK',
      detail: extra.detail ?? null,
      durationMs: extra.durationMs ?? 0,
      createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    },
  });
}

const DAY = 24 * 60;

/**
 * The story every report below reads.
 *
 * Ali arrived from an ad this morning, accepted the terms and opened the list;
 * came back in the afternoon, opened an event and was refused three times.
 * Sara arrived from a channel post two days ago and did nothing; today she
 * followed the same post again and then blocked the bot. A tap arrived from
 * somebody with no account. And the operator, who is linked as a moderator,
 * pressed a few things while testing — which no total may count.
 */
async function tellTheStory(): Promise<void> {
  await seen(ali.id, 'start:campaign', 600, {
    kind: 'START',
    ref: 'tgads_1',
    createdAccount: true,
  });
  await seen(ali.id, 'wz:agree', 598);
  await seen(ali.id, 'kb:discover', 595, { kind: 'KEYBOARD' });

  await seen(ali.id, 'ev:show', 100, { ref: eventPublicId });
  await seen(ali.id, 'ev:join', 99, {
    ref: eventPublicId,
    outcome: 'REFUSED',
    detail: 'EVENT_FULL',
    durationMs: 10,
  });
  await seen(ali.id, 'ev:join', 98, {
    ref: eventPublicId,
    outcome: 'REFUSED',
    detail: 'EVENT_FULL',
    durationMs: 20,
  });
  await seen(ali.id, 'ev:join', 97, {
    ref: eventPublicId,
    outcome: 'REFUSED',
    detail: 'PROFILE_INCOMPLETE',
    durationMs: 30,
  });

  await seen(sara.id, 'start:event', 2 * DAY, {
    kind: 'START',
    ref: eventPublicId,
    createdAccount: true,
  });
  await seen(sara.id, 'start:event', 50, { kind: 'START', ref: eventPublicId });
  await seen(sara.id, 'blocked', 49, { kind: 'BLOCKED' });

  await seen(null, 'ev:show', 20, { ref: eventPublicId, outcome: 'NO_ACCOUNT' });

  await seen(staff.id, 'ev:show', 30, { ref: eventPublicId });
  await seen(staff.id, 'start:campaign', 29, { kind: 'START', ref: 'tgads_1' });

  // Outside a 30-day window, inside a 90-day one.
  await seen(ali.id, 'cmd:help', 40 * DAY, { kind: 'COMMAND' });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  ali = await member();
  sara = await member();
  const operator = await member();
  staff = operator;
  await linkAsAdmin(operator.telegramUserId);

  const event = await prisma.event.create({
    data: {
      hostUserId: ali.id,
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
    select: { publicId: true },
  });
  eventPublicId = event.publicId;

  await tellTheStory();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('overview', () => {
  it('counts what people did, the people, and their visits', async () => {
    const overview = await report.overview(ANALYST, 30);

    expect(overview.windowDays).toBe(30);
    expect(overview.since).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
    expect(overview.totals).toEqual({
      // Ali's seven, Sara's two `/start`s and the tap from nobody. Not the block,
      // which is something that happened to the bot rather than something done in it.
      interactions: 10,
      activeUsers: 2,
      // Ali's morning and afternoon; Sara two days ago and today.
      sessions: 4,
      // Nine attributed interactions over four visits.
      stepsPerSession: 2.3,
      newAccounts: 2,
      // Sara: two `/start`s and nothing else, ever.
      newAccountsSilent: 1,
    });
  });

  it('says when tracking began, whatever the window', async () => {
    const overview = await report.overview(ANALYST, 7);
    expect(overview.trackingSince).toEqual(new Date(NOW.getTime() - 40 * DAY * 60_000));
  });

  /** A day is a Tehran day and an hour is a Tehran hour: 12:00 UTC is 15:30 there. */
  it('buckets days and hours in Tehran time', async () => {
    const overview = await report.overview(ANALYST, 30);

    expect(overview.byDay).toEqual([
      { day: '2026-10-08', interactions: 1, activeUsers: 1 },
      { day: '2026-10-10', interactions: 9, activeUsers: 2 },
    ]);
    // Ali's morning: 02:00–02:05 UTC, which is half past five in Tehran.
    expect(overview.byHour).toContainEqual({ hour: 5, interactions: 3 });
  });

  it('breaks the window down by kind and by how the bot answered', async () => {
    const overview = await report.overview(ANALYST, 30);

    expect(overview.byKind).toEqual(
      expect.arrayContaining([
        { kind: 'START', interactions: 3, users: 2 },
        { kind: 'CALLBACK', interactions: 6, users: 1 },
        { kind: 'KEYBOARD', interactions: 1, users: 1 },
        { kind: 'BLOCKED', interactions: 1, users: 1 },
      ]),
    );
    expect(overview.byKind).toHaveLength(4);
    expect(overview.byOutcome).toEqual(
      expect.arrayContaining([
        { outcome: 'OK', interactions: 6 },
        { outcome: 'REFUSED', interactions: 3 },
        { outcome: 'NO_ACCOUNT', interactions: 1 },
      ]),
    );
    expect(overview.byOutcome).toHaveLength(3);
  });

  it('widens with the window', async () => {
    const overview = await report.overview(ANALYST, 90);
    expect(overview.totals.interactions).toBe(11);
    expect(overview.totals.sessions).toBe(5);
  });

  /**
   * At this size the operator testing a release is a visible share of all
   * traffic. Their rows are written and are in no total.
   */
  it('counts no staff member in any number', async () => {
    const before = await report.overview(ANALYST, 30);
    await seen(staff.id, 'ev:join', 5, { outcome: 'REFUSED', detail: 'EVENT_FULL' });
    await seen(staff.id, 'start:direct', 4, { kind: 'START', createdAccount: true });

    expect(await report.overview(ANALYST, 30)).toEqual(before);
  });

  it('is refused without dashboard.read', async () => {
    await expect(report.overview(NOBODY, 30)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });
});

describe('links', () => {
  /**
   * `user_acquisition` would show this post as one account. It was followed
   * twice — and the second time by somebody who already had one, which is the
   * reader a channel post is mostly written for.
   */
  it('counts every time a link was followed, new people and members apart', async () => {
    const links = await report.links(ANALYST, 30);

    expect(links.rows).toEqual([
      {
        action: 'start:event',
        ref: eventPublicId,
        title: 'دورهمی بازی',
        taps: 2,
        users: 1,
        newAccounts: 1,
        returningUsers: 1,
      },
      {
        action: 'start:campaign',
        ref: 'tgads_1',
        title: null,
        taps: 1,
        users: 1,
        newAccounts: 1,
        returningUsers: 0,
      },
    ]);
    expect(links.omittedRows).toBe(0);
  });

  it('is refused without dashboard.read', async () => {
    await expect(report.links(NOBODY, 30)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

describe('actions', () => {
  it('ranks what was pressed, with how often it was refused and why', async () => {
    const actions = await report.actions(ANALYST, 30);

    expect(actions.rows.map((row) => `${row.action}=${String(row.count)}`)).toEqual([
      'ev:join=3',
      'ev:show=2',
      'start:event=2',
      'kb:discover=1',
      'start:campaign=1',
      'wz:agree=1',
    ]);
    expect(actions.rows[0]).toEqual({
      kind: 'CALLBACK',
      action: 'ev:join',
      count: 3,
      users: 1,
      refused: 3,
      gated: 0,
      stale: 0,
      failed: 0,
      topRefusal: 'EVENT_FULL',
      averageMs: 20,
    });
  });

  /** A block is not a button, and is not ranked among them. */
  it('leaves blocks out', async () => {
    const actions = await report.actions(ANALYST, 30);
    expect(actions.rows.map((row) => row.action)).not.toContain('blocked');
  });

  it('is refused without dashboard.read', async () => {
    await expect(report.actions(NOBODY, 30)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});

describe('one person’s trail', () => {
  it('lists what they did, newest first, however old', async () => {
    const trail = await report.timeline(SUPER_ADMIN, ali.publicId);

    expect(trail.items.map((item) => item.action)).toEqual([
      'ev:join',
      'ev:join',
      'ev:join',
      'ev:show',
      'kb:discover',
      'wz:agree',
      'start:campaign',
      'cmd:help',
    ]);
    expect(trail.items[0]).toMatchObject({
      kind: 'CALLBACK',
      ref: eventPublicId,
      outcome: 'REFUSED',
      detail: 'PROFILE_INCOMPLETE',
      durationMs: 30,
      at: new Date(NOW.getTime() - 97 * 60_000),
    });
    expect(trail.nextBefore).toBeNull();
  });

  it('pages by time', async () => {
    const busy = await member();
    for (let minute = 1; minute <= TIMELINE_PAGE_SIZE + 2; minute += 1) {
      await seen(busy.id, 'ev:show', minute);
    }

    const first = await report.timeline(SUPER_ADMIN, busy.publicId);
    expect(first.items).toHaveLength(TIMELINE_PAGE_SIZE);
    expect(first.nextBefore).toEqual(new Date(NOW.getTime() - TIMELINE_PAGE_SIZE * 60_000));

    const second = await report.timeline(SUPER_ADMIN, busy.publicId, first.nextBefore ?? undefined);
    expect(second.items).toHaveLength(2);
    expect(second.nextBefore).toBeNull();
  });

  /** A staff member is in no total, and their own trail is still theirs to read. */
  it('still shows a staff member’s own trail', async () => {
    const trail = await report.timeline(SUPER_ADMIN, staff.publicId);
    expect(trail.items).toHaveLength(2);
  });

  /**
   * Aggregates are what ADR-0010 gives `ANALYST`. One person's trail is a list
   * about a person, and needs the permission the rest of their file needs.
   */
  it('is refused to a role that only reads aggregates', async () => {
    await expect(report.timeline(ANALYST, ali.publicId)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('does not exist for somebody who does not', async () => {
    await expect(
      report.timeline(SUPER_ADMIN, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
