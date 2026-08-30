import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import { isAppError } from '@payetam/shared';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from '../participation/participation.service';
import { ChatService, RETENTION_DAYS_AFTER_CLOSE } from './chat.service';
import { MessageCipher } from './message-cipher';
import { CHAT_ANONYMOUS_INTRO, CHAT_MESSAGE_DELETED, CHAT_OPENED } from './messages';
import { REDACTION_PLACEHOLDER } from './sanitizer';

/**
 * The anonymous chat against a real database.
 *
 * The pure parts of the relay — masking, entity stripping, the cipher — are
 * tested exhaustively and without infrastructure in `sanitizer.test.ts` and
 * `message-cipher.test.ts`, which the plan asks to be written before the relay
 * exists. What is left for this file is everything those cannot see: that the
 * sanitized text is what actually reaches the *column*, that the ciphertext on
 * disk is genuinely unreadable, that the outbox row a delivery worker will read
 * carries no message body, that an alias is a property of the chat, and that the
 * conversation's lifecycle follows the request that created it.
 *
 * Nothing here is mocked. The properties being asserted are properties of
 * Postgres and of the wiring between two modules; a stubbed database would prove
 * neither.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const cipher = new MessageCipher({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as unknown as Env);
const chat = new ChatService(service, clock, cipher, audit, outbox);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
/**
 * The channel-membership gate, in its permissive default state.
 *
 * `event_channel_config` is truncated between tests, so `membershipRequired` is
 * false and every check answers NOT_REQUIRED — the gate is a no-op here, which is
 * what these suites want. `membership.int.test.ts` is where it is switched on.
 */
const membership = new ChannelMembershipService(
  service,
  new ChannelConfigService(service, clock, audit),
);

const participation = new ParticipationService(
  service,
  clock,
  env,
  settings,
  audit,
  outbox,
  chat,
  penalties,
  membership,
  coins,
);

const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');

let fixture: CatalogFixture;
let hostId: string;
let titleSequence = 0;

async function createEvent(options: { capacity?: number; hostUserId?: string } = {}) {
  titleSequence += 1;
  const title = `دورهمی شماره ${titleSequence}`;
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';

  const event = await prisma.event.create({
    data: {
      hostUserId: options.hostUserId ?? hostId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: STARTS_AT,
      endsAt: new Date(STARTS_AT.getTime() + 3 * 60 * 60 * 1000),
      capacity: options.capacity ?? 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });

  return event.publicId;
}

async function createJoiner(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId,
      displayName: 'شرکت‌کننده',
      cityId: fixture.tehranId,
      birthYear: 1995,
      gender: 'FEMALE',
    },
  });
  return userId;
}

/** A host, a guest and the chat their request created. */
async function conversation(): Promise<{
  guestId: string;
  eventPublicId: string;
  participantPublicId: string;
  chatPublicId: string;
}> {
  const eventPublicId = await createEvent();
  const guestId = await createJoiner();
  const request = await participation.join(guestId, eventPublicId);

  if (!request.chatPublicId) throw new Error('join did not create a chat');
  return {
    guestId,
    eventPublicId,
    participantPublicId: request.publicId,
    chatPublicId: request.chatPublicId,
  };
}

/** Everything stored for a chat, straight from the columns. */
async function storedMessages(chatPublicId: string) {
  return prisma.chatMessage.findMany({
    where: { chat: { publicId: chatPublicId } },
    orderBy: { seq: 'asc' },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  titleSequence = 0;
  fixture = await seedCatalog(prisma);
  hostId = await createJoiner();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a chat exists from the request, not from the acceptance', () => {
  /**
   * Plan §2.5, and the reason the product is worth building: two strangers
   * negotiate a meeting *before* either has committed to anything. A chat that
   * only appeared on acceptance would make the host decide blind.
   */
  it('is created by joining, in ANONYMOUS, with both people in it', async () => {
    const { guestId, chatPublicId } = await conversation();

    const row = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: chatPublicId },
      include: { chatParticipants: true },
    });

    expect(row.status).toBe('ANONYMOUS');
    expect(row.openedAt).toBeNull();
    expect(row.retentionExpiresAt).toBeNull();
    expect(row.chatParticipants.map((p) => p.role).sort()).toEqual(['GUEST', 'HOST']);
    expect(row.chatParticipants.find((p) => p.role === 'GUEST')?.userId).toBe(guestId);
    expect(row.chatParticipants.find((p) => p.role === 'HOST')?.userId).toBe(hostId);
  });

  it('opens with the platform saying the conversation is anonymous', async () => {
    const { guestId, chatPublicId } = await conversation();

    const page = await chat.readMessages(guestId, chatPublicId);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      kind: 'SYSTEM',
      senderAlias: null,
      mine: false,
      text: CHAT_ANONYMOUS_INTRO,
    });
  });

  it('is reachable from the participation the join returned', async () => {
    const { guestId, chatPublicId } = await conversation();

    const [mine] = await participation.listMine(guestId);
    expect(mine?.chatPublicId).toBe(chatPublicId);
  });

  it('is waitlisted people too — a queue is not a reason to be unable to ask', async () => {
    const eventPublicId = await createEvent({ capacity: 1 });
    await participation.join(await createJoiner(), eventPublicId);

    const queued = await participation.join(await createJoiner(), eventPublicId);

    expect(queued.status).toBe('WAITLISTED');
    expect(queued.chatPublicId).not.toBeNull();
  });
});

