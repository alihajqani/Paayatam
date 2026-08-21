import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { CoinService } from '../economy/coin.service';
import { normalize } from '../moderation/persian-normalizer';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { AdminInsightService } from './admin-insight.service';
import { ROLE_KEYS } from './permissions';

/**
 * The panel's read surface, against a real database (M19).
 *
 * What is worth asserting here is not that a count is a count. It is the three
 * things a read surface gets wrong in ways nobody notices:
 *
 *  - **what it projects** — the temptation on a user-detail screen is always one
 *    relation further, and `telegram_account` is one relation away;
 *  - **who may read it** — `ANALYST` holds `dashboard.read` and nothing else, and
 *    a read that forgot `assertPermission` looks identical to one that has it;
 *  - **how it scales** — every list here is bounded and every roll-up is a
 *    grouped query, and the difference only shows up in production.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-21T09:00:00.000Z');
const clock = new FakeClock(NOW);

const audit = new AuditService(service, clock);
const coins = new CoinService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const insight = new AdminInsightService(service, clock, access);

let fixture: CatalogFixture;
let SUPER: AdminSession;
let ANALYST: AdminSession;

const LEAKY_PHONE = '+989121234567';
const LEAKY_HANDLE = '@leaky_admin_handle';

function sessionFor(role: keyof typeof ROLE_KEYS): AdminSession {
  return {
    adminUserId: `insight-${role}`,
    email: `${role.toLowerCase()}@payetam.test`,
    displayName: role,
    roles: [ROLE_KEYS[role]],
    permissions: permissionsFor([ROLE_KEYS[role]]),
  };
}

async function seedUser(
  displayName: string,
  options: { bio?: string; status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED' } = {},
): Promise<{ id: string; publicId: string }> {
  const id = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId: id,
      displayName,
      cityId: fixture.tehranId,
      birthYear: 1995,
      ...(options.bio !== undefined ? { bio: options.bio } : {}),
    },
  });
  if (options.status !== undefined) {
    await prisma.user.update({ where: { id }, data: { status: options.status } });
  }
  const { publicId } = await prisma.user.findUniqueOrThrow({
    where: { id },
    select: { publicId: true },
  });
  return { id, publicId };
}

async function seedEvent(hostUserId: string, title: string): Promise<string> {
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';
  const startsAt = new Date(NOW.getTime() + 9 * 86_400_000);
  const row = await prisma.event.create({
    data: {
      hostUserId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return row.publicId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  SUPER = sessionFor('SUPER_ADMIN');
  ANALYST = sessionFor('ANALYST');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the dashboard', () => {
  it('rolls up every axis a shift starts by looking at', async () => {
    const host = await seedUser('میزبان');
    await seedUser('مسدود', { status: 'BANNED' });
    await seedEvent(host.id, 'شب بازی رومیزی');
    await coins.apply({
      userId: host.id,
      amount: 50,
      type: 'ONBOARDING_REWARD',
      reasonCode: 'onboarding',
      idempotencyKey: 'dash-1',
      actorType: 'SYSTEM',
    });
    await coins.apply({
      userId: host.id,
      amount: -40,
      type: 'BOOST_SPEND',
      reasonCode: 'boost',
      idempotencyKey: 'dash-2',
      actorType: 'USER',
    });

    const dashboard = await insight.dashboard(SUPER);

    expect(dashboard.users.total).toBe(2);
    expect(dashboard.users.byStatus).toEqual({ ACTIVE: 1, BANNED: 1 });
    expect(dashboard.events.byStatus).toEqual({ PUBLISHED: 1 });
    expect(dashboard.economy.coinsHeld).toBe(10);
    expect(dashboard.economy.coinsGranted).toBe(50);
    // Stored signed, reported as a magnitude: «۴۰ سکه خرج شد» reads, «−۴۰» does not.
    expect(dashboard.economy.coinsSpent).toBe(40);
    expect(dashboard.moderationBacklog.oldestOpenCaseAt).toBeNull();
  });

  /**
   * A sparse tally, not a dense one. A status with no rows is absent rather than
   * zero, so the panel can tell "nobody is waitlisted" from "this deployment has
   * no waitlist" — and inventing zeros would remove that distinction for good.
   */
  it('leaves out the statuses nothing is in', async () => {
    const dashboard = await insight.dashboard(SUPER);

    expect(dashboard.users.byStatus).toEqual({});
    expect(dashboard.events.byStatus).toEqual({});
    expect(dashboard.chats.byStatus).toEqual({});
  });

  /**
   * ADR-0010's line, enforced: *"`ANALYST` gets `dashboard.read` and nothing
   * else, because read-only aggregates means aggregates, not a licence to read
   * every user record."*
   */
  it('is the only thing an ANALYST can read', async () => {
    await expect(insight.dashboard(ANALYST)).resolves.toBeDefined();

    for (const call of [
      () => insight.listUsers(ANALYST),
      () => insight.listEvents(ANALYST),
      () => insight.listReports(ANALYST),
      () => insight.searchLedger(ANALYST),
      () => insight.listAudit(ANALYST),
      () => insight.reconcile(ANALYST),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});

describe('finding a user', () => {
  it('matches a display name however it was typed', async () => {
    await seedUser('علی رضایی');

    // «علي» with an Arabic yeh — what a keyboard produces and what ADR-0012's
    // pipeline folds. The admin surface must not be the one search in the
    // product where Persian does not work.
    await expect(insight.listUsers(SUPER, { query: 'علي' })).resolves.toMatchObject({ total: 1 });
    await expect(insight.listUsers(SUPER, { query: 'رضایی' })).resolves.toMatchObject({ total: 1 });
  });

  it('matches a public id pasted straight from a report', async () => {
    const user = await seedUser('علی رضایی');
    await seedUser('کس دیگر');

    const page = await insight.listUsers(SUPER, { query: user.publicId });

    expect(page.total).toBe(1);
    expect(page.rows[0]?.publicId).toBe(user.publicId);
  });

  it('filters by account status and reports the total behind the page', async () => {
    await seedUser('یک', { status: 'BANNED' });
    await seedUser('دو', { status: 'BANNED' });
    await seedUser('سه');

    const page = await insight.listUsers(SUPER, { status: 'BANNED', limit: 1 });

    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it('reports a never-judged account as null rather than as zero', async () => {
    await seedUser('تازه‌وارد');

    const page = await insight.listUsers(SUPER);

    // ADR-0014: `trust_score` is written lazily, so 0 would be the worst possible
    // reputation shown to somebody who has done nothing wrong. A *balance* is
    // genuinely zero in the same situation.
    expect(page.rows[0]?.trustScore).toBeNull();
    expect(page.rows[0]?.coinBalance).toBe(0);
  });
});

describe('one user, in detail', () => {
  it('answers every question a support conversation asks', async () => {
    const user = await seedUser('کاربر');
    const host = await seedUser('میزبان');
    await seedEvent(user.id, 'رویداد خودش');
    const eventPublicId = await seedEvent(host.id, 'رویداد دیگری');
    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { id: true },
    });
    await prisma.eventParticipant.create({
      data: { eventId: event.id, userId: user.id, status: 'COMPLETED', requestedAt: NOW },
    });
    await coins.apply({
      userId: user.id,
      amount: 50,
      type: 'ONBOARDING_REWARD',
      reasonCode: 'onboarding',
      idempotencyKey: 'detail-1',
      actorType: 'SYSTEM',
    });

    const detail = await insight.getUser(SUPER, user.publicId);

    expect(detail).toMatchObject({
      displayName: 'کاربر',
      coinBalance: 50,
      cityNameFa: 'تهران',
      events: { hosted: 1, published: 1 },
      participations: { COMPLETED: 1 },
      reportsAgainst: 0,
    });
    expect(detail.coins).toMatchObject({ granted: 50, spent: 0, entries: 1 });
  });

  /**
   * The leak scan found this the day the screen was added, and it is worth a test
   * of its own: a user who typed their number into their bio has not consented to
   * hand it to staff, and the bio reaches no other user anywhere in the product —
   * so an unmasked one here would be the only place those digits are projected.
   */
  it('masks contact details in the bio', async () => {
    const user = await seedUser('کاربر', {
      bio: `برای هماهنگی ${LEAKY_PHONE} یا ${LEAKY_HANDLE}`,
    });

    const detail = await insight.getUser(SUPER, user.publicId);

    expect(detail.bio).not.toContain(LEAKY_PHONE);
    expect(detail.bio).not.toContain(LEAKY_HANDLE);
    expect(detail.bio).toContain('«حذف شد»');
    // And it says that it happened, so a moderator is not left guessing whether
    // the bio was empty or was masked.
    expect(detail.bioRedactions).toBe(2);
  });

  it('reaches nothing in telegram_account, whatever is on the row', async () => {
    const user = await seedUser('کاربر');
    await prisma.telegramAccount.update({
      where: { userId: user.id },
      data: { usernameCached: 'leaky_handle', firstNameCached: 'Leaky' },
    });

    const detail = await insight.getUser(SUPER, user.publicId);

    const rendered = JSON.stringify(detail);
    expect(rendered).not.toContain('leaky_handle');
    expect(rendered).not.toContain('telegram');
  });

  it('refuses a user who does not exist', async () => {
    await expect(
      insight.getUser(SUPER, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('events and reports', () => {
  it('searches events through the same normalization discovery uses', async () => {
    const host = await seedUser('میزبان');
    await seedEvent(host.id, 'شب بازی رومیزی');

    await expect(insight.listEvents(SUPER, { query: 'بازي' })).resolves.toMatchObject({
      total: 1,
    });
  });

  it('counts open reports per event in one query, not one per row', async () => {
    const host = await seedUser('میزبان');
    const reporter = await seedUser('گزارش‌دهنده');
    const publicId = await seedEvent(host.id, 'شب بازی رومیزی');
    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId },
      select: { id: true },
    });
    await prisma.report.create({
      data: {
        targetType: 'EVENT',
        targetId: event.id,
        reporterUserId: reporter.id,
        reason: 'SPAM',
        status: 'OPEN',
      },
    });

    const page = await insight.listEvents(SUPER);

    expect(page.rows[0]).toMatchObject({ reportCount: 1, hostDisplayName: 'میزبان' });
  });

  it('works the report queue oldest first', async () => {
    const reporter = await seedUser('گزارش‌دهنده');
    const second = await seedUser('دیگری');
    await prisma.report.create({
      data: {
        targetType: 'USER',
        targetId: second.id,
        reporterUserId: reporter.id,
        reason: 'HARASSMENT',
        status: 'OPEN',
        createdAt: new Date(NOW.getTime() - 3_600_000),
      },
    });
    await prisma.report.create({
      data: {
        targetType: 'USER',
        targetId: reporter.id,
        reporterUserId: second.id,
        reason: 'SPAM',
        status: 'OPEN',
        createdAt: NOW,
      },
    });

    const page = await insight.listReports(SUPER);

    // A queue nobody works from the bottom.
    expect(page.rows.map((row) => row.reason)).toEqual(['HARASSMENT', 'SPAM']);
    expect(page.rows[0]?.reporterPublicId).toBe(reporter.publicId);
  });
});

describe('the ledger', () => {
  it('filters, pages, and reports the net over the whole filter', async () => {
    const user = await seedUser('کاربر');
    for (const [index, amount] of [50, -40, 30].entries()) {
      await coins.apply({
        userId: user.id,
        amount,
        type: amount > 0 ? 'ONBOARDING_REWARD' : 'BOOST_SPEND',
        reasonCode: 'test',
        idempotencyKey: `ledger-${String(index)}`,
        actorType: 'SYSTEM',
      });
    }

    const page = await insight.searchLedger(SUPER, { userPublicId: user.publicId, limit: 2 });

    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    // The net is over the filter, not the page: "what did this cost us?" is a
    // question about every matching row.
    expect(page.net).toBe(40);
  });

  it('matches nothing for a user who does not exist', async () => {
    await expect(
      insight.searchLedger(SUPER, { userPublicId: '00000000-0000-4000-8000-000000000000' }),
    ).resolves.toEqual({ rows: [], total: 0, net: 0 });
  });

  /**
   * ADR-0007's invariant asked of the live database rather than of a fixture.
   * The healthy answer is an empty array, and the useful answer names the
   * accounts — "reconciliation failed" is not something anybody can act on.
   */
  it('reconciles every account against its ledger', async () => {
    const user = await seedUser('کاربر');
    await coins.apply({
      userId: user.id,
      amount: 50,
      type: 'ONBOARDING_REWARD',
      reasonCode: 'onboarding',
      idempotencyKey: 'recon-1',
      actorType: 'SYSTEM',
    });

    await expect(insight.reconcile(SUPER)).resolves.toEqual({ accounts: 1, drifted: [] });
  });

  it('names the account when a balance and its ledger disagree', async () => {
    const user = await seedUser('کاربر');
    await coins.apply({
      userId: user.id,
      amount: 50,
      type: 'ONBOARDING_REWARD',
      reasonCode: 'onboarding',
      idempotencyKey: 'recon-2',
      actorType: 'SYSTEM',
    });
    // Only reachable by writing the cache directly, which nothing in the product
    // does — which is exactly why the check has to be able to find it.
    await prisma.coinAccount.update({ where: { userId: user.id }, data: { balance: 99 } });

    const result = await insight.reconcile(SUPER);

    expect(result.drifted).toEqual([{ userPublicId: user.publicId, balance: 99, ledger: 50 }]);
  });
});

describe('the audit viewer', () => {
  it('filters by action prefix, so a family is one query', async () => {
    await audit.record({
      actorType: 'ADMIN',
      action: 'giftcode.created',
      targetType: 'gift_code',
      targetId: 'a',
    });
    await audit.record({
      actorType: 'ADMIN',
      action: 'giftcode.disabled',
      targetType: 'gift_code',
      targetId: 'a',
    });
    await audit.record({
      actorType: 'ADMIN',
      action: 'coin.adjusted',
      targetType: 'user',
      targetId: 'b',
    });

    const page = await insight.listAudit(SUPER, { action: 'giftcode.' });

    expect(page.total).toBe(2);
    expect(page.rows.every((row) => row.action.startsWith('giftcode.'))).toBe(true);
  });

  it('is newest first, bounded, and reports its total', async () => {
    for (let index = 0; index < 5; index += 1) {
      clock.advance(1000);
      await audit.record({
        actorType: 'SYSTEM',
        action: `test.${String(index)}`,
        targetType: 'thing',
      });
    }

    const page = await insight.listAudit(SUPER, { limit: 2 });

    expect(page.rows.map((row) => row.action)).toEqual(['test.4', 'test.3']);
    expect(page.total).toBe(5);
  });

  it('carries the payloads, which are an allowlist at every call site', async () => {
    await audit.record({
      actorType: 'ADMIN',
      action: 'setting.changed',
      targetType: 'app_setting',
      targetId: 'economy.boost_coins',
      before: { value: 40 },
      after: { value: 45, reason: 'campaign' },
    });

    const page = await insight.listAudit(SUPER, { targetType: 'app_setting' });

    expect(page.rows[0]?.before).toEqual({ value: 40 });
    expect(page.rows[0]?.after).toMatchObject({ value: 45 });
  });
});
