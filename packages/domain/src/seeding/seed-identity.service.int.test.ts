import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import {
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { SeedIdentityService } from './seed-identity.service';

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;
const identities = new SeedIdentityService(service);

let fixture: CatalogFixture;

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SeedIdentityService', () => {
  it('creates a User with isSeed=true and no telegramAccount row', async () => {
    const { userId } = await identities.createSeedParticipant(fixture.tehranId);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { telegramAccount: true, profile: true },
    });
    expect(user.isSeed).toBe(true);
    expect(user.telegramAccount).toBeNull();
    expect(user.profile).not.toBeNull();
    expect(user.profile?.cityId).toBe(fixture.tehranId);
    expect(user.onboardingState).toBe('PROFILE_COMPLETE');
  });

  it('produces a different display name on repeated calls', async () => {
    const a = await identities.createSeedParticipant(fixture.tehranId);
    const b = await identities.createSeedParticipant(fixture.tehranId);

    const [profileA, profileB] = await Promise.all([
      prisma.userProfile.findUniqueOrThrow({ where: { userId: a.userId } }),
      prisma.userProfile.findUniqueOrThrow({ where: { userId: b.userId } }),
    ]);
    expect(profileA.displayName).not.toBe(profileB.displayName);
  });
});