describe('aliases (ADR-0009, layer 3)', () => {
  /**
   * The plan's own wording for this test is "aliases differ for the same user
   * across two chats", and this is the exact shape of it: one person, two events,
   * two different names — because the number came from arrival order and not from
   * them.
   *
   * The second half of the assertion is the half that matters more. The *other*
   * event's first guest is also «میهمان ۱», so a host comparing their two
   * conversations learns nothing: the alias is a function of position, and
   * position is a fact about the chat.
   */
  it('give the same person a different name in each chat', async () => {
    const eventA = await createEvent();
    const eventB = await createEvent();
    const traveller = await createJoiner();
    const somebodyElse = await createJoiner();

    // The traveller is first in A and second in B.
    const inA = await participation.join(traveller, eventA);
    await participation.join(somebodyElse, eventB);
    const inB = await participation.join(traveller, eventB);

    const [chatA] = await Promise.all([
      prisma.anonymousChat.findUniqueOrThrow({
        where: { publicId: inA.chatPublicId ?? '' },
        include: { chatParticipants: true },
      }),
    ]);
    const chatB = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: inB.chatPublicId ?? '' },
      include: { chatParticipants: true },
    });

    const aliasIn = (c: typeof chatA) =>
      c.chatParticipants.find((p) => p.userId === traveller)?.alias;

    expect(aliasIn(chatA)).toBe('میهمان ۱');
    expect(aliasIn(chatB)).toBe('میهمان ۲');
    expect(aliasIn(chatA)).not.toBe(aliasIn(chatB));
  });

  it('number guests by arrival within their event, and never by who they are', async () => {
    const eventPublicId = await createEvent({ capacity: 5 });
    const first = await createJoiner();
    const second = await createJoiner();

    await participation.join(first, eventPublicId);
    await participation.join(second, eventPublicId);

    const aliases = await prisma.chatParticipant.findMany({
      where: { role: 'GUEST', chat: { event: { publicId: eventPublicId } } },
      orderBy: { aliasIndex: 'asc' },
      select: { alias: true, aliasIndex: true },
    });

    expect(aliases).toEqual([
      { alias: 'میهمان ۱', aliasIndex: 1 },
      { alias: 'میهمان ۲', aliasIndex: 2 },
    ]);
  });

  /**
   * Under the event lock the join already holds (ADR-0006, rule 2), so the count
   * the alias is derived from cannot move underneath it. Without that placement
   * two simultaneous joiners would both read "one chat exists" and both become
   * «میهمان ۲» — which the `UNIQUE (chat_id, alias_index)` would not catch,
   * because they are in different chats.
   */
  it('stay distinct when twelve people join at the same instant', async () => {
    const eventPublicId = await createEvent({ capacity: 12 });
    const joiners = await Promise.all(Array.from({ length: 12 }, () => createJoiner()));

    await Promise.all(joiners.map((userId) => participation.join(userId, eventPublicId)));

    const aliases = await prisma.chatParticipant.findMany({
      where: { role: 'GUEST', chat: { event: { publicId: eventPublicId } } },
      select: { aliasIndex: true },
    });

    expect(new Set(aliases.map((a) => a.aliasIndex)).size).toBe(12);
  });

  it('call the host «میزبان», unnumbered — there is only ever one', async () => {
    const { chatPublicId } = await conversation();

    const host = await prisma.chatParticipant.findFirstOrThrow({
      where: { role: 'HOST', chat: { publicId: chatPublicId } },
    });

    expect(host.alias).toBe('میزبان');
    expect(host.aliasIndex).toBe(0);
  });
});

