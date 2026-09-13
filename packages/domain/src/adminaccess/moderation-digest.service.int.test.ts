import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { createTestPrisma, resetDatabase } from '../../../../test/integration/db';
import { SettingsService } from '../catalog/settings.service';
import { ModerationDigestService } from './moderation-digest.service';
import { ROLE_KEYS } from './permissions';

/**
 * Who is told the moderation queue has work, and when (plan 06).
 *
 * The recipient is not "anybody linked": a link resolves to the intersection of
 * the admin's roles and `BOT_PERMISSIONS`, and somebody whose session holds no
 * `event.moderate` has nothing they could do with the message.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

/** Noon in Tehran — inside the waking hours the digest keeps to. */
const NOON = new Date('2026-09-14T08:30:00.000Z');
const clock = new FakeClock(NOON);
const digests = new ModerationDigestService(service, clock, new SettingsService(service));

const MODERATOR_TELEGRAM = 573_914_882n;
const ANALYST_TELEGRAM = 601_222_333n;

async function linkedAdmin(
  email: string,
  roleKey: string,
  telegramUserId: bigint,
  status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
): Promise<string> {
  const admin = await prisma.adminUser.create({
    data: {
      email,
      passwordHash: 'not-a-real-hash',
      totpSecretEnc: 'not-a-real-secret',
      displayName: email,
      status,
    },
    select: { id: true },
  });
  const role = await prisma.role.upsert({
    where: { key: roleKey },
    create: { key: roleKey, name: roleKey },
    update: {},
    select: { id: true },
  });
  await prisma.adminUserRole.create({ data: { adminUserId: admin.id, roleId: role.id } });
  await prisma.adminTelegramLink.create({
    data: { adminUserId: admin.id, telegramUserId, grantedById: admin.id, reason: 'test fixture' },
  });
  return admin.id;
}

async function openCase(
  ageMinutes: number,
  over: { status?: 'OPEN' | 'IN_REVIEW' | 'ESCALATED'; subjectType?: 'EVENT' | 'USER' } = {},
): Promise<void> {
  await prisma.moderationCase.create({
    data: {
      subjectType: over.subjectType ?? 'EVENT',
      subjectId: '00000000-0000-4000-8000-000000000001',
      trigger: 'REPORT_THRESHOLD',
      status: over.status ?? 'OPEN',
      reportCount: 3,
      createdAt: new Date(NOON.getTime() - ageMinutes * 60_000),
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOON);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the moderation digest', () => {
  it('is due to a linked moderator for an unclaimed case past the delay', async () => {
    const moderatorId = await linkedAdmin(
      'mod@payetam.test',
      ROLE_KEYS.MODERATOR,
      MODERATOR_TELEGRAM,
    );
    await openCase(60);
    await openCase(30, { subjectType: 'USER' });
    await openCase(90, { status: 'IN_REVIEW' });

    const due = await digests.due();

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      adminUserId: moderatorId,
      telegramUserId: MODERATOR_TELEGRAM,
      summary: {
        openCount: 3,
        unclaimedCount: 2,
        bySubject: { EVENT: 1, USER: 1 },
      },
    });
    expect(due[0]?.summary.oldestUnclaimedAt?.toISOString()).toBe(
      new Date(NOON.getTime() - 60 * 60_000).toISOString(),
    );
  });

  /** A linked account whose bot session has no `event.moderate` is not told. */
  it('is not due to a linked account without the moderation permission', async () => {
    await linkedAdmin('analyst@payetam.test', ROLE_KEYS.ANALYST, ANALYST_TELEGRAM);
    await openCase(60);

    await expect(digests.due()).resolves.toEqual([]);
  });

  it('is not due to a suspended moderator', async () => {
    await linkedAdmin('mod@payetam.test', ROLE_KEYS.MODERATOR, MODERATOR_TELEGRAM, 'SUSPENDED');
    await openCase(60);

    await expect(digests.due()).resolves.toEqual([]);
  });

  /** Everything is claimed: somebody is on it, so nobody is nudged. */
  it('is not due when every open case has somebody on it', async () => {
    await linkedAdmin('mod@payetam.test', ROLE_KEYS.MODERATOR, MODERATOR_TELEGRAM);
    await openCase(60, { status: 'IN_REVIEW' });

    await expect(digests.due()).resolves.toEqual([]);
  });

  it('stays quiet after a digest, and speaks again once the quiet period has passed', async () => {
    const moderatorId = await linkedAdmin(
      'mod@payetam.test',
      ROLE_KEYS.MODERATOR,
      MODERATOR_TELEGRAM,
    );
    await openCase(60);

    await digests.markSent(moderatorId);
    await expect(digests.due()).resolves.toEqual([]);

    clock.set(new Date(NOON.getTime() + 180 * 60_000));
    await expect(digests.due()).resolves.toHaveLength(1);
  });

  /** 03:00 the next morning in Tehran: the queue can wait until it is light. */
  it('is not due at night in Tehran', async () => {
    await linkedAdmin('mod@payetam.test', ROLE_KEYS.MODERATOR, MODERATOR_TELEGRAM);
    await openCase(60);
    clock.set(new Date('2026-09-14T23:30:00.000Z'));

    await expect(digests.due()).resolves.toEqual([]);
  });
});
