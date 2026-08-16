import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import {
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { CatalogService } from './catalog.service';

/**
 * The catalog's one job: nothing inactive is ever offered, and nothing inactive
 * is ever accepted. Both halves are asserted here, because a list that filters
 * on read but not on write is a list a crafted request walks straight past.
 */

const prisma: PrismaClient = createTestPrisma();
const catalog = new CatalogService(prisma as unknown as PrismaService);

let fixture: CatalogFixture;

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
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