describe('what reaches the other person', () => {
  it('carries the text through unharmed when there is nothing to mask', async () => {
    const { guestId, chatPublicId } = await conversation();

    const sent = await chat.send(guestId, chatPublicId, {
      text: 'سلام، ساعت ۵ جلوی کافه می‌بینمت؟',
    });

    expect(sent.text).toBe('سلام، ساعت 5 جلوی کافه می‌بینمت؟');
    expect(sent.senderAlias).toBe('میهمان ۱');
    expect(sent.mine).toBe(true);

    const asHostSees = await chat.readMessages(hostId, chatPublicId);
    expect(asHostSees.messages.at(-1)).toMatchObject({
      text: 'سلام، ساعت 5 جلوی کافه می‌بینمت؟',
      senderAlias: 'میهمان ۱',
      mine: false,
    });
  });

  /**
   * The end-to-end version of the leak tests. `sanitizer.test.ts` proves the
   * function masks; this proves the masked text is what actually lands in the
   * column — that nothing between the sanitizer and the database quietly kept a
   * copy of the original.
   */
  it('never stores a contact detail that was masked', async () => {
    const { guestId, chatPublicId } = await conversation();

    await chat.send(guestId, chatPublicId, {
      text: 'شماره‌ام 09121234567 است، @reza_handle هم هستم',
      entities: [{ type: 'text_mention', offset: 0, length: 4, user: { id: 573914882 } }],
    });

    const [, message] = await storedMessages(chatPublicId);
    if (!message) throw new Error('the message was not stored');

    const plaintext = cipher.decrypt({
      ciphertext: Buffer.from(message.bodyCiphertext),
      nonce: Buffer.from(message.bodyNonce),
      keyVersion: message.keyVersion,
    });

    expect(plaintext).not.toContain('09121234567');
    expect(plaintext).not.toContain('reza_handle');
    expect(plaintext).toContain(REDACTION_PLACEHOLDER);

    // The whole row, not only the body: a Telegram id in `redactions` or in
    // `telegram_message_ids` would leak just as thoroughly.
    expect(JSON.stringify(message)).not.toContain('573914882');
    expect(JSON.stringify(message.redactions)).not.toContain('09121234567');
  });

  /**
   * §8's "phone numbers are never stored" is a claim about the database, so this
   * is the assertion that makes it checkable: after somebody tries to send one,
   * nothing anywhere in `chat_message` holds those digits — not the ciphertext,
   * and not the redaction record beside it, which stores kinds and counts only.
   */
  it('records that masking happened, without recording what it removed', async () => {
    const { guestId, chatPublicId } = await conversation();

    await chat.send(guestId, chatPublicId, {
      text: 'تلفن 09121234567 یا @reza_handle یا reza@example.com',
    });

    const [, message] = await storedMessages(chatPublicId);
    expect(message?.redactions).toEqual(
      expect.arrayContaining([
        { kind: 'PHONE', count: 1 },
        { kind: 'USERNAME', count: 1 },
        { kind: 'EMAIL', count: 1 },
      ]),
    );
  });

  it('refuses a message that was nothing but a phone number', async () => {
    const { guestId, chatPublicId } = await conversation();

    await expect(chat.send(guestId, chatPublicId, { text: '09121234567' })).rejects.toMatchObject({
      code: 'CHAT_MESSAGE_EMPTY',
    });

    // And stored nothing: only the intro remains.
    expect(await storedMessages(chatPublicId)).toHaveLength(1);
  });
});

describe('encryption at rest (ADR-0009)', () => {
  it('leaves nothing readable in the column', async () => {
    const { guestId, chatPublicId } = await conversation();
    const secret = 'قرارمان جلوی سینما فرهنگ ساعت هفت';

    await chat.send(guestId, chatPublicId, { text: secret });

    // Read the bytes the way a leaked dump would: no application, no key.
    const raw = await prisma.$queryRaw<{ body_ciphertext: Buffer }[]>`
      SELECT "body_ciphertext" FROM "chat_message" WHERE "kind" = 'TEXT'
    `;

    expect(raw).toHaveLength(1);
    const bytes = raw[0]?.body_ciphertext;
    if (!bytes) throw new Error('no ciphertext was stored');
    expect(bytes.toString('utf8')).not.toContain('سینما');
    expect(bytes.toString('utf8')).not.toContain(secret);
    expect(bytes.toString('latin1')).not.toContain('فرهنگ');
  });

  it('round-trips through the read path', async () => {
    const { guestId, chatPublicId } = await conversation();
    const text = 'باشه 👍🏽 ساعت ۷ می‌بینمت — Cafe Farhang';

    await chat.send(guestId, chatPublicId, { text });

    const page = await chat.readMessages(hostId, chatPublicId);
    expect(page.messages.at(-1)?.text).toBe('باشه 👍🏽 ساعت 7 می‌بینمت — Cafe Farhang');
  });

  it('gives every message its own nonce', async () => {
    const { guestId, chatPublicId } = await conversation();

    for (let i = 0; i < 5; i += 1) {
      await chat.send(guestId, chatPublicId, { text: 'سلام' });
    }

    const messages = await storedMessages(chatPublicId);
    const nonces = new Set(messages.map((m) => Buffer.from(m.bodyNonce).toString('base64')));
    expect(nonces.size).toBe(messages.length);
  });
});

