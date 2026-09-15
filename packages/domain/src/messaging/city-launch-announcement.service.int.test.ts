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
import { CityLaunchAnnouncementService, cityLaunchKey } from './city-launch-announcement.service';
import { MessagingService } from './messaging.service';

/**
 * «پایه‌تَم در … باز شد», once per city (plan 17).
 *
 * The panel stamps `launched_at` the first time a city opens; this is the half
 * that tells the people who named it. What is worth a real database is the
 * "once": the campaign's `idempotency_key`, and the `launch_announced_at` claim
 * that makes a second pass find nothing.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-09-14T09:00:00.000Z');
const clock = new FakeClock(NOW);
const audit = new AuditService(service, clock);
const messaging = new MessagingService(service, clock, audit);
const announcements = new CityLaunchAnnouncementService(service, clock, messaging, audit);

let fixture: CatalogFixture;

async function livesIn(cityId: string): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId, birthYear: 1995 },
  });
  return userId;
}

/** Karaj, opened by the panel just now: launched, not yet announced. */
async function openKaraj(): Promise<void> {
  await prisma.city.update({
    where: { id: fixture.karajId },
    data: { isActive: true, isLaunched: true, launchedAt: NOW },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('CityLaunchAnnouncementService', () => {
  it('broadcasts to the people who named the city, and to nobody else', async () => {
    await livesIn(fixture.karajId);
    await livesIn(fixture.karajId);
    await livesIn(fixture.tehranId);
    await openKaraj();

    const announced = await announcements.announceLaunchedCities();

    expect(announced).toHaveLength(1);
    expect(announced[0]?.recipients).toBe(2);

    const campaign = await prisma.messageCampaign.findUniqueOrThrow({
      where: { idempotencyKey: cityLaunchKey(fixture.karajId) },
      select: {
        status: true,
        kind: true,
        actorType: true,
        bodyText: true,
        estimatedRecipients: true,
      },
    });
    // Confirmed at once: the operator confirmed in the panel, with the count.
    expect(campaign).toMatchObject({
      status: 'QUEUED',
      kind: 'BROADCAST',
      actorType: 'SYSTEM',
      estimatedRecipients: 2,
    });
    expect(campaign.bodyText).toContain('باز شد');

    const city = await prisma.city.findUniqueOrThrow({
      where: { id: fixture.karajId },
      select: { launchAnnouncedAt: true },
    });
    expect(city.launchAnnouncedAt).toEqual(NOW);

    await expect(
      prisma.auditLog.count({ where: { action: 'city.launch_announced' } }),
    ).resolves.toBe(1);
  });

  it('announces a city once, however often it runs', async () => {
    await livesIn(fixture.karajId);
    await openKaraj();

    await announcements.announceLaunchedCities();
    await expect(announcements.announceLaunchedCities()).resolves.toEqual([]);

    await expect(prisma.messageCampaign.count()).resolves.toBe(1);
  });

  /**
   * A crash after the campaign and before the claim: the next pass must not make
   * a second campaign, and must still finish the claim.
   */
  it('finishes a half-done announcement without a second campaign', async () => {
    await livesIn(fixture.karajId);
    await openKaraj();
    await announcements.announceLaunchedCities();
    await prisma.city.update({
      where: { id: fixture.karajId },
      data: { launchAnnouncedAt: null },
    });

    await announcements.announceLaunchedCities();

    await expect(prisma.messageCampaign.count()).resolves.toBe(1);
    const city = await prisma.city.findUniqueOrThrow({
      where: { id: fixture.karajId },
      select: { launchAnnouncedAt: true },
    });
    expect(city.launchAnnouncedAt).not.toBeNull();
  });

  /** Open before plan 17, or seeded open: never stamped, so never announced. */
  it('says nothing about a city that is open without a recorded launch', async () => {
    await livesIn(fixture.tehranId);

    await expect(announcements.announceLaunchedCities()).resolves.toEqual([]);
    await expect(prisma.messageCampaign.count()).resolves.toBe(0);
  });

  /** Closed again before the worker got to it: the message would be false. */
  it('waits while a launched city has been closed again', async () => {
    await livesIn(fixture.karajId);
    await openKaraj();
    await prisma.city.update({ where: { id: fixture.karajId }, data: { isLaunched: false } });

    await expect(announcements.announceLaunchedCities()).resolves.toEqual([]);
  });
});
