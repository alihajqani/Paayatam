import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { SETTING_DEFAULTS, SettingsService } from '../catalog/settings.service';
import { OutboxService } from '../outbox/outbox.service';
import { CoinService } from './coin.service';
import { ComebackService, comebackGrantKey } from './comeback.service';

/**
 * The last thing offered to somebody about to leave
 * (docs/coin-economy-plan.md §3).
 *
 * ── What is under test is the *filter*, not the grant ───────────────────────
 *
 * Paying twenty coins is trivial. What matters is who is excluded, because each
 * of the three conditions removes a different person the grant would be wasted
 * or harmful on:
 *
 *  * Somebody who can still afford an activity — giving to them converts a
 *    would-be buyer into a non-buyer, which is the most expensive mistake this
 *    feature can make.
 *  * Somebody who never attended anything — an account that has told us nothing
 *    about whether it would come back.
 *  * Somebody who no-showed their way to a low trust score — refunding the
 *    discipline would make every penalty provisional.
 *
 * And the fourth property, which is what stops it being a retention loop: the
 * ledger's UNIQUE `idempotency_key` makes "once in a lifetime" structural. There
 * is no counter to reset.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const coins = new CoinService(service, clock);
const comeback = new ComebackService(service, settings, coins, audit, outbox);

const GRANT = SETTING_DEFAULTS['economy.comeback_grant_coins'];
const JOIN_COST = SETTING_DEFAULTS['economy.event_join_coins'];
const MIN_TRUST = SETTING_DEFAULTS['economy.comeback_min_trust'];
const MIN_ATTENDED = SETTING_DEFAULTS['economy.comeback_min_attended_events'];

let fixture: CatalogFixture;

/**
 * An account in exactly the state the grant is for, with each condition
 * separately overridable — so every test below differs from the qualifying case
 * in one dimension and only one.
 */
async function candidate(
  overrides: { balance?: number; attended?: number; trust?: number } = {},
): Promise<string> {
  const balance = overrides.balance ?? 0;
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: balance });
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear: 1995 },
  });

  /**
   * The score written directly, not through `TrustService.apply`.
   *
   * `apply` seeds `trust.initial_score` first and then adds the delta, so asking
   * for a *score* through it means solving for a delta — and at the top of the
   * range the clamp swallows the difference, which is exactly where the "below
   * the bar" case lives. What this suite is about is the sweep's filter reading
   * `trust_score.score`, so the fixture sets that column and says so.
   */
  await prisma.trustScore.upsert({
    where: { userId },
    create: { userId, score: overrides.trust ?? MIN_TRUST },
    update: { score: overrides.trust ?? MIN_TRUST },
  });

  const attended = overrides.attended ?? MIN_ATTENDED;
  for (let index = 0; index < attended; index += 1) {
    const host = await createUser(prisma, 'PROFILE_COMPLETE');
    const event = await prisma.event.create({
      data: {
        hostUserId: host,
        title: 'شب بازی رومیزی',
        description: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
        titleNormalized: 'شب بازی رومیزی',
        descriptionNormalized: 'یک دورهمی دوستانه برای بازی رومیزی و گپ.',
        categoryId: fixture.categoryId,
        cityId: fixture.tehranId,
        startsAt: new Date(NOW.getTime() - 10 * 86_400_000),
        endsAt: new Date(NOW.getTime() - 10 * 86_400_000 + 3_600_000),
        capacity: 5,
        costType: 'FREE',
        status: 'COMPLETED',
        moderationStatus: 'APPROVED',
      },
      select: { id: true },
    });
    await prisma.eventParticipant.create({
      data: { eventId: event.id, userId, status: 'COMPLETED', attended: true },
    });
  }

  return userId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the comeback grant', () => {
  it('pays somebody who attended, behaved, and ran out', async () => {
    const userId = await candidate();

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 1, coins: GRANT });
    await expect(coins.balanceOf(userId)).resolves.toBe(GRANT);
  });

  it('skips somebody who can still afford an activity', async () => {
    // The most expensive mistake this feature can make: converting a would-be
    // buyer into a non-buyer.
    await candidate({ balance: JOIN_COST });

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
  });

  it('skips somebody who has never attended anything', async () => {
    await candidate({ attended: 0 });

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
  });

  it('skips somebody whose trust is below the bar', async () => {
    // Refunding the discipline would make every penalty provisional.
    await candidate({ trust: MIN_TRUST - 1 });

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
  });

  it('skips an account that is not active', async () => {
    const userId = await candidate();
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } });

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
  });

  /** The property that stops this being a retention loop. */
  it('is once in a lifetime, however many nights the sweep runs', async () => {
    const userId = await candidate();

    await comeback.sweep();
    // Spend it all, so every condition qualifies again.
    await coins.apply({
      userId,
      amount: -GRANT,
      type: 'EVENT_JOIN_SPEND',
      reasonCode: 'test.spend',
      idempotencyKey: `test-spend:${userId}`,
      actorType: 'USER',
    });

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
    await expect(coins.balanceOf(userId)).resolves.toBe(0);
    await expect(
      prisma.coinLedger.count({ where: { idempotencyKey: comebackGrantKey(userId) } }),
    ).resolves.toBe(1);
  });

  it('tells them, in the transaction that pays', async () => {
    const userId = await candidate();

    await comeback.sweep();

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: 'economy.comeback_granted', aggregateId: userId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ coins: GRANT });
    // Public ids only (invariant 7).
    expect(JSON.stringify(events[0]?.payload)).not.toContain(userId);
  });

  it('does nothing when switched off', async () => {
    await prisma.appSetting.create({ data: { key: 'economy.comeback_grant_coins', value: 0 } });
    const userId = await candidate();

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
    await expect(coins.balanceOf(userId)).resolves.toBe(0);
  });

  it('does nothing when joining is free', async () => {
    // With no price, "cannot afford an activity" is not a state anybody is in —
    // and without this guard every dormant account would qualify at once.
    await prisma.appSetting.create({ data: { key: 'economy.event_join_coins', value: 0 } });
    await candidate();

    await expect(comeback.sweep()).resolves.toMatchObject({ granted: 0 });
  });
});