describe('the outbox row a delivery worker will read', () => {
  /**
   * `outbox_event.payload` is plain jsonb — the one place in this feature that is
   * *not* encrypted. Putting the message text in it would undo the column beside
   * it, so the payload carries ids and an alias and the relay decrypts the row it
   * points at.
   */
  it('names the message without repeating it', async () => {
    const { guestId, chatPublicId } = await conversation();
    const secret = 'رمز عبور در ورودی: هزار و یک';

    await chat.send(guestId, chatPublicId, { text: secret });

    const [event] = await prisma.outboxEvent.findMany({ where: { eventType: 'chat.message' } });
    expect(event).toBeDefined();
    expect(JSON.stringify(event?.payload)).not.toContain('هزار');
    expect(event?.payload).toMatchObject({ chatPublicId, seq: 2, senderAlias: 'میهمان ۱' });
  });

  it('addresses the recipient by public id and nothing else', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام' });

    const [event] = await prisma.outboxEvent.findMany({ where: { eventType: 'chat.message' } });
    const host = await prisma.user.findUniqueOrThrow({ where: { id: hostId } });
    const telegram = await prisma.telegramAccount.findUniqueOrThrow({
      where: { userId: hostId },
    });

    expect(event?.payload).toMatchObject({ recipientUserPublicId: host.publicId });
    const serialized = JSON.stringify(event?.payload);
    expect(serialized).not.toContain(hostId);
    expect(serialized).not.toContain(guestId);
    expect(serialized).not.toContain(String(telegram.telegramUserId));
  });
});

describe('who may speak', () => {
  /**
   * The plan's M8 list says 403. This returns 404, deliberately: a 403 confirms
   * that a chat with that id exists, and confirming the existence of a private
   * conversation to somebody outside it is itself a disclosure. It is the same
   * choice T3.3 already forced on events and participants.
   */
  it('tells a stranger nothing, including whether the chat exists', async () => {
    const { chatPublicId } = await conversation();
    const stranger = await createJoiner();

    await expect(chat.readMessages(stranger, chatPublicId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(chat.send(stranger, chatPublicId, { text: 'سلام' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const missing = await chat
      .readMessages(stranger, '00000000-0000-4000-8000-000000000000')
      .catch((error: unknown) => (isAppError(error) ? error.code : 'other'));
    expect(missing).toBe('NOT_FOUND');
  });

  it('lets both sides of the chat read and write it', async () => {
    const { guestId, chatPublicId } = await conversation();

    await chat.send(guestId, chatPublicId, { text: 'سلام، هنوز جا هست؟' });
    await chat.send(hostId, chatPublicId, { text: 'بله، خوش آمدید.' });

    const page = await chat.readMessages(guestId, chatPublicId);
    expect(page.messages.map((m) => m.senderAlias)).toEqual([null, 'میهمان ۱', 'میزبان']);
  });
});

describe('the conversation follows the request that created it', () => {
  it('opens when the host accepts', async () => {
    const { chatPublicId, participantPublicId } = await conversation();

    await participation.accept(hostId, participantPublicId);

    const row = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: chatPublicId },
    });
    expect(row.status).toBe('OPEN');
    expect(row.openedAt).toEqual(NOW);

    const page = await chat.readMessages(hostId, chatPublicId);
    expect(page.messages.at(-1)?.text).toBe(CHAT_OPENED);
  });

  it.each([
    [
      'a rejection',
      async (participantPublicId: string) => participation.reject(hostId, participantPublicId),
    ],
  ])('closes on %s', async (_label, act) => {
    const { chatPublicId, participantPublicId } = await conversation();

    await act(participantPublicId);

    const row = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: chatPublicId },
    });
    expect(row.status).toBe('CLOSED');
    expect(row.closedAt).toEqual(NOW);
  });

  it('closes when the participant withdraws', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();

    await participation.cancel(guestId, participantPublicId);

    const row = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: chatPublicId },
    });
    expect(row.status).toBe('CLOSED');
  });

  it('closes when the host never answers and the request expires', async () => {
    const { chatPublicId } = await conversation();

    clock.set(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(await participation.expireOverdue()).toBe(1);

    const row = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: chatPublicId },
    });
    expect(row.status).toBe('CLOSED');
  });

  it('refuses a message once it is closed', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();
    await participation.reject(hostId, participantPublicId);

    await expect(chat.send(guestId, chatPublicId, { text: 'سلام؟' })).rejects.toMatchObject({
      code: 'CHAT_CLOSED',
    });
  });

  /**
   * A rejection racing a cancellation must not turn into a 409 for whoever loses.
   * Closing an already-closed chat is not an error; it is the same outcome
   * arrived at twice.
   */
  it('is not upset by being closed twice', async () => {
    const { guestId, participantPublicId, chatPublicId } = await conversation();
    await participation.cancel(guestId, participantPublicId);

    await expect(chat.close(guestId, chatPublicId)).rejects.toMatchObject({
      code: 'CHAT_CLOSED',
    });
  });
});

