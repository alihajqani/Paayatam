import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { MessageCipher } from '../chat/message-cipher';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import { DirectMessageService } from './direct-message.service';

/**
 * «دایرکت» (v0.7.0).
 *
 * Three properties want a real database: the body is **encrypted at rest**, the
 * read receipt fires **once**, and the addressing rules are enforced by the
 * service rather than by the button that reached it. None can be shown against a
 * mock.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);

const cipher = new MessageCipher({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as unknown as Env);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const directs = new DirectMessageService(service, clock, cipher, audit, outbox);

let fixture: CatalogFixture;
let hostId: string;
let guestId: string;
let eventPublicId: string;

async function profiledUser(displayName: string): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName, cityId: fixture.tehranId, birthYear: 1995 },
  });
  return userId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  hostId = await profiledUser('میزبان');
  guestId = await profiledUser('مهمان');

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

describe('writing to the host of an activity', () => {
  it('stores the body encrypted, and reads it back', async () => {
    const publicId = await directs.send(guestId, eventPublicId, 'سلام، ماشین دارید؟');

    const row = await prisma.directMessage.findUniqueOrThrow({
      where: { publicId },
      select: { bodyCiphertext: true, recipientUserId: true, senderUserId: true, seenAt: true },
    });
    // The plaintext is nowhere in the column. The one assertion here that would
    // still pass with a no-op cipher, so it checks the bytes.
    expect(Buffer.from(row.bodyCiphertext).toString('utf8')).not.toContain('ماشین');
    expect(row.recipientUserId).toBe(hostId);
    expect(row.senderUserId).toBe(guestId);
    expect(row.seenAt).toBeNull();

    const read = await directs.view(hostId, publicId);
    expect(read.body).toBe('سلام، ماشین دارید؟');
    expect(read.senderDisplayName).toBe('مهمان');
    expect(read.eventTitle).toBe('شب بازی رومیزی');
  });

  /**
   * The addressee is derived from the activity and never taken from the caller,
   * which is what makes a tampered id useless rather than dangerous.
   */
  it('addresses the host, whoever the writer is', async () => {
    const stranger = await profiledUser('غریبه');
    const publicId = await directs.send(stranger, eventPublicId, 'ساعتش دقیقاً چند است؟');

    const row = await prisma.directMessage.findUniqueOrThrow({
      where: { publicId },
      select: { recipientUserId: true },
    });
    expect(row.recipientUserId).toBe(hostId);
  });

  it('refuses a host writing to their own activity', async () => {
    await expect(directs.send(hostId, eventPublicId, 'به خودم')).rejects.toMatchObject({
      code: 'HOST_CANNOT_JOIN',
    });
  });

  it('refuses an activity that does not exist, and one that was deleted', async () => {
    await expect(
      directs.send(guestId, '00000000-0000-4000-8000-000000000000', 'سلام'),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });

    await prisma.event.update({ where: { publicId: eventPublicId }, data: { deletedAt: NOW } });
    await expect(directs.send(guestId, eventPublicId, 'سلام')).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
    });
  });

  it('refuses an empty message and one that is too long', async () => {
    await expect(directs.send(guestId, eventPublicId, '   ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(directs.send(guestId, eventPublicId, 'ا'.repeat(1001))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  /** The trail records that a message was sent; the words are why the row is encrypted. */
  it('audits the send without recording what it said', async () => {
    await directs.send(guestId, eventPublicId, 'شمارهٔ من ۰۹۱۲…');

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'direct.message_sent' },
    });
    expect(JSON.stringify(entry.after)).not.toContain('۰۹۱۲');
  });

  /**
   * The notification names who and about what, and **not the words** — which is
   * what keeps the plaintext out of a jsonb column staff can read, and what makes
   * the read receipt honest.
   */
  it('announces it without the body', async () => {
    await directs.send(guestId, eventPublicId, 'یک راز');

    const emitted = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'direct.message_sent' },
      select: { payload: true },
    });
    const payload = emitted.payload as Record<string, unknown>;
    expect(payload['senderDisplayName']).toBe('مهمان');
    expect(payload['eventTitle']).toBe('شب بازی رومیزی');
    expect(JSON.stringify(payload)).not.toContain('یک راز');
    // Public ids only, like every payload that becomes a message (invariant 7).
    expect(JSON.stringify(payload)).not.toContain(hostId);
    expect(JSON.stringify(payload)).not.toContain(guestId);
  });
});

