import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient, type PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { normalize } from '../moderation/persian-normalizer';
import { CoinService } from './coin.service';
import { ReferralService, normalizeCode } from './referral.service';

/**
 * Referrals against a real database.
 *
 * The property the whole feature turns on is **when the reward is paid**. Paying
 * on signup is what a farm wants — accounts are free, so rewarding one rewards
 * making them in bulk. Plan §11 pays after the referred user attends an event,
 * and the tests below are mostly about that condition holding under every order
 * of events somebody might arrive in.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);

const settings = new SettingsService(service);
const coins = new CoinService(service, clock);
const audit = new AuditService(service, clock);
const referrals = new ReferralService(service, clock, settings, coins, audit);

let fixture: CatalogFixture;
let referrer: string;
let referred: string;

/** An attended event for `userId`, which is what qualifies a referral. */
async function attendAnEvent(userId: string): Promise<void> {
  const host = await createUser(prisma, 'PROFILE_COMPLETE');
  const title = 'دورهمی بازی رومیزی';
  const description = 'یک شب دوستانه برای بازی و گفتگو.';
  const startsAt = new Date(NOW.getTime() - 7 * 24 * 3_600_000);

  const event = await prisma.event.create({
    data: {
      hostUserId: host,
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
      status: 'COMPLETED',
      moderationStatus: 'APPROVED',
    },
    select: { id: true },
  });

  await prisma.eventParticipant.create({
    data: {
      eventId: event.id,
      userId,
      status: 'COMPLETED',
      acceptedAt: startsAt,
      attended: true,
    },
  });
}

async function codeOf(userId: string): Promise<string> {
  return (await referrals.summaryFor(userId)).code;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  referrer = await createUser(prisma, 'PROFILE_COMPLETE');
  referred = await createUser(prisma, 'PROFILE_COMPLETE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the invite code', () => {
  it('is generated on first read and stays the same afterwards', async () => {
    const first = await codeOf(referrer);
    const second = await codeOf(referrer);

    expect(first).toBe(second);
    expect(first).toHaveLength(8);
  });

  /**
   * A code is read off one screen and typed into another, often by somebody who
   * did not choose it. `0/O` and `1/I/L` are the pairs people get wrong.
   */
  it('avoids the characters people misread', async () => {
    const codes = await Promise.all(
      Array.from({ length: 20 }, async () => codeOf(await createUser(prisma))),
    );

    for (const code of codes) {
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
    expect(new Set(codes).size).toBe(20);
  });

  it('is not created for a user who never asks for one', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: referrer } });
    expect(user.referralCode).toBeNull();
  });
});