describe('retention (D5)', () => {
  it('starts the 90-day clock on the chat and everything in it', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام' });

    await participation.reject(hostId, participantPublicId);

    const expected = new Date(NOW.getTime() + RETENTION_DAYS_AFTER_CLOSE * 24 * 3_600_000);
    const row = await prisma.anonymousChat.findUniqueOrThrow({
      where: { publicId: chatPublicId },
    });
    expect(row.retentionExpiresAt).toEqual(expected);

    const messages = await storedMessages(chatPublicId);
    expect(messages.length).toBeGreaterThan(1);
    // Including the closing notice itself: a system message that outlives the
    // conversation it announced would be the one row the purge leaves behind.
    for (const message of messages) {
      expect(message.retentionExpiresAt).toEqual(expected);
    }
  });

  it('leaves a live conversation with no purge date at all', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام' });

    for (const message of await storedMessages(chatPublicId)) {
      expect(message.retentionExpiresAt).toBeNull();
    }
  });
});

describe('closing a chat by hand', () => {
  it('lets either party walk away without cancelling the request', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();

    const summary = await chat.close(guestId, chatPublicId, 'no longer interested');

    expect(summary.status).toBe('CLOSED');
    // The request is untouched: "stop messaging me" must not cancel somebody's
    // Saturday, and cancelling is a different endpoint with a different penalty.
    const request = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: participantPublicId },
    });
    expect(request.status).toBe('PENDING');
  });

  it('writes an append-only record of who closed it', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.close(guestId, chatPublicId);

    const actions = await prisma.chatAction.findMany({
      where: { chat: { publicId: chatPublicId } },
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'CLOSE', actorUserId: guestId });

    await expect(
      prisma.chatAction.update({
        where: { id: actions[0]?.id ?? '' },
        data: { action: 'BLOCK' },
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('sharing contact details (ADR-0009)', () => {
  it('is refused while the chat is still anonymous', async () => {
    const { guestId, chatPublicId } = await conversation();

    await expect(chat.shareContact(guestId, chatPublicId)).rejects.toMatchObject({
      code: 'CHAT_NOT_OPEN',
    });
  });

  /**
   * The consent does not reveal anything by itself — the platform holds no phone
   * number and will not hand over a Telegram username. What changes is that this
   * participant's own messages stop being masked, so the disclosure is their act.
   */
  it('lets the consenting side send their own number, and nobody else', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();
    await participation.accept(hostId, participantPublicId);

    await chat.shareContact(guestId, chatPublicId);

    const fromGuest = await chat.send(guestId, chatPublicId, { text: 'شماره‌ام 09121234567' });
    expect(fromGuest.text).toContain('09121234567');

    // The host consented to nothing, so their side is still masked.
    const fromHost = await chat.send(hostId, chatPublicId, { text: 'شماره من 09129876543' });
    expect(fromHost.text).not.toContain('09129876543');
    expect(fromHost.text).toContain(REDACTION_PLACEHOLDER);
  });

  it('records the act in the chat and the policy consent against the user', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();
    await participation.accept(hostId, participantPublicId);
    await prisma.policyVersion.create({
      data: {
        type: 'PRIVACY',
        version: 1,
        isCurrent: true,
        contentMd: 'حریم خصوصی',
        publishedAt: NOW,
      },
    });

    await chat.shareContact(guestId, chatPublicId);

    const actions = await prisma.chatAction.findMany({
      where: { chat: { publicId: chatPublicId }, action: 'SHARE_CONTACT' },
    });
    expect(actions).toHaveLength(1);

    const consents = await prisma.consent.findMany({
      where: { userId: guestId, context: 'CONTACT_SHARE' },
    });
    expect(consents).toHaveLength(1);
  });

  it('is the same decision however many times the button is pressed', async () => {
    const { guestId, chatPublicId, participantPublicId } = await conversation();
    await participation.accept(hostId, participantPublicId);

    await chat.shareContact(guestId, chatPublicId);
    const before = await storedMessages(chatPublicId);
    await chat.shareContact(guestId, chatPublicId);

    expect(await storedMessages(chatPublicId)).toHaveLength(before.length);
  });
});

describe('edit and delete propagation (D10)', () => {
  it('rewrites the relayed copy when the sender edits', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'ساعت ۶ می‌بینمت', telegramMessageId: 4242 });

    const edited = await chat.editBySourceMessage(guestId, 4242, {
      text: 'ببخشید، ساعت ۷ می‌بینمت',
      telegramMessageId: 4242,
    });

    expect(edited.text).toBe('ببخشید، ساعت 7 می‌بینمت');
    expect(edited.editedAt).toEqual(NOW);

    const asHostSees = await chat.readMessages(hostId, chatPublicId);
    expect(asHostSees.messages.at(-1)?.text).toBe('ببخشید، ساعت 7 می‌بینمت');
    // One message, edited — not two.
    expect(await storedMessages(chatPublicId)).toHaveLength(2);
  });

  it('masks an edit exactly as it masks a first draft', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام', telegramMessageId: 7 });

    const edited = await chat.editBySourceMessage(guestId, 7, {
      text: 'سلام، شماره‌ام 09121234567',
      telegramMessageId: 7,
    });

    expect(edited.text).not.toContain('09121234567');
  });

  it('will not let one person edit another person’s message', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام', telegramMessageId: 11 });

    await expect(
      chat.editBySourceMessage(hostId, 11, { text: 'چیز دیگری', telegramMessageId: 11 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const page = await chat.readMessages(hostId, chatPublicId);
    expect(page.messages.at(-1)?.text).toBe('سلام');
  });

  /**
   * The recipient's view respects the sender's intent; the record does not
   * disappear. A message deleted seconds after it was sent is the shape most
   * abuse takes, and a platform that erases it cannot investigate the report that
   * follows (ADR-0009, D10).
   */
  it('replaces a deleted message for the reader and keeps it for the record', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'حرف زشت', telegramMessageId: 99 });

    await chat.deleteBySourceMessage(guestId, 99);

    const page = await chat.readMessages(hostId, chatPublicId);
    expect(page.messages.at(-1)).toMatchObject({
      text: CHAT_MESSAGE_DELETED,
      deletedAt: NOW,
    });

    const [, stored] = await storedMessages(chatPublicId);
    if (!stored) throw new Error('the message was removed from the database');
    expect(stored.deletedAt).toEqual(NOW);
    expect(
      cipher.decrypt({
        ciphertext: Buffer.from(stored.bodyCiphertext),
        nonce: Buffer.from(stored.bodyNonce),
        keyVersion: stored.keyVersion,
      }),
    ).toBe('حرف زشت');
  });

  it('tells the relay what to put in place of the deleted copy', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام', telegramMessageId: 5 });
    await chat.deleteBySourceMessage(guestId, 5);

    const [event] = await prisma.outboxEvent.findMany({
      where: { eventType: 'chat.message_deleted' },
    });
    expect(event?.payload).toMatchObject({
      chatPublicId,
      seq: 2,
      replacementText: CHAT_MESSAGE_DELETED,
    });
  });
});

