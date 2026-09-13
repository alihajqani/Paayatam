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
import { MessageCipher } from '../crypto/message-cipher';
import { normalize } from '../moderation/persian-normalizer';
import { planNotifications } from '../notifications/fanout';
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

/**
 * A host writing to a guest they accepted (plan 13, review H2).
 *
 * Until this existed a host could only *answer*: `send` addresses the host and
 * `reply` needs a received message, so a host whose guest never wrote first had
 * no way to say where to meet. The addressee is still never taken from the
 * caller — it is the user behind a participation the host's own activity holds.
 */
describe('a host writing to a guest', () => {
  let participantPublicId: string;

  beforeEach(async () => {
    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { id: true },
    });
    const participant = await prisma.eventParticipant.create({
      data: { eventId: event.id, userId: guestId, status: 'ACCEPTED', acceptedAt: NOW },
      select: { publicId: true },
    });
    participantPublicId = participant.publicId;
  });

  it('delivers to an accepted guest of their own activity', async () => {
    const publicId = await directs.sendToGuest(hostId, participantPublicId, 'ساعت ۶ جلوی کافه');

    const row = await prisma.directMessage.findUniqueOrThrow({
      where: { publicId },
      select: { senderUserId: true, recipientUserId: true, parentId: true },
    });
    expect(row).toEqual({ senderUserId: hostId, recipientUserId: guestId, parentId: null });
    await expect(directs.view(guestId, publicId)).resolves.toMatchObject({
      body: 'ساعت ۶ جلوی کافه',
      senderDisplayName: 'میزبان',
    });
  });

  it('writes to a guest after the activity, once they attended', async () => {
    await prisma.eventParticipant.update({
      where: { publicId: participantPublicId },
      data: { status: 'COMPLETED' },
    });
    await expect(
      directs.sendToGuest(hostId, participantPublicId, 'ممنون که آمدید'),
    ).resolves.toEqual(expect.any(String));
  });

  it.each(['PENDING', 'WAITLISTED', 'REJECTED', 'CANCELLED_BY_PARTICIPANT', 'NO_SHOW'] as const)(
    'refuses a guest who is %s',
    async (status) => {
      // `accepted_at` must be null for the statuses that never held a seat
      // (CHECK `event_participant_accepted_at_matches_status`).
      const neverSeated = status === 'PENDING' || status === 'WAITLISTED' || status === 'REJECTED';
      await prisma.eventParticipant.update({
        where: { publicId: participantPublicId },
        data: {
          status,
          ...(neverSeated ? { acceptedAt: null } : {}),
          // …and a withdrawal needs its timestamp (`event_participant_cancelled_at_present`).
          ...(status === 'CANCELLED_BY_PARTICIPANT' ? { cancelledAt: NOW } : {}),
        },
      });
      await expect(
        directs.sendToGuest(hostId, participantPublicId, 'سلام سلام'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );

  /** Not the host: the same answer as a participation that does not exist. */
  it('refuses anybody but the host, with the same answer', async () => {
    const stranger = await profiledUser('غریبه');
    await expect(
      directs.sendToGuest(stranger, participantPublicId, 'سلام سلام'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      directs.sendToGuest(hostId, '00000000-0000-4000-8000-000000000000', 'سلام سلام'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a deleted activity', async () => {
    await prisma.event.update({ where: { publicId: eventPublicId }, data: { deletedAt: NOW } });
    await expect(
      directs.sendToGuest(hostId, participantPublicId, 'سلام سلام'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets the guest answer it with the reply that already exists', async () => {
    const publicId = await directs.sendToGuest(hostId, participantPublicId, 'ساعت ۶');
    const answer = await directs.reply(guestId, publicId, 'باشه، می‌آیم');

    const row = await prisma.directMessage.findUniqueOrThrow({
      where: { publicId: answer },
      select: { recipientUserId: true },
    });
    expect(row.recipientUserId).toBe(hostId);
  });

  /** From the producer: the notification is addressed to the guest. */
  it('tells the guest, and nobody else', async () => {
    await directs.sendToGuest(hostId, participantPublicId, 'ساعت ۶');

    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: 'direct.message_sent' },
      select: { id: true, eventType: true, aggregateId: true, payload: true },
    });
    const { publicId: guestPublicId } = await prisma.user.findUniqueOrThrow({
      where: { id: guestId },
      select: { publicId: true },
    });
    const planned = planNotifications({ ...row, payload: row.payload as Record<string, unknown> });
    expect(planned.map((p) => p.userPublicId)).toEqual([guestPublicId]);
    expect(planned[0]?.payload['senderDisplayName']).toBe('میزبان');
  });
});
