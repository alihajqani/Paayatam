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
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { GeographyAdminService } from './geography-admin.service';
import { ROLE_KEYS } from './permissions';

/**
 * Provinces and cities, as an operator edits them (M22 phase 9).
 *
 * The properties worth a real database are the ones a mock would assert away: the
 * unique index that refuses a duplicate slug, the reference counts that decide
 * whether deactivation is safe, and the trigram-backed search over
 * `name_normalized` that makes «قايم» find «قائم‌شهر».
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-21T09:00:00.000Z'));
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const geography = new GeographyAdminService(service, access, audit);

let fixture: CatalogFixture;
let SUPER: AdminSession;

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);

  const row = await prisma.adminUser.create({
    data: {
      email: 'super@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'مدیر ارشد',
    },
    select: { id: true },
  });

  SUPER = {
    adminUserId: row.id,
    email: 'super@payetam.test',
    displayName: 'مدیر ارشد',
    roles: [ROLE_KEYS.SUPER_ADMIN],
    permissions: permissionsFor([ROLE_KEYS.SUPER_ADMIN]),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GeographyAdminService — provinces', () => {
  it('creates one and refuses a duplicate slug', async () => {
    const created = await geography.createProvince(SUPER, { slug: 'tehran', nameFa: 'تهران' });

    expect(created).toMatchObject({ slug: 'tehran', isActive: true, cityCount: 0 });
    await expect(
      geography.createProvince(SUPER, { slug: 'tehran', nameFa: 'تهران دوباره' }),
    ).rejects.toMatchObject({ code: 'CATALOG_SLUG_TAKEN' });
  });

  it('counts its cities, and how many of them are served', async () => {
    const province = await geography.createProvince(SUPER, { slug: 'gilan', nameFa: 'گیلان' });
    await geography.createCity(SUPER, {
      slug: 'rasht',
      nameFa: 'رشت',
      provinceId: province.id,
      isActive: true,
    });
    await geography.createCity(SUPER, {
      slug: 'lahijan',
      nameFa: 'لاهیجان',
      provinceId: province.id,
    });

    const [listed] = (await geography.listProvinces(SUPER)).filter((row) => row.id === province.id);
    expect(listed).toMatchObject({ cityCount: 2, activeCityCount: 1 });
  });

  /**
   * Deactivating a province hides a heading. It does not close a market — the
   * cities filed under it keep their own `is_active`, which is migration 0020's
   * asymmetry and the reason there is no reference check on this path.
   */
  it('deactivating a province leaves its cities alone', async () => {
    const province = await geography.createProvince(SUPER, { slug: 'yazd', nameFa: 'یزد' });
    const city = await geography.createCity(SUPER, {
      slug: 'ardakan',
      nameFa: 'اردکان',
      provinceId: province.id,
      isActive: true,
    });

    await geography.updateProvince(SUPER, province.id, { isActive: false });

    await expect(
      prisma.city.findUniqueOrThrow({ where: { id: city.id }, select: { isActive: true } }),
    ).resolves.toEqual({ isActive: true });
  });
});