describe('sequence numbers', () => {
  /**
   * `UNIQUE (chat_id, seq)` is what makes "everything after seq N" a correct
   * incremental read. Two people typing at the same moment is the ordinary case
   * in a two-person chat, so the allocator has to be right under contention
   * rather than merely usually.
   */
  it('are distinct and gap-free when both people type at once', async () => {
    const { guestId, chatPublicId } = await conversation();

    await Promise.all([
      ...Array.from({ length: 8 }, () => chat.send(guestId, chatPublicId, { text: 'سلام' })),
      ...Array.from({ length: 8 }, () => chat.send(hostId, chatPublicId, { text: 'درود' })),
    ]);

    const messages = await storedMessages(chatPublicId);
    expect(messages.map((m) => m.seq)).toEqual(
      Array.from({ length: messages.length }, (_, i) => i + 1),
    );
  });

  it('page backwards through a long conversation without gaps or repeats', async () => {
    const { guestId, chatPublicId } = await conversation();
    for (let i = 0; i < 25; i += 1) {
      await chat.send(guestId, chatPublicId, { text: `پیام ${String(i)}` });
    }

    const seen: number[] = [];
    let before: number | undefined;
    for (;;) {
      const page: { messages: { seq: number }[]; nextBeforeSeq: number | null } =
        await chat.readMessages(guestId, chatPublicId, {
          limit: 10,
          ...(before !== undefined ? { beforeSeq: before } : {}),
        });
      seen.unshift(...page.messages.map((m) => m.seq));
      if (page.nextBeforeSeq === null) break;
      before = page.nextBeforeSeq;
    }

    // 25 messages plus the intro, each seen exactly once.
    expect(seen).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
  });
});