describe('reading one', () => {
  it('records the read once, and tells the sender once', async () => {
    const publicId = await directs.send(guestId, eventPublicId, 'سلام');

    const later = new Date(NOW.getTime() + 60_000);
    clock.set(later);
    const first = await directs.view(hostId, publicId);
    expect(first.seenAt).toEqual(later);

    clock.set(new Date(NOW.getTime() + 120_000));
    const second = await directs.view(hostId, publicId);
    // Unchanged: a second open is not a second reading.
    expect(second.seenAt).toEqual(later);

    await expect(
      prisma.outboxEvent.count({ where: { eventType: 'direct.message_seen' } }),
    ).resolves.toBe(1);
  });

  /** The sender may re-read their own message, and doing so marks nothing. */
  it('lets the sender re-read without marking it seen', async () => {
    const publicId = await directs.send(guestId, eventPublicId, 'سلام');

    const read = await directs.view(guestId, publicId);

    expect(read.viewerIsRecipient).toBe(false);
    expect(read.seenAt).toBeNull();
    await expect(
      prisma.outboxEvent.count({ where: { eventType: 'direct.message_seen' } }),
    ).resolves.toBe(0);
  });

  /** A message belongs to exactly two accounts. Everybody else gets a 404. */
  it('tells a stranger the message does not exist', async () => {
    const publicId = await directs.send(guestId, eventPublicId, 'سلام');
    const stranger = await profiledUser('غریبه');

    await expect(directs.view(stranger, publicId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('answering one', () => {
  it('goes back to whoever wrote it, and keeps the activity', async () => {
    const first = await directs.send(guestId, eventPublicId, 'ماشین دارید؟');

    const answer = await directs.reply(hostId, first, 'بله، هماهنگ می‌کنیم.');

    const row = await prisma.directMessage.findUniqueOrThrow({
      where: { publicId: answer },
      select: {
        senderUserId: true,
        recipientUserId: true,
        parentId: true,
        event: { select: { publicId: true } },
      },
    });
    expect(row.senderUserId).toBe(hostId);
    expect(row.recipientUserId).toBe(guestId);
    expect(row.parentId).not.toBeNull();
    expect(row.event.publicId).toBe(eventPublicId);

    const read = await directs.view(guestId, answer);
    expect(read.body).toBe('بله، هماهنگ می‌کنیم.');
    expect(read.senderDisplayName).toBe('میزبان');
  });

  /**
   * Only the **recipient** may answer, which is what keeps a thread between the
   * two people it started between — and what makes a public id useless to
   * anybody else holding one.
   */
  it('refuses a reply from anybody but the account it was addressed to', async () => {
    const first = await directs.send(guestId, eventPublicId, 'سلام');
    const stranger = await profiledUser('غریبه');

    // Not the sender either: answering your own message is not a reply.
    await expect(directs.reply(guestId, first, 'خودم')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(directs.reply(stranger, first, 'من')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('announces a reply as a reply', async () => {
    const first = await directs.send(guestId, eventPublicId, 'سلام');
    await directs.reply(hostId, first, 'سلام، بله');

    const emitted = await prisma.outboxEvent.findMany({
      where: { eventType: 'direct.message_sent' },
      orderBy: { createdAt: 'asc' },
      select: { payload: true },
    });
    expect((emitted[0]?.payload as Record<string, unknown>)['isReply']).toBe(false);
    expect((emitted[1]?.payload as Record<string, unknown>)['isReply']).toBe(true);
  });

  /** A thread can run in both directions, indefinitely. */
  it('lets the two of them go back and forth', async () => {
    const a = await directs.send(guestId, eventPublicId, 'یک');
    const b = await directs.reply(hostId, a, 'دو');
    const c = await directs.reply(guestId, b, 'سه');

    const read = await directs.view(hostId, c);
    expect(read.body).toBe('سه');
    await expect(prisma.directMessage.count()).resolves.toBe(3);
  });
});
