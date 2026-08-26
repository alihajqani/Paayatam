import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
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
import { CatalogService } from '../catalog/catalog.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { TrustService } from '../economy/trust.service';
import { ProfileService, onboardingRewardKey } from './profile.service';

/**
 * Profile completion, against a real Postgres.
 *
 * The acceptance criterion this file exists for is "concurrent double profile
 * completion grants exactly one reward" (plan, M3). That is a claim about a
 * UNIQUE index and a row lock, so it is only meaningful against a real database.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

// Fixed clock, fixed zone. The 18+ boundary moves with the calendar by design
// (see age.ts), so a test that read the wall clock would start failing on a
// January morning for reasons unrelated to the code.
const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const catalog = new CatalogService(service, settings);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const audit = new AuditService(service, clock);
const profiles = new ProfileService(service, clock, env, catalog, settings, coins, trust, audit);

let fixture: CatalogFixture;

function validInput(overrides: Partial<Parameters<typeof profiles.complete>[1]> = {}) {
  return {
    displayName: 'سارا',
    gender: 'FEMALE' as const,
    birthYear: 1996,
    cityId: fixture.tehranId,
    districtId: fixture.tehranDistrictId,
    bio: 'بازی رومیزی و کوه',
    interestIds: [fixture.boardGamesId, fixture.hikingId],
    ...overrides,
  };
}

/**
 * `validInput`, with the district left out entirely.
 *
 * `districtId: undefined` cannot travel through the overrides object:
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and the service's input type permits only the former. Omitting the
 * key is what the tests pairing a city with no district actually mean.
 */
function inputWithoutDistrict(overrides: Partial<Parameters<typeof profiles.complete>[1]> = {}) {
  const { districtId: _dropped, ...rest } = validInput(overrides);
  return rest;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('ProfileService.complete — the happy path', () => {
  it('writes the profile, advances onboarding, and grants the reward once', async () => {
    const userId = await createUser(prisma);

    const result = await profiles.complete(userId, validInput());

    expect(result.onboardingState).toBe('PROFILE_COMPLETE');
    expect(result.rewardGranted).toBe(true);
    expect(result.balance).toBe(50);
    expect(result.profile).toMatchObject({
      displayName: 'سارا',
      gender: 'FEMALE',
      birthYear: 1996,
      city: { slug: 'tehran' },
      district: { slug: 'district-1' },
    });
    expect(result.profile.interests.map((i) => i.slug).sort()).toEqual(['board-games', 'hiking']);
    expect(result.profile.completedAt).toEqual(NOW);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.onboardingState).toBe('PROFILE_COMPLETE');

    const ledger = await prisma.coinLedger.findMany({ where: { userId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      idempotencyKey: onboardingRewardKey(userId),
      type: 'ONBOARDING_REWARD',
      amount: 50,
      actorType: 'SYSTEM',
    });
  });

  it('writes an audit row for the transition (invariant 10)', async () => {
    const userId = await createUser(prisma);
    await profiles.complete(userId, validInput());

    const entries = await prisma.auditLog.findMany({ where: { targetId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'profile.completed',
      actorType: 'USER',
      targetType: 'user_profile',
      before: { onboardingState: 'TERMS_ACCEPTED' },
    });

    // Content never goes in the audit trail — only the fact that it changed.
    expect(JSON.stringify(entries[0]?.after)).not.toContain('سارا');
  });

  it('takes the reward amount from app_setting, not from code', async () => {
    await prisma.appSetting.create({
      data: { key: 'economy.onboarding_reward_coins', value: 75 },
    });
    const userId = await createUser(prisma);

    const result = await profiles.complete(userId, validInput());

    expect(result.balance).toBe(75);
  });

  it('accepts a profile with no district and no bio', async () => {
    const userId = await createUser(prisma);
    const { districtId: _districtId, bio: _bio, ...rest } = validInput();

    const result = await profiles.complete(userId, rest);

    expect(result.profile.district).toBeNull();
    expect(result.profile.bio).toBeNull();
  });
});

describe('ProfileService.complete — the reward is granted exactly once', () => {
  it('grants one reward across 10 concurrent completions', async () => {
    const userId = await createUser(prisma);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => profiles.complete(userId, validInput())),
    );

    expect(results.filter((r) => r.rewardGranted)).toHaveLength(1);
    expect(results.every((r) => r.balance === 50)).toBe(true);

    await expect(prisma.coinLedger.count({ where: { userId } })).resolves.toBe(1);
    await expect(coins.balanceOf(userId)).resolves.toBe(50);
    await expect(prisma.userProfile.count({ where: { userId } })).resolves.toBe(1);
    await expect(prisma.userInterest.count({ where: { userId } })).resolves.toBe(2);
  });

  it('does not grant again on a later edit', async () => {
    const userId = await createUser(prisma);
    await profiles.complete(userId, validInput());

    clock.advance(60 * 60 * 1000);
    const second = await profiles.complete(userId, validInput({ displayName: 'سارا م.' }));

    expect(second.rewardGranted).toBe(false);
    expect(second.balance).toBe(50);
    expect(second.profile.displayName).toBe('سارا م.');
    // Completion is a moment, not a field that follows the latest edit.
    expect(second.profile.completedAt).toEqual(NOW);

    await expect(prisma.coinLedger.count({ where: { userId } })).resolves.toBe(1);

    const entries = await prisma.auditLog.findMany({ where: { targetId: userId } });
    expect(entries.map((e) => e.action)).toEqual(['profile.completed', 'profile.updated']);
  });

  it('replaces the interest selection rather than accumulating it', async () => {
    const userId = await createUser(prisma);
    await profiles.complete(userId, validInput());

    const result = await profiles.complete(userId, validInput({ interestIds: [fixture.hikingId] }));

    expect(result.profile.interests.map((i) => i.slug)).toEqual(['hiking']);
    await expect(prisma.userInterest.count({ where: { userId } })).resolves.toBe(1);
  });
});

