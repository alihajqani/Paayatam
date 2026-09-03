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
import { SettingsService } from '../catalog/settings.service';
import { MessageCipher } from '../crypto/message-cipher';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { ChatUnsealService } from './chat-unseal.service';
import { ROLE_KEYS, type RoleKey } from './permissions';

/**
 * Break-glass chat access (M12, ADR-0010 T14).
 *
 * The property under test is that **three conditions are all required and none is
 * sufficient**: the permission, an open case naming the chat, and a written
 * reason. The plan singles out the second one — "chat unseal without an open case
 * is denied" — because it is the condition that puts the decision to look outside
 * the person looking.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials(env);
const cipher = new MessageCipher(env);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const unseal = new ChatUnsealService(service, clock, settings, cipher, access, audit);

let fixture: CatalogFixture;

function sessionFor(role: RoleKey, adminUserId: string): AdminSession {
  return {
    adminUserId,
    email: `${role.toLowerCase()}@payetam.test`,
    displayName: role,
    roles: [role],
    permissions: permissionsFor([role]),
  };
}

/** A real admin row, because the grant carries a foreign key to one. */
async function createAdmin(role: RoleKey): Promise<AdminSession> {
  const admin = await prisma.adminUser.create({
    data: {
      email: `${role.toLowerCase()}-${String(Date.now())}-${String(Math.random())}@payetam.test`,
      passwordHash: 'not-used-here',
      totpSecretEnc: 'not-used-here',
      displayName: role,
    },
    select: { id: true },
  });
  return sessionFor(role, admin.id);
}

