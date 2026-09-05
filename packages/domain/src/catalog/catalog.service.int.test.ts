import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { ErrorCode } from '@payetam/shared';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { CatalogService } from './catalog.service';
import { SettingsService } from './settings.service';

/**
 * The catalog's one job: nothing inactive is ever offered, and nothing inactive
 * is ever accepted. Both halves are asserted here, because a list that filters
 * on read but not on write is a list a crafted request walks straight past.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;
/**
 * `CatalogService` reads `TELEGRAM_BOT_USERNAME` for the deep link the Mini App
 * builds (report 6). Never the token — there is no code path here that reads one.
 */
const catalogEnv = { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as unknown as Env;

const catalog = new CatalogService(service, new SettingsService(service), catalogEnv);

let fixture: CatalogFixture;

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The prices a host is shown before being charged.
 *
 * They ride on the catalog because they are the same kind of thing as the rest of it:
 * small, admin-managed and needed before a choice can be rendered. Asserting they
 * come from `app_setting` rather than from a constant is the point — a price baked
 * into the bundle is wrong the first time anybody edits the setting, and the person
 * who discovers that is the host paying the old number.
 */
describe('CatalogService promotion pricing', () => {
  /** No `app_setting` rows in this database, which is the fallback path itself. */
  it('falls back to the documented defaults when nothing is configured', async () => {
    const snapshot = await catalog.snapshot();

    // Whole positive integers, never NaN or null: a blank price on a confirmation
    // screen would be worse than a wrong one, because nobody would question it.
    //
    // `toEqual` and not `toMatchObject`, deliberately: this is the list of prices
    // the product charges, and a field appearing in it without anybody deciding
    // the number is exactly what an exact assertion is for. M22 added the last
    // four, and the documented defaults are 5 / 15 / 10 with a cap of 20.
    expect(snapshot.promotion).toEqual({
      eventCreateCoins: 5,
      eventChannelPublishCoins: 10,
      // The one number a host is quoted, and the reason the two above are never
      // shown apart.
      eventRegisterCoins: 15,
      eventChannelSendCoins: 5,
      eventTopInviteCoins: 20,
      topInviteMaxRecipients: 20,
    });
  });

  it('follows the setting once an admin configures one', async () => {
    await prisma.appSetting.create({ data: { key: 'economy.event_create_coins', value: 55 } });

    const snapshot = await catalog.snapshot();

    expect(snapshot.promotion.eventCreateCoins).toBe(55);
    // The others keep their defaults, so one edit cannot silently move a price
    // nobody touched.
    expect(snapshot.promotion.eventChannelPublishCoins).toBe(10);
    expect(snapshot.promotion.eventTopInviteCoins).toBe(20);
  });
});

describe('CatalogService.snapshot', () => {
  it('offers only active rows', async () => {
    const snapshot = await catalog.snapshot();

    expect(snapshot.cities.map((c) => c.slug)).toEqual(['tehran']);
    expect(snapshot.categories.map((c) => c.slug)).toEqual(['cafe-boardgames']);
    expect(snapshot.interests.map((i) => i.slug).sort()).toEqual(['board-games', 'hiking']);
  });

  it('hides the districts of a city it is not offering', async () => {
    const snapshot = await catalog.snapshot();
    const districts = snapshot.cities.flatMap((city) => city.districts.map((d) => d.slug));

    expect(districts).toEqual(['district-1']);
    expect(districts).not.toContain('karaj-central');
  });

  it('drops a city from the offer the moment it is deactivated', async () => {
    await prisma.city.update({ where: { id: fixture.tehranId }, data: { isActive: false } });
    await expect(catalog.snapshot()).resolves.toMatchObject({ cities: [] });
  });
});

describe('CatalogService.resolveLocation', () => {
  it('accepts an active city on its own', async () => {
    await expect(catalog.resolveLocation(fixture.tehranId, undefined)).resolves.toEqual({
      cityId: fixture.tehranId,
      districtId: null,
    });
  });

  it('accepts a district of that city', async () => {
    await expect(
      catalog.resolveLocation(fixture.tehranId, fixture.tehranDistrictId),
    ).resolves.toEqual({ cityId: fixture.tehranId, districtId: fixture.tehranDistrictId });
  });

  it('refuses a district of another city even though the district itself is real', async () => {
    await expect(
      catalog.resolveLocation(fixture.tehranId, fixture.karajDistrictId),
    ).rejects.toMatchObject({ code: 'INVALID_DISTRICT' });
  });

  it('refuses a deactivated district', async () => {
    await prisma.district.update({
      where: { id: fixture.tehranDistrictId },
      data: { isActive: false },
    });

    await expect(
      catalog.resolveLocation(fixture.tehranId, fixture.tehranDistrictId),
    ).rejects.toMatchObject({ code: 'INVALID_DISTRICT' });
  });
});

describe('CatalogService.assertInterestsSelectable', () => {
  it('returns the distinct set when every id is selectable', async () => {
    await expect(
      catalog.assertInterestsSelectable([fixture.hikingId, fixture.hikingId, fixture.boardGamesId]),
    ).resolves.toEqual([fixture.hikingId, fixture.boardGamesId]);
  });

  it('refuses a deactivated interest', async () => {
    await expect(
      catalog.assertInterestsSelectable([fixture.retiredInterestId]),
    ).rejects.toMatchObject({ code: 'INVALID_INTEREST' });
  });
});

/**
 * A city can be lived in before it is open (v0.10.0).
 *
 * The property worth a database is the split itself: `is_active` and
 * `is_launched` have to disagree for a closed city, and every path has to read
 * the right one. A single flag would make each of these tests pass for the
 * wrong reason.
 */
describe('city launch state', () => {
  /** One completed profile in a city — the unit the waitlist counts. */
  async function seedProfileIn(cityId: string): Promise<void> {
    const userId = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.userProfile.create({
      data: { userId, displayName: 'کاربر', birthYear: 1995, cityId, completedAt: new Date() },
    });
  }

  async function closeCity(cityId: string): Promise<void> {
    await prisma.city.update({ where: { id: cityId }, data: { isLaunched: false } });
  }

  it('reports an open city as open, and counts nothing', async () => {
    await prisma.city.update({ where: { id: fixture.tehranId }, data: { isLaunched: true } });

    await expect(catalog.launchStatus(fixture.tehranId)).resolves.toMatchObject({
      launched: true,
      waiting: 0,
    });
  });

  it('counts the completed profiles waiting on a closed city', async () => {
    await closeCity(fixture.tehranId);

    const status = await catalog.launchStatus(fixture.tehranId);
    expect(status).toMatchObject({ launched: false, waiting: 0, threshold: 100 });

    await seedProfileIn(fixture.tehranId);
    await seedProfileIn(fixture.tehranId);

    await expect(catalog.launchStatus(fixture.tehranId)).resolves.toMatchObject({
      launched: false,
      waiting: 2,
    });
  });

  it('takes the threshold from app_setting, not from code', async () => {
    await closeCity(fixture.tehranId);
    await prisma.appSetting.create({ data: { key: 'city.launch_threshold', value: 40 } });

    await expect(catalog.launchStatus(fixture.tehranId)).resolves.toMatchObject({ threshold: 40 });
  });

  it('answers null for a city that does not exist', async () => {
    await expect(catalog.launchStatus('01a06e1f-0000-7000-8000-000000000000')).resolves.toBeNull();
  });

  /**
   * The half that must NOT be gated. If this ever refuses, nobody outside the
   * open cities can be counted and the queue that decides the next launch stops
   * existing.
   */
  it('resolves a location in a closed city, so a profile can still name it', async () => {
    await closeCity(fixture.tehranId);

    await expect(catalog.resolveLocation(fixture.tehranId, undefined)).resolves.toMatchObject({
      cityId: fixture.tehranId,
    });
  });

  it('refuses the same city when the caller requires it to be open', async () => {
    await closeCity(fixture.tehranId);

    await expect(
      catalog.resolveLocation(fixture.tehranId, undefined, prisma, true),
    ).rejects.toMatchObject({ code: ErrorCode.CITY_NOT_LAUNCHED });
  });

  /**
   * A closed city and a city the catalogue does not offer are different
   * refusals. Collapsing them would tell somebody their city is unavailable when
   * it is merely unopened, which loses the one thing that would make them wait.
   */
  it('tells "not open yet" apart from "not in the catalogue"', async () => {
    await prisma.city.update({
      where: { id: fixture.tehranId },
      data: { isActive: false, isLaunched: true },
    });

    await expect(
      catalog.resolveLocation(fixture.tehranId, undefined, prisma, true),
    ).rejects.toMatchObject({ code: ErrorCode.CITY_NOT_AVAILABLE });
  });
});
