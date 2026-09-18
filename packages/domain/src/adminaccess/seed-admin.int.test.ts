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
import { ROLE_KEYS } from './permissions';
import { SeedAdminService } from './seed-admin.service';

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const clock = new FakeClock(new Date('2026-08-21T09:00:00.000Z'));
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const seedAdmin = new SeedAdminService(service, access, audit);

let fixture: CatalogFixture;
let SUPER: AdminSession;
let ANALYST: AdminSession;

async function seedRealHost(cityId: string): Promise<{ id: string; publicId: string }> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'میزبان بذر', cityId, birthYear: 1995 },
  });
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return { id: userId, publicId: user.publicId };
}

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

  const analystRow = await prisma.adminUser.create({
    data: {
      email: 'analyst@payetam.test',
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: 'تحلیل‌گر',
    },
    select: { id: true },
  });
  ANALYST = {
    adminUserId: analystRow.id,
    email: 'analyst@payetam.test',
    displayName: 'تحلیل‌گر',
    roles: [ROLE_KEYS.ANALYST],
    permissions: permissionsFor([ROLE_KEYS.ANALYST]),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SeedAdminService', () => {
  describe('listCities', () => {
    it('refuses a session without event.seed.manage', async () => {
      await expect(seedAdmin.listCities(ANALYST)).rejects.toThrow();
    });

    it('lists every launched city, configured or not', async () => {
      const launchedCount = await prisma.city.count({ where: { isLaunched: true } });

      const cities = await seedAdmin.listCities(SUPER);

      expect(cities).toHaveLength(launchedCount);
      expect(cities.every((c) => c.enabled === false)).toBe(true); // none configured yet
    });
  });

  describe('updateConfig', () => {
    it('creates a config row on first write and audits it', async () => {
      const host = await seedRealHost(fixture.tehranId);

      const result = await seedAdmin.updateConfig(SUPER, fixture.tehranId, {
        enabled: true,
        floorCount: 2,
        eventCapacity: 5,
        fillMinutes: 5,
        hostUserPublicId: host.publicId,
      });

      expect(result.enabled).toBe(true);
      expect(result.floorCount).toBe(2);
      expect(result.hostUserPublicId).toBe(host.publicId);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { targetType: 'city_seed_config', targetId: fixture.tehranId },
      });
      expect(audit.actorType).toBe('ADMIN');
      expect(audit.actorId).toBe(SUPER.adminUserId);
    });

    it('refuses a host that is itself a seed identity', async () => {
      const fakeHost = await prisma.user.create({ data: { isSeed: true } });

      await expect(
        seedAdmin.updateConfig(SUPER, fixture.tehranId, {
          hostUserPublicId: fakeHost.publicId,
        }),
      ).rejects.toThrow();
    });

    it('refuses a session without event.seed.manage', async () => {
      const host = await seedRealHost(fixture.tehranId);

      await expect(
        seedAdmin.updateConfig(ANALYST, fixture.tehranId, { hostUserPublicId: host.publicId }),
      ).rejects.toThrow();
    });
  });
});