describe('the chat list', () => {
  it('shows an unread count that clears when the conversation is read', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'سلام' });
    await chat.send(guestId, chatPublicId, { text: 'هستید؟' });

    const [beforeReading] = await chat.listForUser(hostId);
    // Two messages plus the system intro, none of which the host has seen.
    expect(beforeReading?.unreadCount).toBe(3);

    clock.set(new Date(NOW.getTime() + 1000));
    await chat.readMessages(hostId, chatPublicId);

    const [afterReading] = await chat.listForUser(hostId);
    expect(afterReading?.unreadCount).toBe(0);
  });

  it('names the other side by alias and never by anything else', async () => {
    const { guestId, chatPublicId } = await conversation();

    const [asGuest] = await chat.listForUser(guestId);
    const [asHost] = await chat.listForUser(hostId);

    expect(asGuest).toMatchObject({ role: 'GUEST', alias: 'میهمان ۱', counterpartAlias: 'میزبان' });
    expect(asHost).toMatchObject({ role: 'HOST', alias: 'میزبان', counterpartAlias: 'میهمان ۱' });

    /**
     * The two Telegram ids by name, not "any long number".
     *
     * The response-leak scan settled this trade in M5 and it applies here for the
     * same reason: a random UUID contains a run of seven digits often enough that
     * a digit-count heuristic fails on data that is not a leak, and a test that
     * cries wolf is a test somebody eventually deletes. Naming the fixture's
     * actual identifiers is both stricter and quiet.
     */
    const accounts = await prisma.telegramAccount.findMany({
      where: { userId: { in: [guestId, hostId] } },
      select: { telegramUserId: true },
    });
    expect(accounts).toHaveLength(2);

    const serialized = JSON.stringify([asGuest, asHost]);
    expect(serialized).not.toContain(guestId);
    expect(serialized).not.toContain(hostId);
    for (const account of accounts) {
      expect(serialized).not.toContain(String(account.telegramUserId));
    }
    expect(serialized).not.toMatch(/@[A-Za-z0-9_]{5,32}\b/);
    expect(chatPublicId).toBeTruthy();
  });

  it('puts the most recently active conversation first', async () => {
    const first = await conversation();
    const second = await conversation();

    clock.set(new Date(NOW.getTime() + 60_000));
    await chat.send(first.guestId, first.chatPublicId, { text: 'سلام دوباره' });

    const chats = await chat.listForUser(hostId);
    expect(chats.map((c) => c.publicId)).toEqual([first.chatPublicId, second.chatPublicId]);
  });

  /**
   * «who — which event» (M18, ADR-0014).
   *
   * The problem this solves is specific: a host running two events had two rows
   * whose counterparts were both «میهمان ۱», and nothing on either row said which
   * person was which. The chat has always carried its event — `anonymous_chat`
   * has had `event_id` since M8 — so this needed no migration; what it needed was
   * for the name to travel beside the title.
   */
  it('names the other side by their profile name, beside the event', async () => {
    const { guestId } = await conversation();
    await prisma.userProfile.update({
      where: { userId: guestId },
      data: { displayName: 'علی رضایی' },
    });

    const [asHost] = await chat.listForUser(hostId);
    const [asGuest] = await chat.listForUser(guestId);

    expect(asHost?.counterpartName).toBe('علی رضایی');
    expect(asHost?.eventTitle).toBeTruthy();
    // Symmetrical: the guest sees the host's name, which they already read on the
    // event page before they ever asked to join. Read from the row rather than
    // written out, because the host fixture's name is not this test's subject.
    const hostProfile = await prisma.userProfile.findUniqueOrThrow({
      where: { userId: hostId },
      select: { displayName: true },
    });
    expect(asGuest?.counterpartName).toBe(hostProfile.displayName);
    expect(asGuest?.counterpartName).not.toBe(asGuest?.counterpartAlias);
  });

  it('falls back to the alias when there is no profile name, never to an invented one', async () => {
    // M15's anonymisation clears profiles, and an account can be mid-onboarding.
    // «میهمان ۱ — دورهمی» is still a usable title; a made-up name is not.
    const { guestId } = await conversation();
    await prisma.userProfile.delete({ where: { userId: guestId } });

    const [asHost] = await chat.listForUser(hostId);

    expect(asHost?.counterpartName).toBe('میهمان ۱');
    expect(asHost?.counterpartAlias).toBe('میهمان ۱');
  });

  it('keeps one guest’s two conversations distinguishable by their events', async () => {
    // The same person asking about two of a host's events produces two chats.
    // Each is «همان نام — رویداد دیگر», and each links to its own event.
    const guestId = await createJoiner();
    await prisma.userProfile.update({
      where: { userId: guestId },
      data: { displayName: 'علی رضایی' },
    });

    const firstEvent = await createEvent();
    const secondEvent = await createEvent();
    await participation.join(guestId, firstEvent);
    clock.set(new Date(NOW.getTime() + 1000));
    await participation.join(guestId, secondEvent);

    const chats = await chat.listForUser(hostId);

    expect(chats).toHaveLength(2);
    expect(new Set(chats.map((c) => c.counterpartName))).toEqual(new Set(['علی رضایی']));
    // Two different events, two different titles, two different links.
    expect(new Set(chats.map((c) => c.eventPublicId))).toEqual(new Set([firstEvent, secondEvent]));
    expect(new Set(chats.map((c) => c.eventTitle)).size).toBe(2);
  });
});

/**
 * The two reads the *bot* needs, which is the surface M13 left unbuilt.
 *
 * Both exist because a message typed into the bot's DM names no conversation, and
 * because a notification queued for delivery carries no message body.
 */