/** A conversation with two messages in it, encrypted the way the product writes them. */
async function createChat(): Promise<{ chatPublicId: string; chatId: string }> {
  const hostId = await createUser(prisma, 'PROFILE_COMPLETE');
  const guestId = await createUser(prisma, 'PROFILE_COMPLETE');

  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title: 'دورهمی',
      description: 'یک دورهمی دوستانه برای گپ و بازی.',
      titleNormalized: 'دورهمی',
      descriptionNormalized: 'یک دورهمی دوستانه برای گپ و بازی.',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date('2026-09-20T15:00:00.000Z'),
      endsAt: new Date('2026-09-20T18:00:00.000Z'),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { id: true },
  });

  const participant = await prisma.eventParticipant.create({
    data: { eventId: event.id, userId: guestId, status: 'PENDING' },
    select: { id: true },
  });

  const chat = await prisma.anonymousChat.create({
    data: {
      eventId: event.id,
      participantId: participant.id,
      status: 'ANONYMOUS',
      nextSeq: 3,
      chatParticipants: {
        create: [
          { userId: hostId, role: 'HOST', alias: 'میزبان', aliasIndex: 0 },
          { userId: guestId, role: 'GUEST', alias: 'میهمان ۱', aliasIndex: 1 },
        ],
      },
    },
    select: { id: true, publicId: true, chatParticipants: { select: { id: true, role: true } } },
  });

  const guestSeat = chat.chatParticipants.find((row) => row.role === 'GUEST');
  for (const [index, text] of ['سلام، ساعت چند؟', 'باشه، می‌بینمت'].entries()) {
    const body = cipher.encrypt(text);
    await prisma.chatMessage.create({
      data: {
        chatId: chat.id,
        senderParticipantId: guestSeat?.id ?? null,
        seq: index + 1,
        kind: 'TEXT',
        bodyCiphertext: new Uint8Array(body.ciphertext),
        bodyNonce: new Uint8Array(body.nonce),
        keyVersion: body.keyVersion,
        retentionExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
  }

  return { chatPublicId: chat.publicId, chatId: chat.id };
}

async function openCaseFor(chatId: string): Promise<string> {
  const opened = await prisma.moderationCase.create({
    data: {
      subjectType: 'MESSAGE',
      subjectId: chatId,
      trigger: 'REPORT_THRESHOLD',
      status: 'OPEN',
      reportCount: 3,
    },
    select: { id: true },
  });
  return opened.id;
}

const REASON = 'investigating a reported threat in this conversation';

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('all three conditions are required (T14)', () => {
  /** The plan's own line: "chat unseal without an open case is denied". */
  it('denies an unseal with no open case, however senior the admin', async () => {
    const admin = await createAdmin(ROLE_KEYS.SUPER_ADMIN);
    const { chatPublicId } = await createChat();

    await expect(unseal.grant(admin, chatPublicId, REASON)).rejects.toMatchObject({
      code: 'UNSEAL_REQUIRES_OPEN_CASE',
    });
  });

  it('denies it when the only case has already been decided', async () => {
    const admin = await createAdmin(ROLE_KEYS.SUPER_ADMIN);
    const { chatPublicId, chatId } = await createChat();
    const caseId = await openCaseFor(chatId);
    await prisma.moderationCase.update({
      where: { id: caseId },
      data: {
        status: 'APPROVED',
        decidedBy: admin.adminUserId,
        decisionNote: 'nothing found',
        decidedAt: NOW,
      },
    });

    await expect(unseal.grant(admin, chatPublicId, REASON)).rejects.toMatchObject({
      code: 'UNSEAL_REQUIRES_OPEN_CASE',
    });
  });

  it('denies it without the permission, even with an open case', async () => {
    const admin = await createAdmin(ROLE_KEYS.SUPPORT);
    const { chatPublicId, chatId } = await createChat();
    await openCaseFor(chatId);

    await expect(unseal.grant(admin, chatPublicId, REASON)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('denies it without a written reason', async () => {
    const admin = await createAdmin(ROLE_KEYS.MODERATOR);
    const { chatPublicId, chatId } = await createChat();
    await openCaseFor(chatId);

    await expect(unseal.grant(admin, chatPublicId, 'why')).rejects.toMatchObject({
      code: 'UNSEAL_REASON_REQUIRED',
    });
  });

  it('grants fifteen minutes when all three hold', async () => {
    const admin = await createAdmin(ROLE_KEYS.MODERATOR);
    const { chatPublicId, chatId } = await createChat();
    await openCaseFor(chatId);

    const grant = await unseal.grant(admin, chatPublicId, REASON);
    expect(grant.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
  });

  /** A grant that never expires is standing access. The CHECK says so too. */
  it('refuses a grant with no expiry at the database level', async () => {
    const admin = await createAdmin(ROLE_KEYS.MODERATOR);
    const { chatId } = await createChat();
    const caseId = await openCaseFor(chatId);

    await expect(
      prisma.chatUnsealGrant.create({
        data: {
          chatId,
          adminUserId: admin.adminUserId,
          moderationCaseId: caseId,
          reason: REASON,
          grantedAt: NOW,
          expiresAt: NOW,
        },
      }),
    ).rejects.toThrow(/chat_unseal_grant_is_time_boxed/);
  });
});

describe('reading under a grant', () => {
  async function granted(): Promise<{ admin: AdminSession; grantId: string }> {
    const admin = await createAdmin(ROLE_KEYS.MODERATOR);
    const { chatPublicId, chatId } = await createChat();
    await openCaseFor(chatId);
    const grant = await unseal.grant(admin, chatPublicId, REASON);
    return { admin, grantId: grant.grantId };
  }

  it('decrypts the conversation and names the sides by alias only', async () => {
    const { admin, grantId } = await granted();

    const messages = await unseal.read(admin, grantId);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.body).toBe('سلام، ساعت چند؟');
    expect(messages[0]?.senderAlias).toBe('میهمان ۱');
    // No identity of any kind reaches this projection.
    expect(JSON.stringify(messages)).not.toContain('userId');
  });

  /**
   * **One audit row per message**, which is the part of T14 that is easy to soften
   * into "one row per session" and must not be. A session row answers "somebody
   * opened this chat"; a per-message row answers what they actually read.
   */
  it('writes one audit row per message read, not one per session', async () => {
    const { admin, grantId } = await granted();
    await unseal.read(admin, grantId);

    const rows = await prisma.auditLog.findMany({ where: { action: 'chat.message_read' } });
    expect(rows).toHaveLength(2);
  });

  /** The trail records that a message was read, never what it said. */
  it('never copies the plaintext into the audit trail', async () => {
    const { admin, grantId } = await granted();
    await unseal.read(admin, grantId);

    const rows = await prisma.auditLog.findMany({ where: { action: 'chat.message_read' } });
    expect(JSON.stringify(rows)).not.toContain('سلام، ساعت چند؟');
  });

  it('refuses once the fifteen minutes are up', async () => {
    const { admin, grantId } = await granted();
    clock.set(new Date(NOW.getTime() + 16 * 60_000));

    await expect(unseal.read(admin, grantId)).rejects.toMatchObject({
      code: 'UNSEAL_GRANT_EXPIRED',
    });
  });

  /**
   * Somebody else's grant is not a grant, and the refusal is a 404 rather than a
   * 403: whether a colleague is investigating a conversation is not something this
   * endpoint confirms.
   */
  it('refuses another admin’s grant, without confirming it exists', async () => {
    const { grantId } = await granted();
    const other = await createAdmin(ROLE_KEYS.MODERATOR);

    await expect(unseal.read(other, grantId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('counts the reads on the grant, for the weekly digest', async () => {
    const { admin, grantId } = await granted();
    await unseal.read(admin, grantId);

    const row = await prisma.chatUnsealGrant.findUniqueOrThrow({ where: { id: grantId } });
    expect(row.readCount).toBe(2);
  });
});

/**
 * The digest is the control that makes misuse visible **to somebody other than the
 * person doing it** — the only kind of oversight that works on a capability its
 * own holder authorises. Producing it is M12's; sending it is M13's.
 */
describe('the weekly digest (T14)', () => {
  it('lists every grant in the window with its reason and read count', async () => {
    const admin = await createAdmin(ROLE_KEYS.MODERATOR);
    const { chatPublicId, chatId } = await createChat();
    await openCaseFor(chatId);
    const grant = await unseal.grant(admin, chatPublicId, REASON);
    await unseal.read(admin, grant.grantId);

    const digest = await unseal.recentGrants(new Date(NOW.getTime() - 7 * 24 * 3_600_000));

    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({
      chatPublicId,
      reason: REASON,
      readCount: 2,
    });
    expect(digest[0]?.adminEmail).toContain('@payetam.test');
  });
});