describe('GeographyAdminService — cities', () => {
  it('creates one inactive by default, because a new city is not a market yet', async () => {
    const created = await geography.createCity(SUPER, { slug: 'qom', nameFa: 'قم' });

    expect(created.isActive).toBe(false);
    // The Mini App's catalog only ever returns active rows, so an operator has to
    // decide before anybody can pick it.
    await expect(prisma.city.count({ where: { isActive: true, slug: 'qom' } })).resolves.toBe(0);
  });

  it('refuses a duplicate slug', async () => {
    await expect(
      geography.createCity(SUPER, { slug: 'tehran', nameFa: 'تهران دوباره' }),
    ).rejects.toMatchObject({ code: 'CATALOG_SLUG_TAKEN' });
  });

  it('refuses a province that does not exist, with a field the panel can highlight', async () => {
    await expect(
      geography.createCity(SUPER, {
        slug: 'nowhere',
        nameFa: 'ناکجا',
        provinceId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('writes the normalized name, and rewrites it on a rename', async () => {
    const created = await geography.createCity(SUPER, { slug: 'qaemshahr', nameFa: 'قائم‌شهر' });

    const stored = await prisma.city.findUniqueOrThrow({
      where: { id: created.id },
      select: { nameNormalized: true },
    });
    // ZWNJ folded to a space, ی/ي folded — the same pipeline the search uses.
    expect(stored.nameNormalized).toBe('قایم شهر');

    await geography.updateCity(SUPER, created.id, { nameFa: 'قايم شهر' });
    await expect(
      prisma.city.findUniqueOrThrow({
        where: { id: created.id },
        select: { nameNormalized: true },
      }),
    ).resolves.toEqual({ nameNormalized: 'قایم شهر' });
  });

  it('finds a city by a spelling nobody types', async () => {
    await geography.createCity(SUPER, { slug: 'qaemshahr', nameFa: 'قائم‌شهر' });

    // An Arabic-keyboard ي and a plain space, against a name stored with ئ and a
    // half-space. This is the search working, not the string matching.
    const page = await geography.listCities(SUPER, { query: 'قايم شهر' });

    expect(page.rows.map((row) => row.slug)).toContain('qaemshahr');
  });

  it('filters by province and by activation', async () => {
    const province = await geography.createProvince(SUPER, { slug: 'fars', nameFa: 'فارس' });
    await geography.createCity(SUPER, {
      slug: 'shiraz',
      nameFa: 'شیراز',
      provinceId: province.id,
      isActive: true,
    });
    await geography.createCity(SUPER, {
      slug: 'marvdasht',
      nameFa: 'مرودشت',
      provinceId: province.id,
    });

    await expect(
      geography.listCities(SUPER, { provinceId: province.id }).then((page) => page.total),
    ).resolves.toBe(2);
    await expect(
      geography
        .listCities(SUPER, { provinceId: province.id, isActive: true })
        .then((page) => page.rows.map((row) => row.slug)),
    ).resolves.toEqual(['shiraz']);
  });

  it('carries the reference counts a deactivation decision needs', async () => {
    const userId = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.userProfile.create({
      data: { userId, displayName: 'ساکن', cityId: fixture.tehranId, birthYear: 1995 },
    });

    const page = await geography.listCities(SUPER, { query: 'tehran' });
    const tehran = page.rows.find((row) => row.slug === 'tehran');

    expect(tehran).toMatchObject({ profileCount: 1, districtCount: 1, eventCount: 0 });
  });

  it('refuses to deactivate a city people live in, and names the counts', async () => {
    const userId = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.userProfile.create({
      data: { userId, displayName: 'ساکن', cityId: fixture.tehranId, birthYear: 1995 },
    });

    await expect(
      geography.updateCity(SUPER, fixture.tehranId, { isActive: false }),
    ).rejects.toMatchObject({
      code: 'CITY_HAS_REFERENCES',
      details: { profileCount: 1 },
    });

    await expect(
      prisma.city.findUniqueOrThrow({
        where: { id: fixture.tehranId },
        select: { isActive: true },
      }),
    ).resolves.toEqual({ isActive: true });
  });

  it('deactivates it when the same request confirms, and records that it did', async () => {
    const userId = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.userProfile.create({
      data: { userId, displayName: 'ساکن', cityId: fixture.tehranId, birthYear: 1995 },
    });

    const updated = await geography.updateCity(SUPER, fixture.tehranId, {
      isActive: false,
      confirmReferences: true,
    });

    expect(updated.isActive).toBe(false);
    // The profile is untouched: `is_active` hides a city from pickers, it does not
    // evict the people already in it (migration 0003).
    await expect(
      prisma.userProfile.findUniqueOrThrow({ where: { userId }, select: { cityId: true } }),
    ).resolves.toEqual({ cityId: fixture.tehranId });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'catalog.city.updated', targetId: fixture.tehranId },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.before).toMatchObject({ isActive: true });
    expect(row.after).toMatchObject({ isActive: false, deactivatedWithReferences: 1 });
  });

  it('needs no confirmation to activate — widening is not the dangerous direction', async () => {
    await expect(
      geography.updateCity(SUPER, fixture.karajId, { isActive: true }),
    ).resolves.toMatchObject({ isActive: true });
  });

  it('re-files a city under a different province, and can unfile it', async () => {
    const province = await geography.createProvince(SUPER, { slug: 'alborz', nameFa: 'البرز' });

    await expect(
      geography.updateCity(SUPER, fixture.karajId, { provinceId: province.id }),
    ).resolves.toMatchObject({ provinceId: province.id, provinceNameFa: 'البرز' });

    // Null is a value here, not an omission: `city.province_id` is nullable
    // permanently (migration 0020), so "not filed anywhere" is a real state.
    await expect(
      geography.updateCity(SUPER, fixture.karajId, { provinceId: null }),
    ).resolves.toMatchObject({ provinceId: null });
  });

  it('reorders a block in one transaction, numbered in tens', async () => {
    const a = await geography.createCity(SUPER, { slug: 'aaa', nameFa: 'الف' });
    const b = await geography.createCity(SUPER, { slug: 'bbb', nameFa: 'ب' });

    await geography.reorderCities(SUPER, [b.id, a.id]);

    const rows = await prisma.city.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { id: true, sortOrder: true },
    });
    expect(rows.find((row) => row.id === b.id)?.sortOrder).toBe(0);
    expect(rows.find((row) => row.id === a.id)?.sortOrder).toBe(10);
  });

  it('refuses a reorder naming something that is not a city', async () => {
    await expect(
      geography.reorderCities(SUPER, ['00000000-0000-4000-8000-000000000000']),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('offers no way to delete a city at all', () => {
    // Not an oversight. `is_active` exists so a retired city keeps its profiles and
    // events intact, and every foreign key to it is RESTRICT.
    expect((geography as unknown as Record<string, unknown>)['deleteCity']).toBeUndefined();
  });
});