describe('claiming', () => {
  it('records the relationship and pays nothing yet', async () => {
    const code = await codeOf(referrer);

    const claim = await referrals.claim(referred, code);

    expect(claim).toEqual({ status: 'PENDING', pendingCoins: 10 });
    expect(await coins.balanceOf(referrer)).toBe(0);
    expect(await coins.balanceOf(referred)).toBe(0);
  });

  it('accepts a code however it was retyped', async () => {
    const code = await codeOf(referrer);
    const mangled = `  ${code.toLowerCase().slice(0, 4)}-${code.toLowerCase().slice(4)}  `;

    expect(normalizeCode(mangled)).toBe(code);
    await expect(referrals.claim(referred, mangled)).resolves.toMatchObject({ status: 'PENDING' });
  });

  /**
   * The cheapest fraud control there is, and it is stated twice: here, and as a
   * CHECK constraint, so removing the service check does not quietly enable it.
   */
  it('refuses a self-referral', async () => {
    const code = await codeOf(referrer);

    await expect(referrals.claim(referrer, code)).rejects.toMatchObject({
      code: 'SELF_REFERRAL',
    });
  });

  it('refuses a self-referral at the database too, service check or not', async () => {
    await expect(
      prisma.referral.create({
        data: { referrerUserId: referrer, referredUserId: referrer, code: 'ABCD1234' },
      }),
    ).rejects.toThrow(/referral_not_self/);
  });

  it('refuses an unknown code', async () => {
    await expect(referrals.claim(referred, 'ZZZZZZZZ')).rejects.toMatchObject({
      code: 'INVALID_REFERRAL_CODE',
    });
  });

  /** Same answer as an unknown code: this endpoint is not an oracle. */
  it('refuses a banned referrer without saying which problem it was', async () => {
    const code = await codeOf(referrer);
    await prisma.user.update({ where: { id: referrer }, data: { status: 'BANNED' } });

    await expect(referrals.claim(referred, code)).rejects.toMatchObject({
      code: 'INVALID_REFERRAL_CODE',
    });
  });

  it('gives a person one referrer, for life', async () => {
    const other = await createUser(prisma, 'PROFILE_COMPLETE');
    await referrals.claim(referred, await codeOf(referrer));

    await expect(referrals.claim(referred, await codeOf(other))).rejects.toMatchObject({
      code: 'ALREADY_REFERRED',
    });
    expect(await prisma.referral.count({ where: { referredUserId: referred } })).toBe(1);
  });

  /**
   * The UNIQUE index deciding rather than a read this code did a moment earlier.
   * A read-then-write would have a window between the two; this has none.
   */
  it('lets exactly one of five simultaneous claims win', async () => {
    const codes = await Promise.all(
      Array.from({ length: 5 }, async () => codeOf(await createUser(prisma, 'PROFILE_COMPLETE'))),
    );

    const results = await Promise.allSettled(codes.map((code) => referrals.claim(referred, code)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.referral.count({ where: { referredUserId: referred } })).toBe(1);
  });
});

describe('the reward requires attendance', () => {
  it('pays nothing while the referred user has not attended anything', async () => {
    await referrals.claim(referred, await codeOf(referrer));

    expect(await referrals.qualifyForAttendance(referred)).toBe(false);
    expect(await coins.balanceOf(referrer)).toBe(0);
  });

  /**
   * A request that was made but never completed is not attendance. Otherwise the
   * cheapest farm is one that joins and cancels.
   */
  it('does not count a request that never completed', async () => {
    await referrals.claim(referred, await codeOf(referrer));

    const host = await createUser(prisma, 'PROFILE_COMPLETE');
    const title = 'دورهمی';
    const event = await prisma.event.create({
      data: {
        hostUserId: host,
        title,
        description: 'توضیح کافی برای ساخت رویداد آزمایشی.',
        titleNormalized: normalize(title),
        descriptionNormalized: normalize('توضیح'),
        categoryId: fixture.categoryId,
        cityId: fixture.tehranId,
        startsAt: new Date(NOW.getTime() + 3_600_000),
        endsAt: new Date(NOW.getTime() + 4 * 3_600_000),
        capacity: 5,
        costType: 'FREE',
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        publishedAt: NOW,
      },
      select: { id: true },
    });
    await prisma.eventParticipant.create({
      data: { eventId: event.id, userId: referred, status: 'ACCEPTED', acceptedAt: NOW },
    });

    expect(await referrals.qualifyForAttendance(referred)).toBe(false);
    expect(await coins.balanceOf(referrer)).toBe(0);
  });

  it('pays both sides once the referred user has attended', async () => {
    await referrals.claim(referred, await codeOf(referrer));
    await attendAnEvent(referred);

    expect(await referrals.qualifyForAttendance(referred)).toBe(true);

    expect(await coins.balanceOf(referrer)).toBe(30);
    expect(await coins.balanceOf(referred)).toBe(10);

    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredUserId: referred },
    });
    expect(referral).toMatchObject({ status: 'QUALIFIED', qualifiedAt: NOW });
    expect(referral.rewardLedgerId).not.toBeNull();
  });

  /**
   * Somebody who joined first and found the invite link afterwards. The condition
   * is "has attended", not "attends next", so it settles at once rather than
   * waiting for an attendance that already happened and will not repeat.
   */
  it('settles immediately when the claim comes after the attendance', async () => {
    await attendAnEvent(referred);

    const claim = await referrals.claim(referred, await codeOf(referrer));

    expect(claim).toEqual({ status: 'QUALIFIED', pendingCoins: 0 });
    expect(await coins.balanceOf(referrer)).toBe(30);
  });

  it('pays once, however many times qualification is attempted', async () => {
    await referrals.claim(referred, await codeOf(referrer));
    await attendAnEvent(referred);

    expect(await referrals.qualifyForAttendance(referred)).toBe(true);
    expect(await referrals.qualifyForAttendance(referred)).toBe(false);
    expect(await referrals.qualifyForAttendance(referred)).toBe(false);

    expect(await coins.balanceOf(referrer)).toBe(30);
    expect(await prisma.coinLedger.count({ where: { type: 'REFERRAL_REWARD' } })).toBe(2);
  });

  /** Two attendance settlements landing together must not both decide they won. */
  it('pays once under 10 concurrent qualifications', async () => {
    await referrals.claim(referred, await codeOf(referrer));
    await attendAnEvent(referred);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => referrals.qualifyForAttendance(referred)),
    );

    const settled = results.filter((r) => r.status === 'fulfilled' && r.value);
    expect(settled).toHaveLength(1);
    expect(await coins.balanceOf(referrer)).toBe(30);
  });

  it('does nothing for a user nobody referred', async () => {
    await attendAnEvent(referred);
    expect(await referrals.qualifyForAttendance(referred)).toBe(false);
  });
});