describe('ProfileService.complete — rejections', () => {
  /** Nothing may survive a rejected completion: no profile, no coins, no state change. */
  async function expectNothingWritten(userId: string): Promise<void> {
    await expect(prisma.userProfile.count({ where: { userId } })).resolves.toBe(0);
    await expect(prisma.userInterest.count({ where: { userId } })).resolves.toBe(0);
    await expect(prisma.coinLedger.count({ where: { userId } })).resolves.toBe(0);
    await expect(coins.balanceOf(userId)).resolves.toBe(0);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.onboardingState).toBe('TERMS_ACCEPTED');
  }

  it('refuses someone under 18', async () => {
    const userId = await createUser(prisma);

    // 2026 − 2009 = 17.
    await expect(profiles.complete(userId, validInput({ birthYear: 2009 }))).rejects.toMatchObject({
      code: 'AGE_BELOW_MINIMUM',
      httpStatus: 400,
    });

    await expectNothingWritten(userId);
  });

  it('admits someone who turns 18 this year', async () => {
    const userId = await createUser(prisma);
    const result = await profiles.complete(userId, validInput({ birthYear: 2008 }));
    expect(result.profile.birthYear).toBe(2008);
  });

  it('honours a minimum age changed in app_setting', async () => {
    await prisma.appSetting.create({ data: { key: 'profile.min_age_years', value: 21 } });
    const userId = await createUser(prisma);

    await expect(profiles.complete(userId, validInput({ birthYear: 2008 }))).rejects.toMatchObject({
      code: 'AGE_BELOW_MINIMUM',
    });
  });

  it('refuses an inactive city', async () => {
    const userId = await createUser(prisma);

    await expect(
      profiles.complete(userId, inputWithoutDistrict({ cityId: fixture.karajId })),
    ).rejects.toMatchObject({ code: 'CITY_NOT_AVAILABLE' });

    await expectNothingWritten(userId);
  });

  it('refuses a city that does not exist', async () => {
    const userId = await createUser(prisma);

    await expect(
      profiles.complete(
        userId,
        inputWithoutDistrict({ cityId: '00000000-0000-4000-8000-000000000000' }),
      ),
    ).rejects.toMatchObject({ code: 'CITY_NOT_AVAILABLE' });
  });

  it('refuses a district belonging to a different city', async () => {
    const userId = await createUser(prisma);

    await expect(
      profiles.complete(userId, validInput({ districtId: fixture.karajDistrictId })),
    ).rejects.toMatchObject({ code: 'INVALID_DISTRICT' });

    await expectNothingWritten(userId);
  });

  it('refuses an interest outside the admin list, and names the offender', async () => {
    const userId = await createUser(prisma);
    const unknownId = '00000000-0000-4000-8000-000000000001';

    await expect(
      profiles.complete(userId, validInput({ interestIds: [fixture.hikingId, unknownId] })),
    ).rejects.toMatchObject({
      code: 'INVALID_INTEREST',
      details: { invalidInterestIds: [unknownId] },
    });

    await expectNothingWritten(userId);
  });

  it('refuses an interest that has been deactivated', async () => {
    const userId = await createUser(prisma);

    await expect(
      profiles.complete(userId, validInput({ interestIds: [fixture.retiredInterestId] })),
    ).rejects.toMatchObject({ code: 'INVALID_INTEREST' });
  });

  it('is not fooled by a duplicated interest id padding the list', async () => {
    const userId = await createUser(prisma);
    const unknownId = '00000000-0000-4000-8000-000000000002';

    // Two ids submitted, one real, one not — a length check against the number
    // of rows found would have let this through.
    await expect(
      profiles.complete(userId, validInput({ interestIds: [fixture.hikingId, unknownId] })),
    ).rejects.toMatchObject({ code: 'INVALID_INTEREST' });

    // And a genuinely duplicated selection is accepted as the one interest it is.
    const result = await profiles.complete(
      userId,
      validInput({ interestIds: [fixture.hikingId, fixture.hikingId] }),
    );
    expect(result.profile.interests).toHaveLength(1);
  });

  it('refuses a user who has not accepted the terms', async () => {
    const userId = await createUser(prisma, 'NEW');

    await expect(profiles.complete(userId, validInput())).rejects.toMatchObject({
      code: 'TERMS_NOT_ACCEPTED',
    });

    await expect(prisma.userProfile.count({ where: { userId } })).resolves.toBe(0);
  });

  it('refuses a user that does not exist', async () => {
    await expect(
      profiles.complete('00000000-0000-4000-8000-00000000dead', validInput()),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});

describe('ProfileService.find', () => {
  it('returns null before onboarding', async () => {
    const userId = await createUser(prisma);
    await expect(profiles.find(userId)).resolves.toBeNull();
  });
});

/**
 * Editing a profile that already exists (M22 phase 2).
 *
 * What is worth a real database here is what the edit path must *not* do. The
 * onboarding reward is keyed on the user in `coin_ledger` and `completed_at` is
 * written once — both are claims about columns and indexes, and the way to break
 * either is to reuse `complete` for edits. These tests are what stop that.
 */
describe('ProfileService.update — editing an existing profile', () => {
  async function completedUser(): Promise<string> {
    const userId = await createUser(prisma, 'TERMS_ACCEPTED');
    await profiles.complete(userId, validInput());
    return userId;
  }

  it('changes only the field that was sent', async () => {
    const userId = await completedUser();

    const updated = await profiles.update(userId, { displayName: 'سارای تازه' });

    expect(updated.displayName).toBe('سارای تازه');
    // Everything else survives, which is the whole difference between PATCH and
    // the POST that takes a whole profile.
    expect(updated.bio).toBe('بازی رومیزی و کوه');
    expect(updated.city.id).toBe(fixture.tehranId);
    expect(updated.district?.id).toBe(fixture.tehranDistrictId);
    expect(updated.interests.map((interest) => interest.id).sort()).toEqual(
      [fixture.boardGamesId, fixture.hikingId].sort(),
    );
  });

  it('clears a nullable field when null is sent, and leaves it when the key is absent', async () => {
    const userId = await completedUser();

    await expect(profiles.update(userId, { bio: null })).resolves.toMatchObject({ bio: null });
    // Absent, not null: the display name must not be touched by a bio edit.
    await expect(profiles.update(userId, { displayName: 'سارا' })).resolves.toMatchObject({
      bio: null,
      displayName: 'سارا',
    });
  });

  it('never grants the reward again, however many times it is called', async () => {
    const userId = await completedUser();
    const before = await coins.balanceOf(userId);

    await profiles.update(userId, { displayName: 'یک' });
    await profiles.update(userId, { displayName: 'دو' });

    await expect(coins.balanceOf(userId)).resolves.toBe(before);
    await expect(
      prisma.coinLedger.count({ where: { idempotencyKey: onboardingRewardKey(userId) } }),
    ).resolves.toBe(1);
  });

  it('leaves completed_at and the onboarding state where they were', async () => {
    const userId = await completedUser();
    const before = await prisma.userProfile.findUniqueOrThrow({
      where: { userId },
      select: { completedAt: true },
    });

    clock.set(new Date(NOW.getTime() + 30 * 86_400_000));
    await profiles.update(userId, { displayName: 'یک ماه بعد' });

    const after = await prisma.userProfile.findUniqueOrThrow({
      where: { userId },
      select: { completedAt: true },
    });
    expect(after.completedAt).toEqual(before.completedAt);
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { onboardingState: true } }),
    ).resolves.toEqual({ onboardingState: 'PROFILE_COMPLETE' });

    clock.set(NOW);
  });

  it('re-checks the age on the server clock, and refuses an under-age edit', async () => {
    const userId = await completedUser();

    await expect(profiles.update(userId, { birthYear: 2015 })).rejects.toMatchObject({
      code: 'AGE_BELOW_MINIMUM',
    });

    // Nothing was written: the refusal happens before the transaction opens.
    await expect(
      prisma.userProfile.findUniqueOrThrow({ where: { userId }, select: { birthYear: true } }),
    ).resolves.toEqual({ birthYear: 1996 });
  });

  it('drops a district that belongs to the city the user just left', async () => {
    const userId = await completedUser();
    await prisma.city.update({ where: { id: fixture.karajId }, data: { isActive: true } });

    const updated = await profiles.update(userId, { cityId: fixture.karajId });

    expect(updated.city.id).toBe(fixture.karajId);
    // Keeping منطقه ۱ of Tehran under کرج would be a pair the catalog is right to
    // reject — so the edit clears it rather than sending one.
    expect(updated.district).toBeNull();
  });

  it('refuses a district that belongs to a different city', async () => {
    const userId = await completedUser();
    await prisma.city.update({ where: { id: fixture.karajId }, data: { isActive: true } });

    await expect(
      profiles.update(userId, { districtId: fixture.karajDistrictId }),
    ).rejects.toMatchObject({ code: 'INVALID_DISTRICT' });
  });

  it('refuses a city the catalog has deactivated', async () => {
    const userId = await completedUser();

    await expect(profiles.update(userId, { cityId: fixture.karajId })).rejects.toMatchObject({
      code: 'CITY_NOT_AVAILABLE',
    });
  });

  it('refuses an interest that is not selectable', async () => {
    const userId = await completedUser();

    await expect(
      profiles.update(userId, { interestIds: [fixture.retiredInterestId] }),
    ).rejects.toMatchObject({ code: 'INVALID_INTEREST' });

    // The whole edit rolls back, so the old set is intact rather than half-replaced.
    await expect(prisma.userInterest.count({ where: { userId } })).resolves.toBe(2);
  });

  it('replaces the interest set rather than adding to it', async () => {
    const userId = await completedUser();

    const updated = await profiles.update(userId, { interestIds: [fixture.hikingId] });

    expect(updated.interests.map((interest) => interest.id)).toEqual([fixture.hikingId]);
  });

  it('refuses to edit a profile that does not exist yet', async () => {
    const userId = await createUser(prisma, 'TERMS_ACCEPTED');

    await expect(profiles.update(userId, { displayName: 'کسی' })).rejects.toMatchObject({
      code: 'PROFILE_INCOMPLETE',
    });
  });

  it('records a user edit as field names only, with no values', async () => {
    const userId = await completedUser();

    await profiles.update(userId, { displayName: 'نام تازه', bio: 'متن تازه' });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'profile.updated', targetId: userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.actorType).toBe('USER');
    expect(row.after).toEqual({ changedFields: ['displayName', 'bio'] });
    // ADR-0009: the trail records that a change happened, not a copy of it.
    expect(JSON.stringify(row.after)).not.toContain('نام تازه');
  });

  it('records an admin edit with old and new values, the reason, and no bio text', async () => {
    const userId = await completedUser();

    await profiles.update(
      userId,
      { displayName: 'اصلاح‌شده', bio: 'متن حساس' },
      { kind: 'ADMIN', adminUserId: 'admin-1', reason: 'به درخواست کاربر' },
    );

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'admin.profile.updated', targetId: userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.actorType).toBe('ADMIN');
    expect(row.actorId).toBe('admin-1');
    expect(row.before).toMatchObject({ displayName: 'سارا' });
    expect(row.after).toMatchObject({ displayName: 'اصلاح‌شده', reason: 'به درخواست کاربر' });
    // The bio is a length on both sides and never the text — `user.read` masks it
    // for staff, and an audit row is a place the masking does not reach.
    expect(JSON.stringify(row.before)).not.toContain('بازی رومیزی');
    expect(JSON.stringify(row.after)).not.toContain('متن حساس');
    expect(row.after).toMatchObject({ bioLength: 'متن حساس'.length });
  });

  it('records nothing as changed when the edit sends the values already stored', async () => {
    const userId = await completedUser();

    await profiles.update(userId, { displayName: 'سارا' });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'profile.updated', targetId: userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.after).toEqual({ changedFields: [] });
  });

  it('carries the invitation opt-out', async () => {
    const userId = await completedUser();

    await expect(profiles.update(userId, { inviteOptOut: true })).resolves.toMatchObject({
      inviteOptOut: true,
    });
    await expect(profiles.update(userId, { inviteOptOut: false })).resolves.toMatchObject({
      inviteOptOut: false,
    });
  });
});
