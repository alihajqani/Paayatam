import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
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
import { CatalogAdminService } from './catalog-admin.service';
import { ROLE_KEYS } from './permissions';

/**
 * Managing activity tags from the panel (M21).
 *
 * The RBAC matrix asserts *who* may call these. This asserts what they do — and
 * in particular the four refusals an operator meets, because each one exists to
 * stop a specific way of breaking live data and each would otherwise be
 * discovered in production:
 *
 *   - a duplicate slug, which would make two rows compete for one identifier;
 *   - deleting a tag events reference, which `RESTRICT` would turn into a 500;
 *   - a city restriction naming a city that does not exist;
 *   - reordering with an id that is not a tag.
 *
 * Authentication never happens here, so Redis is never reached and a stub stands
 * in for it — the same choice `gift-code-admin.int.test.ts` makes.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-26T09:00:00.000Z'));
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const catalog = new CatalogAdminService(service, access, audit);

let SUPER: AdminSession;
let fixture: CatalogFixture;

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

describe('CatalogAdminService', () => {
  it('creates a tag, active and at the end of the order', async () => {
    const created = await catalog.createTag(SUPER, { slug: 'museum', nameFa: 'موزه و گالری' });

    expect(created.slug).toBe('museum');
    // Defaults to active, unlike the column's `false` — a tag an operator made
    // and then had to hunt for and switch on is a papercut with no upside.
    expect(created.isActive).toBe(true);
    expect(created.cityIds).toBeNull();
    expect(created.eventCount).toBe(0);

    const tags = await catalog.listTags(SUPER);
    expect(tags.at(-1)?.slug).toBe('museum');
  });

  it('records the creation in the audit trail', async () => {
    await catalog.createTag(SUPER, { slug: 'museum', nameFa: 'موزه و گالری' });

    const entry = await prisma.auditLog.findFirst({ where: { action: 'catalog.tag.created' } });
    expect(entry?.actorId).toBe(SUPER.adminUserId);
    expect(entry?.after).toMatchObject({ slug: 'museum', nameFa: 'موزه و گالری' });
  });

  it('refuses a slug that is already taken', async () => {
    await expect(
      catalog.createTag(SUPER, { slug: 'cafe-boardgames', nameFa: 'تکراری' }),
    ).rejects.toMatchObject({ code: 'CATALOG_SLUG_TAKEN' });
  });

  it('lists inactive tags too, because this is where they are switched back on', async () => {
    const tags = await catalog.listTags(SUPER);
    expect(tags.map((tag) => tag.slug)).toContain('retired-category');
  });

  it('leaves omitted fields alone on update', async () => {
    const created = await catalog.createTag(SUPER, {
      slug: 'museum',
      nameFa: 'موزه',
      icon: '🏛️',
      allowsCustomLabel: true,
    });

    const updated = await catalog.updateTag(SUPER, created.id, { nameFa: 'موزه و گالری' });

    expect(updated.nameFa).toBe('موزه و گالری');
    expect(updated.icon).toBe('🏛️');
    expect(updated.allowsCustomLabel).toBe(true);
  });

  describe('city restrictions', () => {
    it('treats no rows as "everywhere" and a set as a restriction', async () => {
      const created = await catalog.createTag(SUPER, { slug: 'museum', nameFa: 'موزه' });
      expect(created.cityIds).toBeNull();

      const restricted = await catalog.updateTag(SUPER, created.id, {
        cityIds: [fixture.tehranId],
      });
      expect(restricted.cityIds).toEqual([fixture.tehranId]);

      // Back to unrestricted. `null` is the *value*, not an omission — omitting
      // the field would have left the restriction in place.
      const widened = await catalog.updateTag(SUPER, created.id, { cityIds: null });
      expect(widened.cityIds).toBeNull();
    });

    it('refuses a city that does not exist', async () => {
      await expect(
        catalog.createTag(SUPER, {
          slug: 'museum',
          nameFa: 'موزه',
          cityIds: ['00000000-0000-4000-8000-00000000dead'],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('deletion', () => {
    it('deletes a tag nothing references', async () => {
      const created = await catalog.createTag(SUPER, { slug: 'museum', nameFa: 'موزه' });
      await catalog.deleteTag(SUPER, created.id);

      const tags = await catalog.listTags(SUPER);
      expect(tags.map((tag) => tag.slug)).not.toContain('museum');
    });

    /**
     * The refusal that matters. `event.category_id` is RESTRICT, so without this
     * check the operator gets a constraint violation with no useful message —
     * and the honest answer is that deactivation is what they wanted anyway.
     */
    it('refuses to delete a tag that events reference, and names the count', async () => {
      const host = await prisma.user.create({
        data: { onboardingState: 'PROFILE_COMPLETE' },
        select: { id: true },
      });
      await prisma.event.create({
        data: {
          hostUserId: host.id,
          title: 'شب بازی',
          description: 'یک شب بازی رومیزی دوستانه در کافه، برای همه.',
          titleNormalized: 'شب بازی',
          descriptionNormalized: 'یک شب بازی رومیزی دوستانه در کافه برای همه',
          categoryId: fixture.categoryId,
          cityId: fixture.tehranId,
          startsAt: new Date('2026-09-01T15:00:00.000Z'),
          endsAt: new Date('2026-09-01T18:00:00.000Z'),
          capacity: 6,
          costType: 'SPLIT',
        },
      });

      await expect(catalog.deleteTag(SUPER, fixture.categoryId)).rejects.toMatchObject({
        code: 'CATALOG_TAG_IN_USE',
        details: { eventCount: 1 },
      });

      // And the deactivation it points the operator at does work.
      const deactivated = await catalog.updateTag(SUPER, fixture.categoryId, { isActive: false });
      expect(deactivated.isActive).toBe(false);
    });
  });

  describe('reordering', () => {
    it('rewrites the whole order in one call', async () => {
      const a = await catalog.createTag(SUPER, { slug: 'museum', nameFa: 'موزه' });
      const b = await catalog.createTag(SUPER, { slug: 'shopping', nameFa: 'خرید' });

      const reordered = await catalog.reorderTags(SUPER, [b.id, a.id, fixture.categoryId]);
      const byId = new Map(reordered.map((tag) => [tag.id, tag.sortOrder]));

      // Tens apart, so a row can later be slotted between two without renumbering.
      expect([byId.get(b.id), byId.get(a.id), byId.get(fixture.categoryId)]).toEqual([0, 10, 20]);

      // Asserted on the named ids rather than on `reordered.slice(0, 3)`,
      // because a tag left out of `order` keeps its own `sortOrder` and can
      // legitimately land among them — the fixture's retired tag is still at 0,
      // which is exactly the partial-reorder case the method documents.
      const positions = reordered.map((tag) => tag.id);
      expect(positions.indexOf(b.id)).toBeLessThan(positions.indexOf(a.id));
      expect(positions.indexOf(a.id)).toBeLessThan(positions.indexOf(fixture.categoryId));
    });

    it('refuses an id that is not a tag', async () => {
      await expect(
        catalog.reorderTags(SUPER, ['00000000-0000-4000-8000-00000000dead']),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  it('lists provinces and cities for the scope picker, inactive ones included', async () => {
    const places = await catalog.listPlaces(SUPER);
    // `karaj` is inactive in the fixture: an admin restricting a tag to a city
    // they are about to activate is a normal order of operations.
    expect(places.cities.map((city) => city.slug)).toEqual(
      expect.arrayContaining(['tehran', 'karaj']),
    );
  });
});
