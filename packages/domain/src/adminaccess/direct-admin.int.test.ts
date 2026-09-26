import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
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
import { MessageCipher } from '../crypto/message-cipher';
import { DirectMessageService } from '../direct/direct-message.service';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { DirectAdminService } from './direct-admin.service';

/**
 * Direct messages in the panel, as conversations (ADR-0020).
 *
 * What is pinned: a conversation is both directions between two people about
 * one activity; the list carries no words; the read decrypts, oldest first, and
 * leaves an audit row naming the conversation and never its content; and ids
 * that never spoke are indistinguishable from ids that do not exist.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY } as unknown as Env;

const cipher = new MessageCipher(env);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const directs = new DirectMessageService(service, clock, cipher, audit, outbox);
// Never authenticates, so Redis is never reached.
const access = new AdminAccessService(
  service,
  clock,
  { client: {} } as unknown as RedisService,
  new AdminCredentials(env),
  audit,
);
const admin = new DirectAdminService(service, access, cipher, audit);

const superAdmin: AdminSession = {
  adminUserId: 'direct-reader',
  email: 'owner@payetam.test',
  displayName: 'owner',
  roles: ['SUPER_ADMIN'],
  permissions: permissionsFor(['SUPER_ADMIN']),
};

let fixture: CatalogFixture;
let hostId: string;
let guestId: string;
let otherGuestId: string;
let eventPublicId: string;

async function profiledUser(displayName: string): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName, cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

async function publicIdOf(userId: string): Promise<string> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).publicId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await profiledUser('میزبان');
  guestId = await profiledUser('مهمان');
  otherGuestId = await profiledUser('مهمان دوم');

  const title = 'شب بازی رومیزی';
  const description = 'یک دورهمی دوستانه برای بازی رومیزی و گپ.';
  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date(NOW.getTime() + 7 * 86_400_000),
      endsAt: new Date(NOW.getTime() + 7 * 86_400_000 + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  eventPublicId = event.publicId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the list of conversations', () => {
  it('folds both directions between two people into one conversation', async () => {
    const question = await directs.send(guestId, eventPublicId, 'سلام، ماشین دارید؟');
    clock.set(new Date(NOW.getTime() + 60_000));
    await directs.reply(hostId, question, 'بله، ساعت هفت');
    await directs.send(otherGuestId, eventPublicId, 'من هم می‌آیم');

    const { threads, total } = await admin.listThreads(superAdmin, {});

    expect(total).toBe(2);
    const pair = threads.find((thread) => thread.messageCount === 2);
    expect(pair?.participants.map((party) => party.displayName).sort()).toEqual([
      'مهمان',
      'میزبان',
    ]);
    expect(pair?.participants.find((party) => party.displayName === 'میزبان')?.isHost).toBe(true);
  });

  it('carries no message text and no internal id', async () => {
    await directs.send(guestId, eventPublicId, 'سلام، ماشین دارید؟');

    const listed = JSON.stringify(await admin.listThreads(superAdmin, {}));
    expect(listed).not.toContain('ماشین');
    expect(listed).not.toContain(guestId);
    expect(listed).not.toContain(hostId);
  });

  it('narrows to the conversations one user is part of', async () => {
    await directs.send(guestId, eventPublicId, 'سلام');
    await directs.send(otherGuestId, eventPublicId, 'درود');

    const { threads } = await admin.listThreads(superAdmin, {
      userPublicId: await publicIdOf(otherGuestId),
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.participants.map((party) => party.displayName)).toContain('مهمان دوم');
  });

  it('writes nothing to the audit trail', async () => {
    await directs.send(guestId, eventPublicId, 'سلام');
    await admin.listThreads(superAdmin, {});

    await expect(prisma.auditLog.count({ where: { action: 'direct.thread_read' } })).resolves.toBe(
      0,
    );
  });
});

describe('reading one conversation', () => {
  it('decrypts it, oldest first, whoever started it', async () => {
    const question = await directs.send(guestId, eventPublicId, 'سلام، ماشین دارید؟');
    clock.set(new Date(NOW.getTime() + 60_000));
    await directs.reply(hostId, question, 'بله، ساعت هفت');

    const thread = await admin.readThread(superAdmin, {
      eventPublicId,
      userPublicId: await publicIdOf(hostId),
      otherUserPublicId: await publicIdOf(guestId),
    });

    expect(thread.messages.map((message) => message.body)).toEqual([
      'سلام، ماشین دارید؟',
      'بله، ساعت هفت',
    ]);
    expect(thread.messages[1]?.isReply).toBe(true);
    expect(thread.blockedBy).toEqual([]);
  });

  it('records who read which conversation, and never what it said', async () => {
    await directs.send(guestId, eventPublicId, 'سلام، ماشین دارید؟');
    await admin.readThread(superAdmin, {
      eventPublicId,
      userPublicId: await publicIdOf(guestId),
      otherUserPublicId: await publicIdOf(hostId),
    });

    const rows = await prisma.auditLog.findMany({ where: { action: 'direct.thread_read' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe('direct-reader');
    expect(JSON.stringify(rows)).not.toContain('ماشین');
  });

  it('shows a block between the two', async () => {
    const question = await directs.send(guestId, eventPublicId, 'سلام');
    await directs.block(hostId, question);
    const hostPublicId = await publicIdOf(hostId);

    const thread = await admin.readThread(superAdmin, {
      eventPublicId,
      userPublicId: hostPublicId,
      otherUserPublicId: await publicIdOf(guestId),
    });
    expect(thread.blockedBy).toEqual([hostPublicId]);
  });

  /** Otherwise the endpoint answers "have these two ever spoken?". */
  it('is NOT_FOUND for two people who never wrote to each other', async () => {
    await directs.send(guestId, eventPublicId, 'سلام');

    await expect(
      admin.readThread(superAdmin, {
        eventPublicId,
        userPublicId: await publicIdOf(guestId),
        otherUserPublicId: await publicIdOf(otherGuestId),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is refused without direct.read', async () => {
    const moderator: AdminSession = {
      ...superAdmin,
      roles: ['MODERATOR'],
      permissions: permissionsFor(['MODERATOR']),
    };
    await expect(admin.listThreads(moderator, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