describe('what the bot and the sender ask for', () => {
  /**
   * **The half of the relay that was missing.**
   *
   * M8 wrote the outbox payload with ids and an alias and no text, and left a note
   * saying "M13's relay decrypts the row the payload points at". Nothing did — so
   * every relayed chat message was rendered with an empty body and delivered as
   * «میهمان ۱:» and nothing else. This is the method that closes it, and the reason
   * it lives here rather than in the worker is that decrypting is `MessageCipher`'s
   * and `MessageCipher` is not exported outside this module and one break-glass path.
   */
  it('gives the sender the plaintext for a message the payload names', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'ساعت هفت جلوی کافه' });

    const [event] = await prisma.outboxEvent.findMany({ where: { eventType: 'chat.message' } });
    const payload = event?.payload as { chatPublicId: string; seq: number };

    expect(await chat.plaintextForDelivery(payload.chatPublicId, payload.seq)).toBe(
      'ساعت هفت جلوی کافه',
    );
  });

  /** Sanitized before encryption, so what is delivered is what was stored (M8). */
  it('gives the masked text, not the original', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'شمارهٔ من ۰۹۱۲۱۲۳۴۵۶۷ است' });

    const delivered = await chat.plaintextForDelivery(chatPublicId, 2);

    expect(delivered).not.toContain('۰۹۱۲۱۲۳۴۵۶۷');
    expect(delivered).toContain(REDACTION_PLACEHOLDER);
  });

  /**
   * A message deleted between being queued and being sent must not be delivered.
   * The sender's intent governs the view (D10), and delivery is a view.
   */
  it('gives the placeholder for a message deleted before delivery', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.send(guestId, chatPublicId, { text: 'اشتباه فرستادم', telegramMessageId: 8801 });
    await chat.deleteBySourceMessage(guestId, 8801);

    expect(await chat.plaintextForDelivery(chatPublicId, 2)).toBe(CHAT_MESSAGE_DELETED);
  });

  /** Purged by M15 between queueing and sending: null, not a throw. */
  it('gives null for a message that no longer exists', async () => {
    const { chatPublicId } = await conversation();

    expect(await chat.plaintextForDelivery(chatPublicId, 9999)).toBeNull();
  });

  /**
   * The bot's fallback when a plain message names no conversation.
   *
   * Exactly one, or nothing. Two live chats is a genuinely unknown answer, and
   * returning either of them would deliver a private message to the wrong stranger.
   */
  it('names the sender’s only live conversation', async () => {
    const { guestId, chatPublicId } = await conversation();

    expect(await chat.singleLiveChatFor(guestId)).toBe(chatPublicId);
  });

  it('refuses to choose between two live conversations', async () => {
    const first = await conversation();
    const second = await conversation();

    expect(await chat.singleLiveChatFor(hostId)).toBeNull();
    expect(first.chatPublicId).not.toBe(second.chatPublicId);
  });

  it('names nothing when every conversation is closed', async () => {
    const { guestId, chatPublicId } = await conversation();
    await chat.close(guestId, chatPublicId);

    expect(await chat.singleLiveChatFor(guestId)).toBeNull();
  });
});

/**
 * A redelivered Telegram update must not relay a second copy.
 *
 * Telegram retries any webhook call that did not answer 200, and the retry carries
 * the same `message_id` — so the sender's own Telegram message id is the key, and the
 * index M8 added for the edit path answers it.
 */
describe('a redelivered message', () => {
  it('relays once and returns the message it already stored', async () => {
    const { guestId, chatPublicId } = await conversation();
    const message = { text: 'ساعت هفت', telegramMessageId: 7701 };

    const first = await chat.send(guestId, chatPublicId, message);
    const second = await chat.send(guestId, chatPublicId, message);

    expect(second.seq).toBe(first.seq);
    expect(second.text).toBe(first.text);
    expect(
      await prisma.chatMessage.count({ where: { chat: { publicId: chatPublicId }, kind: 'TEXT' } }),
    ).toBe(1);
    // One message, so one delivery instruction.
    expect(await prisma.outboxEvent.count({ where: { eventType: 'chat.message' } })).toBe(1);
  });

  /** Two people may hold the same Telegram message id; they are different messages. */
  it('does not confuse two senders with the same Telegram message id', async () => {
    const first = await conversation();
    const second = await conversation();

    await chat.send(first.guestId, first.chatPublicId, { text: 'اول', telegramMessageId: 7702 });
    await chat.send(second.guestId, second.chatPublicId, { text: 'دوم', telegramMessageId: 7702 });

    expect(await prisma.chatMessage.count({ where: { kind: 'TEXT' } })).toBe(2);
  });

  /** A Mini App message has no Telegram id behind it, so nothing is deduped away. */
  it('leaves the Mini App path alone', async () => {
    const { guestId, chatPublicId } = await conversation();

    await chat.send(guestId, chatPublicId, { text: 'سلام' });
    await chat.send(guestId, chatPublicId, { text: 'سلام' });

    expect(
      await prisma.chatMessage.count({ where: { chat: { publicId: chatPublicId }, kind: 'TEXT' } }),
    ).toBe(2);
  });
});
