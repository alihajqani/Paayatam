import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import {
  createTestPrisma,
  createUser,
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

  describe('discard', () => {
    it('removes an identity that never got a seat', async () => {
      const { userId } = await identities.createSeedParticipant(fixture.tehranId);

      await identities.discard(userId);

      expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
      expect(await prisma.userProfile.count({ where: { userId } })).toBe(0);
    });

    it('cannot remove a real account, whatever id it is handed', async () => {
      const realId = await createUser(prisma, 'PROFILE_COMPLETE');

      await identities.discard(realId);

      expect(await prisma.user.count({ where: { id: realId } })).toBe(1);
    });

    it('cannot remove an identity that holds a seat', async () => {
      const { userId } = await identities.createSeedParticipant(fixture.tehranId);
      const hostId = await createUser(prisma, 'PROFILE_COMPLETE');
      const startsAt = new Date('2026-09-20T15:00:00.000Z');
      const event = await prisma.event.create({
        data: {
          hostUserId: hostId,
          title: 'رویداد',
          description: 'یک رویداد برای آزمون.',
          titleNormalized: 'رویداد',
          descriptionNormalized: 'یک رویداد برای آزمون.',
          categoryId: fixture.categoryId,
          cityId: fixture.tehranId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          capacity: 5,
          costType: 'FREE',
          status: 'PUBLISHED',
          moderationStatus: 'APPROVED',
          publishedAt: startsAt,
        },
        select: { id: true },
      });
      await prisma.eventParticipant.create({
        data: {
          eventId: event.id,
          userId,
          status: 'ACCEPTED',
          requestedAt: startsAt,
          decidedAt: startsAt,
          acceptedAt: startsAt,
        },
      });

      await identities.discard(userId);

      expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    });
  });
});