describe('velocity is recorded, not enforced (T6)', () => {
  /**
   * A wrong automatic rejection silently steals a real user's reward and nobody
   * finds out. The signals go in front of a human; the real control is that the
   * reward needs an attended event, which does not scale to a farm.
   */
  it('lets a prolific referrer keep referring, and flags them for review', async () => {
    const code = await codeOf(referrer);

    for (let index = 0; index < 12; index += 1) {
      const invitee = await createUser(prisma, 'PROFILE_COMPLETE');
      await referrals.claim(invitee, code);
    }

    const flagged = await prisma.referral.findMany({
      where: { referrerUserId: referrer, fraudSignals: { not: Prisma.DbNull } },
    });

    expect(await prisma.referral.count({ where: { referrerUserId: referrer } })).toBe(12);
    // The first ten are under the threshold; the eleventh onwards carry a signal.
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]?.fraudSignals).toMatchObject({ reason: 'velocity' });
  });

  it('leaves `fraud_signals` empty for an ordinary referral', async () => {
    await referrals.claim(referred, await codeOf(referrer));

    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredUserId: referred },
    });
    expect(referral.fraudSignals).toBeNull();
  });
});

describe('the summary', () => {
  it('counts invitees without naming any of them', async () => {
    const code = await codeOf(referrer);
    const first = await createUser(prisma, 'PROFILE_COMPLETE');
    const second = await createUser(prisma, 'PROFILE_COMPLETE');
    await referrals.claim(first, code);
    await referrals.claim(second, code);
    await attendAnEvent(first);
    await referrals.qualifyForAttendance(first);

    const summary = await referrals.summaryFor(referrer);

    expect(summary).toMatchObject({ code, invited: 2, qualified: 1, coinsEarned: 30 });
    // Being owed a favour does not entitle anybody to a list of their friends'
    // accounts.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(first);
    expect(serialized).not.toContain(second);
  });

  it('says whether the caller was themselves referred, and whether it paid', async () => {
    await referrals.claim(referred, await codeOf(referrer));
    expect((await referrals.summaryFor(referred)).referredBy).toEqual({ qualified: false });

    await attendAnEvent(referred);
    await referrals.qualifyForAttendance(referred);
    expect((await referrals.summaryFor(referred)).referredBy).toEqual({ qualified: true });
  });

  it('reports nothing for somebody who was never referred', async () => {
    expect((await referrals.summaryFor(referrer)).referredBy).toBeNull();
  });
});

describe('the CHECK constraints', () => {
  it('refuses a qualified referral with no date, and a pending one with one', async () => {
    await expect(
      prisma.referral.create({
        data: {
          referrerUserId: referrer,
          referredUserId: referred,
          code: 'ABCD1234',
          status: 'QUALIFIED',
        },
      }),
    ).rejects.toThrow(/qualified_at_matches_status/);

    await expect(
      prisma.referral.create({
        data: {
          referrerUserId: referrer,
          referredUserId: referred,
          code: 'ABCD1234',
          status: 'PENDING',
          qualifiedAt: NOW,
        },
      }),
    ).rejects.toThrow(/qualified_at_matches_status/);
  });

  it('refuses a reward attached to a referral that never qualified', async () => {
    const movement = await coins.apply({
      userId: referrer,
      amount: 30,
      type: 'REFERRAL_REWARD',
      reasonCode: 'test',
      idempotencyKey: 'test-reward',
      actorType: 'SYSTEM',
    });

    await expect(
      prisma.referral.create({
        data: {
          referrerUserId: referrer,
          referredUserId: referred,
          code: 'ABCD1234',
          status: 'PENDING',
          rewardLedgerId: movement.ledgerId,
        },
      }),
    ).rejects.toThrow(/reward_needs_qualification/);
  });
});
