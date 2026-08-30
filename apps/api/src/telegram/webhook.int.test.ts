import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import {
  ChatService,
  CoinService,
  ParticipationService,
  TrustService,
  normalize,
} from '@payetam/domain';
import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { TEMPLATES } from '@payetam/telegram';
import {
  TEST_CHAT_ENCRYPTION_KEY,
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';

/**
 * The bot's inbound surface, end to end (plan §6).
 *
 * It drives the **real webhook endpoint** with **real Telegram update bodies** and
 * asserts against a real database, because that is the only arrangement in which
 * the things worth testing here are visible at all: the secret comparison, the
 * narrowing of the wide update, the resolution of "which conversation did they
 * mean", and the fact that a relayed message reaches an encrypted column with no
 * identity attached to it.
 *
 * A unit test of `BotService` with a stubbed `ChatService` would prove the routing
 * and nothing else — and routing is the part that was never in doubt.
 *
 * Two things are deliberately *not* asserted here, because this process contains
 * neither: nothing sends to Telegram (the worker does, ADR-0005), so the assertion
 * is on the `notification` rows the API queues; and nothing renders those rows, so
 * the message text is covered by `escape.test.ts` instead.
 */

/**
 * Configured before the application is built, not read from `.env`.
 *
 * `loadEnv()` reads `process.env` when Nest constructs the ENV provider, so setting
 * these here makes the test independent of a developer's `.env` *and* of CI's
 * environment — and a webhook test that silently skipped because a secret was
 * absent would be the worst of the available outcomes.
 */
const SECRET_PATH = 'b0f034bb437b9f4d8469b6df04ca1373';
const SECRET_TOKEN = '2cc88ab81c8272b5dfffbe06ce00d2899633f01738d213c3849e7c3639e118fc';

process.env['TELEGRAM_WEBHOOK_SECRET_PATH'] = SECRET_PATH;
process.env['TELEGRAM_WEBHOOK_SECRET_TOKEN'] = SECRET_TOKEN;
process.env['TELEGRAM_BOT_TOKEN'] ??= '1234567890:LOCAL-DEV-ONLY-NOT-A-REAL-TOKEN-0001';
process.env['CHAT_ENCRYPTION_KEY'] ??= TEST_CHAT_ENCRYPTION_KEY;
process.env['JWT_ACCESS_SECRET'] ??= 'a'.repeat(48);
process.env['JWT_REFRESH_SECRET'] ??= 'b'.repeat(48);

const prisma: PrismaClient = createTestPrisma();

let app: NestFastifyApplication;
let participation: ParticipationService;
let chats: ChatService;
let coins: CoinService;
let trust: TrustService;
let fixture: CatalogFixture;

/** Distinctive, and shaped like a real Telegram id — the leak assertions hunt for it. */
const HOST_TELEGRAM_ID = 573_914_882;
const GUEST_TELEGRAM_ID = 601_222_333;
/** Never seeded: `/start` is what creates this one, so it has no profile. */
const NEWCOMER_TELEGRAM_ID = 733_818_204;
/** A second guest, for the "not your participation" refusal. */
const SECOND_GUEST_TELEGRAM_ID = 688_401_557;
const HOST_USERNAME = 'leaky_host_handle';

let updateSequence = 5000;
let telegramMessageSequence = 100;

interface Sender {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
}

function sender(id: number, username?: string): Sender {
  return {
    id,
    first_name: 'علی',
    ...(username !== undefined ? { username } : {}),
    language_code: 'fa',
  };
}

/** One update, with a fresh `update_id` so replies are not deduped against each other. */
function update(body: Record<string, unknown>): Record<string, unknown> {
  updateSequence += 1;
  return { update_id: updateSequence, ...body };
}

function textMessage(from: Sender, text: string, extra: Record<string, unknown> = {}) {
  telegramMessageSequence += 1;
  return {
    message_id: telegramMessageSequence,
    from,
    chat: { id: from.id, type: 'private' },
    text,
    ...extra,
  };
}

interface WebhookResponse {
  status: number;
  body: string;
}

async function post(
  payload: Record<string, unknown>,
  options: { path?: string; token?: string } = {},
): Promise<WebhookResponse> {
  const response = await app.inject({
    method: 'POST',
    url: `/telegram/webhook/${options.path ?? SECRET_PATH}`,
    headers: { 'x-telegram-bot-api-secret-token': options.token ?? SECRET_TOKEN },
    payload,
  });

  return { status: response.statusCode, body: response.body };
}

beforeAll(async () => {
  // The compiled module, for the reason the leak scan gives: NestJS DI reads
  // `design:paramtypes`, which `tsc` emits and the test runner's transform does not.
  const { AppModule } = (await import('../../dist/app.module.js')) as { AppModule: unknown };

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  participation = app.get(ParticipationService);
  chats = app.get(ChatService);
  coins = app.get(CoinService);
  trust = app.get(TrustService);
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

/** A host with a profile, an event, and the Telegram identity the bot will speak to. */
async function seedHostAndEvent(): Promise<{ hostId: string; eventPublicId: string }> {
  const host = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: {
        create: {
          telegramUserId: BigInt(HOST_TELEGRAM_ID),
          usernameCached: HOST_USERNAME,
          firstNameCached: 'Leaky',
        },
      },
      profile: { create: { displayName: 'میزبان', cityId: fixture.tehranId, birthYear: 1993 } },
    },
    select: { id: true },
  });

  const title = 'دورهمی بازی رومیزی';
  const description = 'یک شب دوستانه برای بازی و گفتگو.';
  const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await prisma.event.create({
    data: {
      hostUserId: host.id,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
    },
    select: { publicId: true },
  });

  return { hostId: host.id, eventPublicId: event.publicId };
}

async function seedGuest(telegramUserId: number, displayName = 'میهمان'): Promise<string> {
  const guest = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: BigInt(telegramUserId) } },
      profile: { create: { displayName, cityId: fixture.tehranId, birthYear: 1995 } },
    },
    select: { id: true },
  });
  return guest.id;
}

/** The reply the bot queued for this Telegram user, if any. */
async function replyTo(telegramUserId: number): Promise<{ templateKey: string; text: string }[]> {
  const rows = await prisma.notification.findMany({
    where: { user: { telegramAccount: { telegramUserId: BigInt(telegramUserId) } } },
    orderBy: { createdAt: 'asc' },
    select: { templateKey: true, payload: true },
  });

  return rows.map((row) => ({ templateKey: row.templateKey, text: noticeText(row.payload) }));
}

/** `bot.notice` carries its whole sentence in the payload; every other template does not. */
function noticeText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const text = (payload as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text : '';
}

/**
 * Criterion 16: *"a wrong webhook secret is rejected without processing"*.
 *
 * The launch-readiness report listed this as implemented and untested, and noted
 * that "a refactor that replaced it with `===` would pass every test in the
 * repository". It no longer would.
 *
 * The **200 is the assertion**, not an accident of it: a 401 here would let an
 * attacker probe for a valid secret by watching status codes, and ADR-0004 makes the
 * identical response the whole point. "Without processing" is then asserted the only
 * way it can be — by sending an update that *would* have created a user, and
 * checking that no user exists.
 */
describe('the secret gate (criterion 16)', () => {
  const startUpdate = () => update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') });

  it.each([
    ['a wrong secret token', { token: 'x'.repeat(64) }],
    ['a wrong secret path', { path: 'a'.repeat(32) }],
    ['no secret token at all', { token: '' }],
    ['a token that is a prefix of the real one', { token: SECRET_TOKEN.slice(0, 32) }],
    ['a token one character out', { token: `${SECRET_TOKEN.slice(0, -1)}0` }],
  ])('%s is answered 200 and processed not at all', async (_name, options) => {
    const response = await post(startUpdate(), options);

    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(await prisma.user.count()).toBe(0);
  });

  it('answers exactly the same to a correct secret, so the status leaks nothing', async () => {
    const refused = await post(startUpdate(), { token: 'x'.repeat(64) });
    const accepted = await post(startUpdate());

    expect(accepted.status).toBe(refused.status);
    expect(accepted.body).toBe(refused.body);
    // …and the difference is entirely in what happened behind it.
    expect(await prisma.user.count()).toBe(1);
  });
});

/**
 * M2's acceptance criterion, finally reachable: *"`/start` creates exactly one
 * user"*.
 */
describe('/start', () => {
  it('creates the user and queues a welcome', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID, HOST_USERNAME), '/start') }));

    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { telegramUserId: BigInt(HOST_TELEGRAM_ID) },
      select: { usernameCached: true, user: { select: { onboardingState: true } } },
    });

    expect(account.user.onboardingState).toBe('NEW');
    // Cached, never returned. It is the only place a username is stored (M2).
    expect(account.usernameCached).toBe(HOST_USERNAME);
    expect(await replyTo(HOST_TELEGRAM_ID)).toEqual([
      { templateKey: TEMPLATES.BOT_WELCOME, text: '' },
    ]);
  });

  /**
   * Ten simultaneous taps, which is what a flaky connection and an impatient thumb
   * actually produce. One user, decided by the UNIQUE index rather than by a check.
   */
  it('creates exactly one user under ten concurrent taps', async () => {
    await Promise.all(
      Array.from({ length: 10 }, () =>
        post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') })),
      ),
    );

    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.telegramAccount.count()).toBe(1);
  });

  /**
   * A redelivered update — Telegram retries any webhook call that did not answer 200
   * — must not produce a second message. The dedupe key is the `update_id`.
   */
  it('replies once when Telegram redelivers the same update', async () => {
    const once = update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') });

    await post(once);
    await post(once);

    expect(await prisma.notification.count()).toBe(1);
  });

  /** T6: the invite is recorded on the way in, and pays out after attendance. */
  it('claims a referral code from the deep-link payload', async () => {
    const referrerId = await seedGuest(700_111_222, 'دعوت‌کننده');
    await prisma.user.update({
      where: { id: referrerId },
      data: { referralCode: 'ABCD2345' },
    });

    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start ref_ABCD2345') }));

    const referral = await prisma.referral.findFirstOrThrow({
      select: { referrerUserId: true, status: true },
    });
    expect(referral).toEqual({ referrerUserId: referrerId, status: 'PENDING' });
    expect((await replyTo(HOST_TELEGRAM_ID)).map((row) => row.templateKey)).toEqual([
      TEMPLATES.BOT_REFERRAL_ACCEPTED,
    ]);
  });

  /**
   * A stale or mistyped invite link still greets somebody.
   *
   * The alternative — an error as the first thing a new user reads — loses the user
   * over a link they did not write.
   */
  it('welcomes anyway when the referral code is unusable', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start NOSUCHCODE') }));

    expect(await prisma.referral.count()).toBe(0);
    expect((await replyTo(HOST_TELEGRAM_ID)).map((row) => row.templateKey)).toEqual([
      TEMPLATES.BOT_WELCOME,
    ]);
  });
});

/**
 * The read-only commands.
 *
 * Every one of these answers something the Mini App also answers, and the point
 * is the round trip it removes: checking a balance was previously open the app,
 * wait for the home screen, read one number.
 *
 * They are asserted through the webhook rather than against `BotService`, because
 * what matters is that a command produces exactly one deduped `notification` row
 * — the same delivery path as every other message — and a unit test on the
 * service would assert the call and not the row.
 */
describe('commands', () => {
  it('answers /help with the capability list', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/help') }));

    expect(await replyTo(HOST_TELEGRAM_ID)).toEqual([
      { templateKey: TEMPLATES.BOT_WELCOME, text: '' },
      { templateKey: TEMPLATES.BOT_HELP, text: '' },
    ]);
  });

  /** No coin account yet is a zero balance, not an error — accounts are lazy. */
  it('answers /balance with zero for an account that has never moved', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/balance') }));

    const rows = await prisma.notification.findMany({
      where: { templateKey: TEMPLATES.BOT_BALANCE },
      select: { payload: true },
    });

    expect(rows).toHaveLength(1);
    expect((rows[0]?.payload as Record<string, unknown>)['balance']).toBe(0);
  });

  it('reports the balance the ledger actually holds', async () => {
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await prisma.coinAccount.create({ data: { userId: guestId, balance: 42 } });

    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/balance') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_BALANCE },
      select: { payload: true },
    });

    expect((row.payload as Record<string, unknown>)['balance']).toBe(42);
  });

  /**
   * The unknown-command reply used to send people back to `/start`, which told
   * them nothing they had not already read. It names `/help` now.
   */
  it('points an unknown command at /help rather than at /start', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/nonsense') }));

    const replies = await replyTo(HOST_TELEGRAM_ID);
    expect(replies).toHaveLength(2);
    expect(replies[1]?.templateKey).toBe(TEMPLATES.BOT_NOTICE);
    expect(replies[1]?.text).toContain('/help');
  });

  it('answers /requests with nothing asked for yet', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/requests') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_REQUESTS },
      select: { payload: true },
    });

    expect((row.payload as Record<string, unknown>)['text']).toContain('هنوز درخواستی نداده‌اید');
  });

  /**
   * The point of the command: a list that names the events, because «در انتظار»
   * three times over tells somebody nothing about which request is which.
   */
  it('names the event each request is for', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/requests') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_REQUESTS },
      select: { payload: true },
    });

    const text = String((row.payload as Record<string, unknown>)['text']);
    const title = (
      await prisma.event.findUniqueOrThrow({
        where: { publicId: eventPublicId },
        select: { title: true },
      })
    ).title;

    expect(text).toContain(title);
    expect(text).toContain('در انتظار پاسخ میزبان');
  });

  it('answers /myevents with nothing hosted yet', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/myevents') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_MY_EVENTS },
      select: { payload: true },
    });

    expect((row.payload as Record<string, unknown>)['text']).toContain('هنوز رویدادی نساخته‌اید');
  });

  /** The seats are the point: "do I still need people" without opening anything. */
  it('names the event and how full it is', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/myevents') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_MY_EVENTS },
      select: { payload: true },
    });

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { title: true },
    });

    expect(String((row.payload as Record<string, unknown>)['text'])).toContain(event.title);
  });

  it('answers /chats with nothing open yet', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/chats') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_CHATS },
      select: { payload: true },
    });

    expect((row.payload as Record<string, unknown>)['text']).toContain('گفتگوی بازی ندارید');
  });

  /**
   * The command's reason for existing: `ambiguityAdvice` tells somebody with two
   * live chats to reply to the right message, which assumed they could see which
   * conversations those were without opening the Mini App.
   */
  it('names the counterpart and the event for each open conversation', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/chats') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_CHATS },
      select: { payload: true },
    });

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { title: true },
    });

    const text = String((row.payload as Record<string, unknown>)['text']);
    expect(text).toContain(event.title);
    // The host's display name, which ADR-0014 already discloses on both surfaces.
    expect(text).toContain('میزبان');
  });

  /**
   * A live conversation is `ANONYMOUS` until contact is shared, and that is the
   * status most rows carry. It must read as Persian, not as the enum.
   */
  it('renders an anonymous conversation in Persian, not as ANONYMOUS', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/chats') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_CHATS },
      select: { payload: true },
    });

    const text = String((row.payload as Record<string, unknown>)['text']);
    expect(text).toContain('ناشناس');
    expect(text).not.toContain('ANONYMOUS');
  });

  /**
   * The first surface in the product that shows a user their own Trust Score.
   * `GET /me/trust` has existed since M18; no Mini App view renders it.
   */
  it('answers /profile with the name, the city and the trust score', async () => {
    await seedHostAndEvent();

    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/profile') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_PROFILE },
      select: { payload: true },
    });

    const payload = row.payload as Record<string, unknown>;
    expect(payload['displayName']).toBe('میزبان');
    expect(typeof payload['cityName']).toBe('string');
    expect(typeof payload['trustScore']).toBe('number');
  });

  /**
   * No profile is a **form**, not a sentence about one.
   *
   * A card of empty fields would be worse than either — but the sentence this
   * used to assert was «هنوز نمایه‌ای نساخته‌اید. برای تکمیل نمایه برنامه را باز
   * کنید», and once the open-app buttons were gone that named an application the
   * user had no way to reach. Paired with the profile-creation bug it was a
   * closed loop: no profile, so `/discover` refused; `/profile` to find out why,
   * and the answer was to leave.
   */
  it('opens the profile form for somebody who has none', async () => {
    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/profile') }));

    expect(await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_PROFILE } })).toBe(
      0,
    );
    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { telegramUserId: BigInt(GUEST_TELEGRAM_ID) },
      select: { userId: true },
    });
    expect(
      await prisma.conversationState.findUniqueOrThrow({ where: { userId: account.userId } }),
    ).toMatchObject({ kind: 'EDIT_PROFILE' });
  });

  /**
   * The product's core question, answered without opening anything. The city is
   * the sender's own, which is what makes the command single-turn.
   */
  it('answers /discover with activities in the sender’s city', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/discover') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      select: { payload: true },
    });

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { title: true },
    });

    const text = String((row.payload as Record<string, unknown>)['text']);
    expect(text).toContain(event.title);
    // The liability statement, over every list that has anything in it.
    expect(text).toContain(EVENT_DISCLAIMER_SHORT_FA);
  });

  /** No profile means no city, and «فعالیتی پیدا نشد» would be a false answer. */
  it('asks for a profile before answering /discover without one', async () => {
    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/discover') }));

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_DISCOVER } }),
    ).toBe(0);
  });

  it('answers /reviews with nothing owed yet', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/reviews') }));

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_REVIEWS },
      select: { payload: true },
    });

    expect((row.payload as Record<string, unknown>)['text']).toContain('نظر منتظری ندارید');
  });

  /** A command is a command, not chat text: it is never relayed to a stranger. */
  it('does not relay a command into an open conversation', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/help') }));

    expect(await prisma.chatMessage.count()).toBe(0);
  });
});

/**
 * The relay: a message typed into the bot's DM, delivered into a conversation.
 *
 * This is M8's release gate reduced to what an automated test can reach. The gate
 * itself — two real Telegram accounts, raw payload inspection — is still a manual
 * step, and what is asserted here is everything on this side of the Telegram API.
 */
describe('message:text', () => {
  async function withOneChat(): Promise<{ guestTelegramId: number; chatPublicId: string }> {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);

    expect(joined.chatPublicId).toBeDefined();
    return { guestTelegramId: GUEST_TELEGRAM_ID, chatPublicId: joined.chatPublicId ?? '' };
  }

  it('relays into the sender’s only live conversation', async () => {
    const { guestTelegramId, chatPublicId } = await withOneChat();

    await post(
      update({ message: textMessage(sender(guestTelegramId), 'سلام، ساعت هفت خوب است؟') }),
    );

    const stored = await prisma.chatMessage.findMany({
      where: { chat: { publicId: chatPublicId }, kind: 'TEXT' },
      select: { seq: true, sourceTelegramMessageId: true },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.sourceTelegramMessageId).toBe(BigInt(telegramMessageSequence));

    // Readable through the service, which decrypts — so this asserts the round trip
    // and not merely that a row appeared.
    const page = await chats.readMessages(await internalIdOf(guestTelegramId), chatPublicId, {});
    expect(page.messages.map((message) => message.text)).toContain('سلام، ساعت هفت خوب است؟');
  });

  /**
   * The relayed message is announced through the outbox, in the same transaction.
   *
   * Without the outbox row the recipient is never told, and the message sits in the
   * database being technically correct.
   */
  it('emits the outbox event that tells the other side', async () => {
    const { guestTelegramId } = await withOneChat();

    await post(update({ message: textMessage(sender(guestTelegramId), 'ساعت هفت') }));

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: 'chat.message' },
      select: { payload: true },
    });
    expect(events).toHaveLength(1);
    // M8's rule: ids and an alias, never the body. The worker decrypts at delivery.
    expect(JSON.stringify(events[0]?.payload)).not.toContain('ساعت هفت');
  });

  /**
   * **Nothing identity-shaped reaches the row or the announcement.**
   *
   * The sender's Telegram id and username are both present in the database and both
   * available to the handler — `parseUpdate` hands the id to identity creation — so
   * this is a real assertion rather than one about data that does not exist.
   */
  it('stores and announces nothing that identifies the sender', async () => {
    const { guestTelegramId, chatPublicId } = await withOneChat();

    await post(
      update({
        message: textMessage(sender(guestTelegramId, 'leaky_guest_handle'), 'من علی هستم', {
          entities: [{ type: 'text_mention', offset: 3, length: 3, user: { id: 999_888_777 } }],
        }),
      }),
    );

    const rows = await prisma.chatMessage.findMany({
      where: { chat: { publicId: chatPublicId } },
      select: { bodyCiphertext: true, redactions: true, telegramMessageIds: true },
    });
    const outbox = await prisma.outboxEvent.findMany({ select: { payload: true } });

    const serialised = [
      JSON.stringify(rows.map((row) => ({ ...row, bodyCiphertext: undefined }))),
      JSON.stringify(outbox),
      Buffer.concat(rows.map((row) => Buffer.from(row.bodyCiphertext))).toString('utf8'),
    ].join('\n');

    expect(serialised).not.toContain(String(guestTelegramId));
    expect(serialised).not.toContain('leaky_guest_handle');
    expect(serialised).not.toContain('999888777');
  });

  /**
   * Two live chats and no reply: the answer is genuinely unknown.
   *
   * Guessing would deliver a private message to the wrong stranger, which is the
   * worst outcome available to this code path — so it refuses and says how to
   * disambiguate.
   */
  it('refuses rather than guessing between two conversations', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const second = await seedHostAndEvent2();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);
    await participation.join(guestId, second);

    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), 'سلام') }));

    expect(await prisma.chatMessage.count({ where: { kind: 'TEXT' } })).toBe(0);
    const replies = await replyTo(GUEST_TELEGRAM_ID);
    expect(replies.at(-1)?.templateKey).toBe(TEMPLATES.BOT_NOTICE);
    expect(replies.at(-1)?.text).toContain('Reply');
  });

  /**
   * A reply names the conversation exactly, by quoting a message we sent.
   *
   * The lookup is on `notification.telegram_message_id`, scoped to the sender — which
   * is also the authorisation: an id from somebody else's conversation finds nothing.
   */
  it('routes a reply to the conversation it quotes', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const second = await seedHostAndEvent2();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const first = await participation.join(guestId, eventPublicId);
    await participation.join(guestId, second);

    // Stand in for the worker: a delivered notification about the *first* chat,
    // recorded with the Telegram message id the reply will quote.
    const delivered = await prisma.notification.create({
      data: {
        userId: guestId,
        templateKey: TEMPLATES.CHAT_MESSAGE,
        dedupeKey: 'test:delivered:1',
        payload: { chatPublicId: first.chatPublicId, seq: 1, senderAlias: 'میزبان' },
        status: 'SENT',
        sentAt: new Date(),
        telegramMessageId: 4242,
      },
      select: { telegramMessageId: true },
    });

    await post(
      update({
        message: textMessage(sender(GUEST_TELEGRAM_ID), 'باشه', {
          reply_to_message: { message_id: delivered.telegramMessageId },
        }),
      }),
    );

    const relayed = await prisma.chatMessage.findMany({
      where: { kind: 'TEXT' },
      select: { chat: { select: { publicId: true } } },
    });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.chat.publicId).toBe(first.chatPublicId);
  });

  it('tells somebody with no conversation what to do instead', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), 'سلام') }));

    const replies = await replyTo(HOST_TELEGRAM_ID);
    expect(replies.at(-1)?.text).toContain('گفتگوی بازی ندارید');
  });

  /**
   * Criterion 11 through the bot: *"media in chat gets a Persian refusal and stores
   * nothing"*.
   */
  it('refuses media in Persian and stores nothing', async () => {
    const { guestTelegramId, chatPublicId } = await withOneChat();
    telegramMessageSequence += 1;

    await post(
      update({
        message: {
          message_id: telegramMessageSequence,
          from: sender(guestTelegramId),
          chat: { id: guestTelegramId, type: 'private' },
          photo: [{ file_id: 'x', file_unique_id: 'y', width: 100, height: 100 }],
        },
      }),
    );

    expect(
      await prisma.chatMessage.count({ where: { chat: { publicId: chatPublicId }, kind: 'TEXT' } }),
    ).toBe(0);
    const replies = await replyTo(guestTelegramId);
    expect(replies.at(-1)?.text).toContain('فقط ارسال متن');
  });

  /** A redelivered message update must not relay a second copy. */
  it('relays once when Telegram redelivers the same message', async () => {
    const { guestTelegramId, chatPublicId } = await withOneChat();
    const once = update({ message: textMessage(sender(guestTelegramId), 'ساعت هفت') });

    await post(once);
    await post(once);

    expect(
      await prisma.chatMessage.count({ where: { chat: { publicId: chatPublicId }, kind: 'TEXT' } }),
    ).toBe(1);
  });
});

/** D10, the inbound half: the sender edits, and the stored copy follows. */
describe('edited_message', () => {
  it('propagates the edit to the stored message and announces it', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);

    const original = textMessage(sender(GUEST_TELEGRAM_ID), 'ساعت هفت');
    await post(update({ message: original }));
    await post(
      update({
        edited_message: { ...original, text: 'ساعت هشت' },
      }),
    );

    const page = await chats.readMessages(guestId, joined.chatPublicId ?? '', {});
    const relayed = page.messages.filter((message) => message.kind === 'TEXT');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.text).toBe('ساعت هشت');
    expect(relayed[0]?.editedAt).not.toBeNull();

    // The recipient is told, which is the half M13 emitted and never routed.
    expect(await prisma.outboxEvent.count({ where: { eventType: 'chat.message_edited' } })).toBe(1);
  });

  /**
   * An edit to a message that was never relayed is silence, not an argument.
   *
   * Telegram sends `edited_message` for every edit in the bot's DM — including one
   * to a `/start` somebody fixed a typo in.
   */
  it('ignores an edit to a message it never relayed', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    const before = await prisma.notification.count();

    await post(update({ edited_message: textMessage(sender(HOST_TELEGRAM_ID), 'something else') }));

    expect(await prisma.notification.count()).toBe(before);
  });
});

/** The host's two buttons, and the third that ends a conversation. */
describe('callback_query', () => {
  async function pendingRequest(): Promise<{ participantPublicId: string; chatPublicId: string }> {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);

    return {
      participantPublicId: joined.publicId,
      chatPublicId: joined.chatPublicId ?? '',
    };
  }

  it('accepts a request when the host taps accept', async () => {
    const { participantPublicId } = await pendingRequest();

    await post(
      update({
        callback_query: {
          id: 'q-accept',
          from: sender(HOST_TELEGRAM_ID),
          data: `chat:accept:${participantPublicId}`,
        },
      }),
    );

    const participant = await prisma.eventParticipant.findUniqueOrThrow({
      where: { publicId: participantPublicId },
      select: { status: true, acceptedAt: true },
    });
    expect(participant.status).toBe('ACCEPTED');
    expect(participant.acceptedAt).not.toBeNull();
  });

  it('rejects a request when the host taps reject', async () => {
    const { participantPublicId } = await pendingRequest();

    await post(
      update({
        callback_query: {
          id: 'q-reject',
          from: sender(HOST_TELEGRAM_ID),
          data: `chat:reject:${participantPublicId}`,
        },
      }),
    );

    expect(
      (
        await prisma.eventParticipant.findUniqueOrThrow({
          where: { publicId: participantPublicId },
          select: { status: true },
        })
      ).status,
    ).toBe('REJECTED');
  });

  it('closes a conversation when either party taps close', async () => {
    const { chatPublicId } = await pendingRequest();

    await post(
      update({
        callback_query: {
          id: 'q-close',
          from: sender(GUEST_TELEGRAM_ID),
          data: `chat:close:${chatPublicId}`,
        },
      }),
    );

    expect(
      (
        await prisma.anonymousChat.findUniqueOrThrow({
          where: { publicId: chatPublicId },
          select: { status: true },
        })
      ).status,
    ).toBe('CLOSED');
  });

  /**
   * Sharing contact details from inside the bot (report 6).
   *
   * Two taps, and the first one **must not disclose anything**. That is the
   * property this pair of tests exists for: consent to disclose is the one
   * decision in this product that has to be unambiguous (ADR-0009), and the whole
   * reason `share` and `shareyes` are separate actions is that a message arriving
   * unbidden must not be one tap away from an irreversible disclosure.
   *
   * What it replaces is a trip to a different application for a confirmation that
   * was always going to be a confirmation.
   */
  describe('sharing contact details', () => {
    async function openChat(): Promise<{ chatPublicId: string; guestUserId: string }> {
      const { eventPublicId, hostId } = await seedHostAndEvent();
      const guestUserId = await seedGuest(GUEST_TELEGRAM_ID);
      const joined = await participation.join(guestUserId, eventPublicId);
      // Only an accepted conversation may exchange contact details.
      await participation.accept(hostId, joined.publicId);

      return { chatPublicId: joined.chatPublicId ?? '', guestUserId };
    }

    it('discloses nothing when the first button is tapped', async () => {
      const { chatPublicId, guestUserId } = await openChat();

      await post(
        update({
          callback_query: {
            id: 'q-share',
            from: sender(GUEST_TELEGRAM_ID),
            data: `chat:share:${chatPublicId}`,
          },
        }),
      );

      const shared = await prisma.chatParticipant.count({
        where: { userId: guestUserId, contactSharedAt: { not: null } },
      });
      expect(shared).toBe(0);
    });

    it('records the decision when the confirmation is tapped', async () => {
      const { chatPublicId, guestUserId } = await openChat();

      await post(
        update({
          callback_query: {
            id: 'q-shareyes',
            from: sender(GUEST_TELEGRAM_ID),
            data: `chat:shareyes:${chatPublicId}`,
          },
        }),
      );

      const shared = await prisma.chatParticipant.count({
        where: { userId: guestUserId, contactSharedAt: { not: null } },
      });
      expect(shared).toBe(1);
    });

    /**
     * The bot reaches the same service the Mini App does, so it inherits the same
     * idempotency: pressing the button twice is one decision, not two.
     */
    it('treats a second confirmation as the same decision', async () => {
      const { chatPublicId, guestUserId } = await openChat();

      for (const id of ['q-yes-1', 'q-yes-2']) {
        await post(
          update({
            callback_query: {
              id,
              from: sender(GUEST_TELEGRAM_ID),
              data: `chat:shareyes:${chatPublicId}`,
            },
          }),
        );
      }

      const consents = await prisma.chatParticipant.findMany({
        where: { userId: guestUserId },
        select: { contactSharedAt: true },
      });
      expect(consents.filter((row) => row.contactSharedAt !== null)).toHaveLength(1);
    });

    /**
     * `callback_data` is client input. A tap naming somebody else's conversation
     * must be refused by the service, not by the button.
     */
    it('refuses a confirmation from somebody who is not in the conversation', async () => {
      const { chatPublicId } = await openChat();
      const stranger = 900_222_000;
      await seedGuest(stranger);

      await post(
        update({
          callback_query: {
            id: 'q-stranger',
            from: sender(stranger),
            data: `chat:shareyes:${chatPublicId}`,
          },
        }),
      );

      const shared = await prisma.chatParticipant.count({
        where: { contactSharedAt: { not: null } },
      });
      expect(shared).toBe(0);
    });
  });

  /**
   * **The button carries no authority.**
   *
   * `callback_data` is client input, so a tap can name any public id; the refusal
   * has to come from the service. T3.2 puts the check in `ParticipationService`, and
   * this is what proves the bot did not route around it.
   */
  it('refuses a decision from somebody who does not host the event', async () => {
    const { participantPublicId } = await pendingRequest();
    const stranger = 900_111_000;
    await seedGuest(stranger, 'رهگذر');

    await post(
      update({
        callback_query: {
          id: 'q-forged',
          from: sender(stranger),
          data: `chat:accept:${participantPublicId}`,
        },
      }),
    );

    expect(
      (
        await prisma.eventParticipant.findUniqueOrThrow({
          where: { publicId: participantPublicId },
          select: { status: true },
        })
      ).status,
    ).toBe('PENDING');
  });

  it('does nothing at all with a tampered callback payload', async () => {
    const { participantPublicId } = await pendingRequest();

    await post(
      update({
        callback_query: {
          id: 'q-junk',
          from: sender(HOST_TELEGRAM_ID),
          data: 'chat:accept:\'; drop table "user"; --',
        },
      }),
    );

    expect(
      (
        await prisma.eventParticipant.findUniqueOrThrow({
          where: { publicId: participantPublicId },
          select: { status: true },
        })
      ).status,
    ).toBe('PENDING');
  });
});

/**
 * Block detection.
 *
 * The flag is what stops the sender retrying against somebody who is gone, and
 * ADR-0005 makes 403 terminal for exactly this reason.
 */
describe('my_chat_member', () => {
  it('records a block and clears it again', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));

    await post(
      update({
        my_chat_member: {
          chat: { id: HOST_TELEGRAM_ID, type: 'private' },
          from: sender(HOST_TELEGRAM_ID),
          new_chat_member: { status: 'kicked' },
        },
      }),
    );
    expect(await blockedFlag()).toBe(true);

    await post(
      update({
        my_chat_member: {
          chat: { id: HOST_TELEGRAM_ID, type: 'private' },
          from: sender(HOST_TELEGRAM_ID),
          new_chat_member: { status: 'member' },
        },
      }),
    );
    expect(await blockedFlag()).toBe(false);
  });

  /** The bot administers its own channel (M14); that is not a user blocking us. */
  it('ignores a membership change in the channel', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));

    await post(
      update({
        my_chat_member: {
          chat: { id: -1_001_234_567_890, type: 'channel' },
          from: sender(HOST_TELEGRAM_ID),
          new_chat_member: { status: 'kicked' },
        },
      }),
    );

    expect(await blockedFlag()).toBe(false);
  });

  async function blockedFlag(): Promise<boolean> {
    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { telegramUserId: BigInt(HOST_TELEGRAM_ID) },
      select: { botBlocked: true },
    });
    return account.botBlocked;
  }
});

/**
 * Whatever else Telegram sends.
 *
 * The webhook answers 200 and does nothing, which is ADR-0004's contract — and the
 * body being *hostile* rather than merely unknown must land in the same place, since
 * a thrown parse would become a 500 and a Telegram retry loop.
 */
describe('an update this product has no opinion about', () => {
  it.each([
    [
      'a channel post of ours',
      { channel_post: { message_id: 1, chat: { id: -1, type: 'channel' } } },
    ],
    ['a poll answer', { poll_answer: { poll_id: '1', option_ids: [0] } }],
    ['an unparseable body', { message: 'not an object' }],
    ['nothing recognisable', { something_new_in_the_bot_api: {} }],
  ])('%s is answered 200 and ignored', async (_name, body) => {
    const response = await post(update(body));

    expect(response.status).toBe(200);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.notification.count()).toBe(0);
  });
});

/** A second event with a different host, for the two-conversations cases. */
async function seedHostAndEvent2(): Promise<string> {
  const host = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: 800_444_555n } },
      profile: { create: { displayName: 'میزبان دوم', cityId: fixture.tehranId, birthYear: 1990 } },
    },
    select: { id: true },
  });

  const title = 'پیاده‌روی صبحگاهی';
  const description = 'یک مسیر کوتاه و دوستانه در پارک.';
  const startsAt = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
  const event = await prisma.event.create({
    data: {
      hostUserId: host.id,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
    },
    select: { publicId: true },
  });

  return event.publicId;
}

async function internalIdOf(telegramUserId: number): Promise<string> {
  const account = await prisma.telegramAccount.findUniqueOrThrow({
    where: { telegramUserId: BigInt(telegramUserId) },
    select: { userId: true },
  });
  return account.userId;
}

/**
 * `/create_event`, from the first question to a row in `event` (ADR-0017).
 *
 * The end-to-end test the brief asked for, and it is written through the webhook
 * rather than against `ConversationService` on purpose: what is being checked is
 * that a *Telegram update* reaches the wizard, that its buttons decode, that the
 * assembled form satisfies the same contract the API uses, and that an event
 * comes out the other end. A service-level test would prove none of the wiring.
 */
describe('POST /telegram/:secret — creating an event in the chat', () => {
  /**
   * The shared fixture's cities have no province, because nothing needed one
   * until the wizard asked. Added here rather than in `seedCatalog` so no other
   * suite's expectations move.
   */
  async function seedProvince(): Promise<string> {
    const province = await prisma.province.create({
      data: { slug: 'tehran-province', nameFa: 'تهران', isActive: true },
    });
    await prisma.city.update({
      where: { id: fixture.tehranId },
      data: { provinceId: province.id },
    });
    return province.id;
  }

  /** The next `update_id`, so every step is a distinct update as Telegram sends them. */
  let sequence = 5000;
  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  it('walks the core path and creates the event', async () => {
    const provinceId = await seedProvince();
    const hostId = await seedGuest(HOST_TELEGRAM_ID, 'میزبان');
    // Creating an event costs `economy.event_create_coins` (M22 phase 5), charged
    // inside the same transaction. The wizard does not change that, and a host
    // who cannot afford it is refused here exactly as they would be in the app.
    await prisma.coinAccount.upsert({
      where: { userId: hostId },
      create: { userId: hostId, balance: 100 },
      update: { balance: 100 },
    });

    await type(HOST_TELEGRAM_ID, '/create_event');
    await type(HOST_TELEGRAM_ID, 'کوهنوردی صبح جمعه');
    await type(HOST_TELEGRAM_ID, 'از دربند تا شیرپلا، صبح زود راه می‌افتیم.');
    await tap(HOST_TELEGRAM_ID, `wz:cat:${fixture.categoryId}`);
    await tap(HOST_TELEGRAM_ID, `wz:prov:${provinceId}`);
    await tap(HOST_TELEGRAM_ID, `wz:city:${fixture.tehranId}`);
    await tap(HOST_TELEGRAM_ID, 'wz:skip:');

    // Far enough ahead that the calendar would have offered it.
    const day = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
    await tap(HOST_TELEGRAM_ID, `wz:day:${day}`);
    await tap(HOST_TELEGRAM_ID, 'wz:hour:18');
    await tap(HOST_TELEGRAM_ID, 'wz:dur:3');
    await tap(HOST_TELEGRAM_ID, 'wz:cap:6');
    await tap(HOST_TELEGRAM_ID, 'wz:cost:FREE');

    // Everything required is answered: the summary is showing, and «ثبت» commits.
    await tap(HOST_TELEGRAM_ID, 'wz:confirm:');

    const event = await prisma.event.findFirstOrThrow({
      where: { hostUserId: hostId },
      select: { title: true, capacity: true, costType: true, cityId: true, startsAt: true },
    });
    expect(event.title).toBe('کوهنوردی صبح جمعه');
    expect(event.capacity).toBe(6);
    expect(event.costType).toBe('FREE');
    expect(event.cityId).toBe(fixture.tehranId);

    // 18:00 Tehran is 14:30 UTC. The wizard commits an instant, not a wall clock.
    expect(event.startsAt.toISOString()).toContain('T14:30:00');

    // The draft is gone: a submitted form is not a form in progress.
    expect(await prisma.conversationState.count({ where: { userId: hostId } })).toBe(0);
  });

  /** A refusal holds the step; it does not advance past the question. */
  it('refuses a title that is too short and stays on the step', async () => {
    await seedGuest(HOST_TELEGRAM_ID, 'میزبان');
    await type(HOST_TELEGRAM_ID, '/create_event');
    await type(HOST_TELEGRAM_ID, 'ab');

    const state = await prisma.conversationState.findFirstOrThrow();
    expect(state.step).toBe('title');
  });

  /**
   * The ordering that matters most in the whole wiring: text typed into an open
   * wizard is an *answer*, never a message relayed to a stranger.
   */
  it('does not relay wizard text into an open chat', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await type(GUEST_TELEGRAM_ID, '/create_event');
    await type(GUEST_TELEGRAM_ID, 'این نام فعالیت است، نه پیام');

    expect(await prisma.chatMessage.count({ where: { kind: 'TEXT' } })).toBe(0);
  });

  /** Telegram retries any webhook call that did not answer 200. */
  it('does not advance twice on a redelivered update', async () => {
    await seedGuest(HOST_TELEGRAM_ID, 'میزبان');
    await type(HOST_TELEGRAM_ID, '/create_event');

    const replayed = update({
      update_id: 9001,
      message: textMessage(sender(HOST_TELEGRAM_ID), 'کوهنوردی صبح جمعه'),
    });
    await post(replayed);
    await post(replayed);

    const state = await prisma.conversationState.findFirstOrThrow();
    // One advance, not two: still on the description, not past it.
    expect(state.step).toBe('desc');
  });

  it('closes the form on «انصراف»', async () => {
    await seedGuest(HOST_TELEGRAM_ID, 'میزبان');
    await type(HOST_TELEGRAM_ID, '/create_event');
    await tap(HOST_TELEGRAM_ID, 'wz:cancel:');

    expect(await prisma.conversationState.count()).toBe(0);
  });
});

/**
 * Reporting — the last user-facing safety control with no bot surface.
 *
 * The four endpoints have existed since M12 and were reachable only from the
 * Mini App. From v0.4.6 — when the last button to it went — somebody meeting
 * strangers through this product had no way to say something was wrong.
 */
describe('POST /telegram/:secret — reporting', () => {
  let sequence = 10_600;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  /**
   * v0.5.8: the reason opens a form rather than filing on the spot.
   *
   * «HARASSMENT» with two sentences under it is a great deal more use to a
   * moderator than the word alone, and `ReportService` has only `file` — no
   * update path — so the description is collected before the row exists.
   */
  it('opens a form seeded with the target, and files reason and description', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `rp:aske:${eventPublicId}`);

    /**
     * The target letter is seeded, not asked: a public id does not carry its
     * table. It is asserted through the *outcome* rather than read back, because
     * `form_data` is encrypted at rest — `formDataCiphertext` is the column, and
     * a test that could read a draft would mean the draft was not protected.
     */
    const state = await prisma.conversationState.findUniqueOrThrow({
      where: { userId: guestId },
      select: { kind: true, targetPublicId: true },
    });
    expect(state.kind).toBe('FILE_REPORT');
    expect(state.targetPublicId).toBe(eventPublicId);

    await tap(GUEST_TELEGRAM_ID, 'wz:why:HARASSMENT');
    await type(GUEST_TELEGRAM_ID, 'در گفتگو توهین کرد');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const report = await prisma.report.findFirstOrThrow({
      where: { reporterUserId: guestId },
      select: { targetType: true, reason: true, description: true },
    });
    expect(report.targetType).toBe('EVENT');
    expect(report.reason).toBe('HARASSMENT');
    expect(report.description).toBe('در گفتگو توهین کرد');
    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(0);
  });

  /**
   * Somebody reporting harassment should not have to compose a paragraph before
   * the product will listen. «رد کردن» files the reason alone — what v0.5.7 did.
   */
  it('files without a description when the note is skipped', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `rp:aske:${eventPublicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:why:SAFETY');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const report = await prisma.report.findFirstOrThrow({
      where: { reporterUserId: guestId },
      select: { reason: true, description: true },
    });
    expect(report.reason).toBe('SAFETY');
    expect(report.description).toBeNull();
  });

  /** Still nobody is notified — the form changed nothing about that. */
  it('notifies nobody about a reported conversation', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);
    const chat = await prisma.anonymousChat.findFirstOrThrow({ select: { publicId: true } });

    await tap(GUEST_TELEGRAM_ID, `rp:askc:${chat.publicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:why:HARASSMENT');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    const before = await prisma.notification.count({
      where: { user: { telegramAccount: { telegramUserId: BigInt(HOST_TELEGRAM_ID) } } },
    });
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const report = await prisma.report.findFirstOrThrow({ select: { targetType: true } });
    expect(report.targetType).toBe('MESSAGE');
    // The host learns nothing. This is the one message this area must never send.
    expect(
      await prisma.notification.count({
        where: { user: { telegramAccount: { telegramUserId: BigInt(HOST_TELEGRAM_ID) } } },
      }),
    ).toBe(before);
  });

  /**
   * The v0.5.7 path, kept as the fallback when the wizards are switched off.
   *
   * `ENABLE_CONVERSATION_WIZARD=0` is the incident lever, and a safety control
   * that went off with it would be the wrong thing to lose. It files without a
   * description, which is worse than the form and much better than nothing.
   */
  it('files a report against an event', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `rp:eHARASSMENT:${eventPublicId}`);

    const report = await prisma.report.findFirstOrThrow({
      where: { reporterUserId: guestId },
      select: { targetType: true, reason: true },
    });
    expect(report.targetType).toBe('EVENT');
    expect(report.reason).toBe('HARASSMENT');
  });

  /**
   * The target type rides in the callback because a public id does not carry its
   * table — an event, a conversation and a user are three different things to a
   * moderator, and guessing between them would let a typo report the wrong thing.
   */
  it('files against the user when the target letter says so', async () => {
    const { hostId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const host = await prisma.user.findUniqueOrThrow({
      where: { id: hostId },
      select: { publicId: true },
    });

    await tap(GUEST_TELEGRAM_ID, `rp:uSCAM:${host.publicId}`);

    const report = await prisma.report.findFirstOrThrow({
      where: { reporterUserId: guestId },
      select: { targetType: true },
    });
    expect(report.targetType).toBe('USER');
  });

  /** You cannot report your own activity, and nothing is written when you try. */
  it('refuses a report against your own content', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await tap(HOST_TELEGRAM_ID, `rp:eSPAM:${eventPublicId}`);

    expect(await prisma.report.count()).toBe(0);
  });

  /**
   * **Nobody is notified.** Telling one side of an anonymous chat that the other
   * reported them is the single message this area must never send — so filing a
   * report queues nothing for anybody.
   */
  it('notifies nobody about a report', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);
    const before = await prisma.notification.count();

    await tap(GUEST_TELEGRAM_ID, `rp:eSAFETY:${eventPublicId}`);

    expect(await prisma.notification.count()).toBe(before);
  });
});

/**
 * The host's console: `/myevents` as something you can act on.
 *
 * Publishing to the channel, inviting likely guests and cancelling all lived in
 * `MyEventsView` and had no bot equivalent, so a host could see their activities
 * and do nothing to them.
 */
describe('POST /telegram/:secret — acting on your own events', () => {
  let sequence = 10_200;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  async function latest(templateKey: string): Promise<Record<string, unknown>> {
    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    return row.payload as Record<string, unknown>;
  }

  it('offers channel, boost, invite and cancel on every open event', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await type(HOST_TELEGRAM_ID, '/myevents');

    const rows = JSON.parse(String((await latest(TEMPLATES.BOT_MY_EVENTS))['keyboard'])) as {
      text: string;
      callbackData: string;
    }[][];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.map((button) => button.callbackData)).toEqual([
      `ev:post:${eventPublicId}`,
      `ev:boost:${eventPublicId}`,
      `ev:invite:${eventPublicId}`,
      `ev:drop:${eventPublicId}`,
    ]);
  });

  /** Boost names both the price and the duration, and both are settings. */
  it('names the boost duration as well as its price', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await tap(HOST_TELEGRAM_ID, `ev:boost:${eventPublicId}`);

    const payload = await latest(TEMPLATES.BOT_CONFIRM_SPEND);
    const rows = JSON.parse(String(payload['keyboard'])) as { callbackData: string }[][];
    expect(rows[0]?.[0]?.callbackData).toBe(`ev:boostyes:${eventPublicId}`);
    expect(String(payload['text'])).toContain('ساعت');
  });

  /**
   * The ask states the **live** cost, read from `app_setting` rather than
   * written into a template — a message naming a price the service will not
   * charge is worse than one naming none.
   */
  it('asks before spending, and names the configured price', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await prisma.appSetting.upsert({
      where: { key: 'economy.event_channel_send_coins' },
      create: { key: 'economy.event_channel_send_coins', value: 33 },
      update: { value: 33 },
    });

    await tap(HOST_TELEGRAM_ID, `ev:post:${eventPublicId}`);

    const payload = await latest(TEMPLATES.BOT_CONFIRM_SPEND);
    // ۳۳ in Persian digits — the number the service will actually charge.
    expect(String(payload['text'])).toContain('۳۳');
    const rows = JSON.parse(String(payload['keyboard'])) as { callbackData: string }[][];
    expect(rows[0]?.[0]?.callbackData).toBe(`ev:postyes:${eventPublicId}`);
  });

  /** The ask alone charges nothing. Only `postyes` does. */
  it('charges nothing for the question', async () => {
    const { hostId, eventPublicId } = await seedHostAndEvent();
    const before = await prisma.coinLedger.count({ where: { userId: hostId } });

    await tap(HOST_TELEGRAM_ID, `ev:post:${eventPublicId}`);

    expect(await prisma.coinLedger.count({ where: { userId: hostId } })).toBe(before);
  });

  /** Not-yours and not-found answer identically, and neither writes. */
  it("refuses a host action on somebody else's event", async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `ev:dropyes:${eventPublicId}`);

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { status: true },
    });
    expect(event.status).not.toBe('CANCELLED_BY_HOST');
  });

  it('cancels the event when the host confirms', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await tap(HOST_TELEGRAM_ID, `ev:dropyes:${eventPublicId}`);

    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { status: true },
    });
    expect(event.status).toBe('CANCELLED_BY_HOST');
  });
});

/**
 * The economy commands: what you have, where it came from, and how to add to it.
 */
describe('POST /telegram/:secret — wallet, referral and gift codes', () => {
  let sequence = 9800;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function bodyOf(templateKey: string): Promise<string> {
    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    return String((row.payload as Record<string, unknown>)['text']);
  }

  it('accounts for the balance rather than only stating it', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID);
    await coins.apply({
      userId,
      amount: 15,
      type: 'ONBOARDING_REWARD',
      reasonCode: 'onboarding',
      idempotencyKey: `onboarding:${userId}`,
      actorType: 'SYSTEM',
    });

    await type(GUEST_TELEGRAM_ID, '/wallet');

    const text = await bodyOf(TEMPLATES.BOT_WALLET);
    expect(text).toContain('کیف پول شما');
    // The ledger line, in the language the user reads rather than the enum.
    expect(text).toContain('هدیهٔ خوش‌آمد');
    expect(text).not.toContain('ONBOARDING_REWARD');
  });

  /**
   * ADR-0007: «a score nobody can account for is a score nobody can appeal».
   * `/profile` showed the number; nothing ever showed the movements — the Mini
   * App did not render `GET /me/trust` either.
   */
  it('accounts for the trust score rather than only stating it', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID);
    await trust.apply({
      userId,
      delta: 5,
      type: 'PROFILE_COMPLETE',
      reasonCode: 'profile-complete',
      idempotencyKey: `trust-profile:${userId}`,
      actorType: 'SYSTEM',
    });

    await type(GUEST_TELEGRAM_ID, '/trust');

    const text = await bodyOf(TEMPLATES.BOT_TRUST);
    expect(text).toContain('امتیاز اعتماد شما');
    // The movement, in the language the user reads rather than the enum.
    expect(text).toContain('کامل کردن نمایه');
    expect(text).not.toContain('PROFILE_COMPLETE');
  });

  it('gives the referral code as a link somebody can send', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/referral');

    const text = await bodyOf(TEMPLATES.BOT_REFERRAL);
    expect(text).toContain('https://t.me/');
    expect(text).toContain('?start=');
  });

  /** The first command that takes an argument — `parseUpdate` threw it away before. */
  it('asks for the code when /gift arrives without one', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/gift');

    expect(await bodyOf(TEMPLATES.BOT_NOTICE)).toContain('/gift');
  });

  /**
   * A wrong code is refused, and **the code is not echoed back**. It may be a
   * campaign code somebody was given privately, and a bot repeating it into a
   * chat that may be screenshotted is a disclosure the Mini App's form never
   * made.
   */
  it('refuses an unknown code without repeating it', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/gift NOTAREALCODE');

    const text = await bodyOf(TEMPLATES.BOT_NOTICE);
    expect(text).not.toContain('NOTAREALCODE');
  });
});

/**
 * Writing a review from the bot.
 *
 * `/reviews` listed what you owed and gave you no way to pay it: the form was
 * `ReviewsView`, and v0.4.6 removed the last button that opened it. A row of
 * five ratings per pending review answers the part that moves the Trust Score.
 */
describe('POST /telegram/:secret — rating somebody', () => {
  let sequence = 9500;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  /** A participation whose review window is open right now. */
  async function seedPending(): Promise<{ guestId: string; participantPublicId: string }> {
    const { hostId, eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);
    await participation.accept(hostId, joined.publicId);

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { id: true, publicId: true, eventId: true },
    });
    await prisma.reviewPair.create({
      data: {
        participantId: participant.id,
        eventId: participant.eventId,
        opensAt: new Date(Date.now() - 60_000),
        deadlineAt: new Date(Date.now() + 86_400_000),
        status: 'PENDING',
      },
    });
    return { guestId, participantPublicId: participant.publicId };
  }

  it('offers five ratings per pending review, and rating writes one', async () => {
    const { guestId, participantPublicId } = await seedPending();

    await type(GUEST_TELEGRAM_ID, '/reviews');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_REVIEWS },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const raw = (digest.payload as Record<string, unknown>)['keyboard'];
    const rows = JSON.parse(String(raw)) as { text: string; callbackData: string }[][];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(5);
    expect(rows[0]?.[3]?.callbackData).toBe(`rv:rate4:${participantPublicId}`);

    await tap(GUEST_TELEGRAM_ID, `rv:rate4:${participantPublicId}`);

    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { rating: true },
    });
    expect(review.rating).toBe(4);
  });

  /**
   * The rating is two taps; the tags and the comment are the optional half.
   *
   * `ReviewService.edit` replaces the whole review, so the rating written by the
   * star tap is carried back in unchanged — asking for it again would make the
   * optional half feel like a second review.
   */
  it('opens the detail form after a rating, and amends the review', async () => {
    const { guestId, participantPublicId } = await seedPending();

    await tap(GUEST_TELEGRAM_ID, `rv:rate5:${participantPublicId}`);

    // The wizard is open, and it knows which participation it is for.
    const state = await prisma.conversationState.findUniqueOrThrow({
      where: { userId: guestId },
      select: { kind: true, targetPublicId: true },
    });
    expect(state.kind).toBe('WRITE_REVIEW');
    expect(state.targetPublicId).toBe(participantPublicId);

    await tap(GUEST_TELEGRAM_ID, 'wz:tag:FRIENDLY');
    await type(GUEST_TELEGRAM_ID, 'میزبان خوبی بود');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { rating: true, tags: true, comment: true },
    });
    // The rating survives the amendment untouched.
    expect(review.rating).toBe(5);
    expect(review.tags).toEqual(['FRIENDLY']);
    expect(review.comment).toBe('میزبان خوبی بود');
    // And the form closed.
    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(0);
  });

  /** Skipping both steps leaves the rating alone rather than saying «ثبت شد» twice. */
  it('adds nothing when both steps are skipped', async () => {
    const { guestId, participantPublicId } = await seedPending();

    await tap(GUEST_TELEGRAM_ID, `rv:rate3:${participantPublicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { rating: true, tags: true, comment: true },
    });
    expect(review.rating).toBe(3);
    expect(review.tags).toEqual([]);
    expect(review.comment).toBeNull();
  });

  /** A tampered participation is one the service declines. Authorisation is not in the button. */
  it("writes nothing for a participation that is not the caller's", async () => {
    await seedPending();
    await seedGuest(SECOND_GUEST_TELEGRAM_ID, 'کس دیگر');

    await tap(SECOND_GUEST_TELEGRAM_ID, 'rv:rate5:00000000-0000-4000-8000-000000000000');

    expect(await prisma.review.count()).toBe(0);
  });
});

/**
 * Joining an activity from the bot — the half of the product it could not do.
 *
 * `/discover` listed events from M13 and offered no way to act on one, so a
 * guest could see activities and not ask to join. `POST /events/:publicId/join`
 * was reachable only from `EventDetailView`, and v0.4.6 removed the last button
 * that opened it.
 */
describe('POST /telegram/:secret — joining and standing down', () => {
  let sequence = 9000;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  /** The keyboard the digest went out with, as the worker would render it. */
  function keyboardOf(payload: unknown): { text: string; callbackData: string }[][] {
    const raw = (payload as Record<string, unknown>)['keyboard'];
    return typeof raw === 'string'
      ? (JSON.parse(raw) as { text: string; callbackData: string }[][])
      : [];
  }

  it('offers detail and join on every discovered event, and joining works', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const buttons = keyboardOf(digest.payload).flat();
    expect(buttons.length).toBeGreaterThan(0);
    // Read it before joining it: «جزئیات» is the first button, and the ids in
    // both are the event's and nothing else.
    expect(buttons[0]?.callbackData).toBe(`ev:show:${eventPublicId}`);
    expect(buttons[1]?.callbackData).toBe(`ev:join:${eventPublicId}`);

    await tap(GUEST_TELEGRAM_ID, `ev:join:${eventPublicId}`);

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { status: true, publicId: true },
    });
    expect(participant.status).toBe('PENDING');
  });

  /**
   * `/discover` was city-only since M13 because the bot holds no query state.
   * It does not have to: the whole filter set fits in the callback, so every
   * button carries the complete query it produces.
   */
  it('offers when, cost and category filters under the events', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const all = keyboardOf(digest.payload).flat();
    const filters = all.filter((button) => button.callbackData.startsWith('dc:'));
    // Three whens, two costs, and «همه» plus every category.
    expect(filters.length).toBeGreaterThanOrEqual(6);
    // Nothing is filtered yet, so «هر زمان» is the marked one.
    expect(filters.find((button) => button.callbackData === 'dc:aa:all')?.text).toContain('✅');
  });

  /** A tap is «run this search», not «add this to what you remember about me». */
  it('re-runs the search with the filters the button carries', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, 'dc:tf:all');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const text = String((digest.payload as Record<string, unknown>)['text']);
    // The body names what it searched for: «فعالیتی پیدا نشد» under an active
    // filter otherwise reads as "your city is empty".
    expect(text).toContain('امروز');
    expect(text).toContain('رایگان');

    const filters = keyboardOf(digest.payload)
      .flat()
      .filter((button) => button.callbackData.startsWith('dc:'));
    // The active pair is marked, and tapping it again is what clears it.
    expect(filters.find((button) => button.callbackData === 'dc:tf:all')?.text).toContain('✅');
  });

  /** A malformed filter is not a search against everything. */
  it('ignores a tampered filter button', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);
    const before = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
    });

    await tap(GUEST_TELEGRAM_ID, 'dc:zz:all');

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_DISCOVER } }),
    ).toBe(before);
  });

  /**
   * Four lines is a scanning list. Deciding to spend an evening with strangers
   * on four lines is not a decision anybody should be asked to make.
   */
  it('shows the description, the cost and the host before you join', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `ev:show:${eventPublicId}`);

    const detail = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const payload = detail.payload as Record<string, unknown>;
    const text = String(payload['text']);
    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { description: true },
    });
    expect(text).toContain(event.description);
    expect(text).toContain('میزبان');
    // The decision is on the screen it was made on, not back in the digest.
    const rows = keyboardOf(payload).flat();
    expect(rows[0]?.callbackData).toBe(`ev:join:${eventPublicId}`);
  });

  /**
   * «تازه‌وارد» rather than a number when the host has never been judged. Null is
   * not zero, and rendering 0 would show the worst possible reputation to
   * somebody who has done nothing wrong.
   */
  it('does not invent a trust score for an unjudged host', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `ev:show:${eventPublicId}`);

    const detail = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const text = String((detail.payload as Record<string, unknown>)['text']);
    expect(text).toContain('تازه‌وارد');
    expect(text).not.toContain('۰ از ۱۰۰');
  });

  /** A tampered id names an event the service declines. Authorisation is not in the button. */
  it('refuses a join for an event that does not exist', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, 'ev:join:00000000-0000-4000-8000-000000000000');

    expect(await prisma.eventParticipant.count()).toBe(0);
  });

  /** The host cannot join their own activity, and the toast says so rather than throwing. */
  it('refuses the host joining their own event', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await tap(HOST_TELEGRAM_ID, `ev:join:${eventPublicId}`);

    expect(await prisma.eventParticipant.count()).toBe(0);
  });

  it('offers «لغو» on a live request, and cancelling works', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await type(GUEST_TELEGRAM_ID, '/requests');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_REQUESTS },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const buttons = keyboardOf(digest.payload).flat();
    expect(buttons).toHaveLength(1);

    await tap(GUEST_TELEGRAM_ID, buttons[0]?.callbackData ?? '');

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { status: true },
    });
    expect(participant.status).toBe('CANCELLED_BY_PARTICIPANT');
  });
});

/**
 * `/edit_profile` — the wizard ADR-0017 puts on the critical path.
 *
 * A user who cannot complete a profile cannot do anything, so this has to work
 * before the Mini App can be switched off.
 */
describe('POST /telegram/:secret — editing a profile in the chat', () => {
  let sequence = 7000;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  /**
   * The bug v0.4.7 shipped, as a test.
   *
   * `submitProfile` called `ProfileService.update` unconditionally, and `update`
   * refuses a profile that does not exist — an edit of nothing is not an edit.
   * That was fine while this wizard was only reachable from `/edit_profile` by
   * somebody who had onboarded in the Mini App; v0.4.7 pointed the consent gate
   * at it, so every new user filled in a whole profile, pressed «ثبت نمایه», and
   * was answered «برای ادامه، ابتدا پروفایل خود را کامل کنید» by the very form
   * that was completing it. Nothing was written and there was no way out from
   * inside the bot.
   */
  it('creates the profile for somebody who has none', async () => {
    const province = await prisma.province.create({
      data: { slug: 'p-first-profile', nameFa: 'تهران', isActive: true },
    });
    await prisma.city.update({
      where: { id: fixture.tehranId },
      data: { provinceId: province.id },
    });
    const provinceId = province.id;

    /**
     * The reported flow, start to finish.
     *
     * The consent is not ceremony here: `ProfileService.complete` refuses a user
     * still in `onboarding_state = NEW` with `TERMS_NOT_ACCEPTED`, so a profile
     * cannot be created before the policies are accepted — and accepting is what
     * v0.4.7 made open this wizard in the first place.
     */
    await prisma.policyVersion.updateMany({
      where: { type: 'TERMS', isCurrent: true },
      data: { isCurrent: false },
    });
    await prisma.policyVersion.create({
      data: {
        type: 'TERMS',
        version: 9,
        status: 'PUBLISHED',
        isCurrent: true,
        titleFa: 'قوانین',
        summaryFa: 'خلاصه',
        contentMd: '# سند',
      },
    });

    // `/start` on an unseen id: an account, no profile row, and the gate.
    await type(NEWCOMER_TELEGRAM_ID, '/start');
    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { telegramUserId: BigInt(NEWCOMER_TELEGRAM_ID) },
      select: { userId: true },
    });
    expect(await prisma.userProfile.count({ where: { userId: account.userId } })).toBe(0);

    // Accepting hands over the profile form — no `/edit_profile` typed.
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:agree:');
    expect(
      await prisma.conversationState.findUniqueOrThrow({ where: { userId: account.userId } }),
    ).toMatchObject({ kind: 'EDIT_PROFILE' });

    await type(NEWCOMER_TELEGRAM_ID, 'شوماخر');
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:gender:MALE');
    await type(NEWCOMER_TELEGRAM_ID, '1990');
    await tap(NEWCOMER_TELEGRAM_ID, `wz:prov:${provinceId}`);
    await tap(NEWCOMER_TELEGRAM_ID, `wz:city:${fixture.tehranId}`);
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // bio
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:confirm:');

    const profile = await prisma.userProfile.findUniqueOrThrow({
      where: { userId: account.userId },
    });
    expect(profile.displayName).toBe('شوماخر');
    expect(profile.birthYear).toBe(1990);
    expect(profile.cityId).toBe(fixture.tehranId);
    // `complete` is an onboarding step, so it advances the state `update` never
    // touches — which is what stops `/discover` refusing them afterwards.
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: account.userId },
        select: { onboardingState: true },
      }),
    ).toMatchObject({ onboardingState: 'PROFILE_COMPLETE' });
    // And the form closed, rather than surviving a refusal.
    expect(await prisma.conversationState.count({ where: { userId: account.userId } })).toBe(0);
  });

  /** A first profile needs a name, a year and a city; the wizard lets you skip all three. */
  it('names what is missing rather than refusing generically', async () => {
    await type(NEWCOMER_TELEGRAM_ID, '/start');

    await type(NEWCOMER_TELEGRAM_ID, '/edit_profile');
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // name
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // gender
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // birth year
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // province
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // city
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:skip:'); // bio
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:confirm:');

    const notice = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_NOTICE },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const text = String((notice.payload as Record<string, unknown>)['text']);
    expect(text).toContain('نام');
    expect(text).toContain('سال تولد');
    expect(text).toContain('شهر');
    // The draft survives, so «ویرایش» walks back to the step they skipped.
    expect(await prisma.conversationState.count()).toBe(1);
  });

  it('changes only the fields that were answered', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID, 'نام قدیمی');
    const before = await prisma.userProfile.findUniqueOrThrow({ where: { userId } });

    await type(GUEST_TELEGRAM_ID, '/edit_profile');
    await type(GUEST_TELEGRAM_ID, 'نام تازه');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // gender
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // birth year
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // province
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // city
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // bio
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const after = await prisma.userProfile.findUniqueOrThrow({ where: { userId } });
    expect(after.displayName).toBe('نام تازه');
    // A skipped step means "leave this alone", not "clear it".
    expect(after.birthYear).toBe(before.birthYear);
    expect(after.cityId).toBe(before.cityId);
  });

  /**
   * The mistake this product will actually see: a Persian speaker types their
   * Jalali birth year. The refusal has to name the conversion, or they retype
   * the same number.
   */
  it('explains the Jalali year rather than only refusing it', async () => {
    await seedGuest(GUEST_TELEGRAM_ID, 'نام');

    await type(GUEST_TELEGRAM_ID, '/edit_profile');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // name
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // gender
    await type(GUEST_TELEGRAM_ID, '۱۳۷۰');

    const state = await prisma.conversationState.findFirstOrThrow();
    // Held on the same step rather than advanced past a value it refused.
    expect(state.step).toBe('birth');
  });
});

/**
 * The consent gate, on the surface that never had one (ADR-0017).
 *
 * The policy gate has always lived in `AuthGuard`, applied per route. **The bot
 * does not pass through `AuthGuard`** — `BotService` calls domain services
 * directly — so every write the bot could do bypassed it: relaying a chat
 * message, accepting a request, sharing contact details. That hole predates the
 * wizards; the wizards are what made it worth finding.
 */
describe('POST /telegram/:secret — the consent gate', () => {
  let sequence = 8000;

  async function publish(type: 'TERMS' | 'PRIVACY', version: number): Promise<string> {
    await prisma.policyVersion.updateMany({
      where: { type, isCurrent: true },
      data: { isCurrent: false },
    });
    const row = await prisma.policyVersion.create({
      data: {
        type,
        version,
        status: 'PUBLISHED',
        isCurrent: true,
        titleFa: type === 'TERMS' ? 'قوانین' : 'حریم خصوصی',
        summaryFa: 'خلاصهٔ سند',
        contentMd: '# سند',
      },
      select: { id: true },
    });
    return row.id;
  }

  async function requirePolicies(): Promise<void> {
    await publish('TERMS', 1);
    await publish('PRIVACY', 1);
  }

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  it('opens the consent gate instead of the wizard, when policies are owed', async () => {
    await requirePolicies();
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/create_event');

    const state = await prisma.conversationState.findUniqueOrThrow({ where: { userId } });
    expect(state.kind).toBe('ACCEPT_POLICIES');
    expect(state.step).toBe('review');
  });

  it('accepts the policies and clears the gate', async () => {
    await requirePolicies();
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/create_event');
    await tap(GUEST_TELEGRAM_ID, 'wz:agree:');
    expect(await prisma.consent.count({ where: { userId } })).toBe(2);
    // The gate is over: no conversation is left open.
    expect(await prisma.conversationState.count({ where: { userId } })).toBe(0);
  });

  /** A gate has nothing to mistype and nothing to skip. */
  it('does not advance on anything but «می‌پذیرم»', async () => {
    await requirePolicies();
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/create_event');
    await type(GUEST_TELEGRAM_ID, 'باشه');

    expect(await prisma.consent.count({ where: { userId } })).toBe(0);
    expect(await prisma.conversationState.findUniqueOrThrow({ where: { userId } })).toMatchObject({
      step: 'review',
    });
  });

  /**
   * The hole this closes, stated as a test. Relaying a message is a write, and
   * `POST /chats/:id/messages` has carried `@RequiresCurrentPolicies()` since
   * M22 — the bot's relay never did.
   */
  it('refuses to relay a chat message from somebody who owes an acceptance', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);
    // Published *after* the join, so the user is mid-conversation and now owes.
    await requirePolicies();

    await type(GUEST_TELEGRAM_ID, 'سلام');

    expect(await prisma.chatMessage.count({ where: { kind: 'TEXT' } })).toBe(0);
    expect(
      await prisma.conversationState.findUniqueOrThrow({ where: { userId: guestId } }),
    ).toMatchObject({ kind: 'ACCEPT_POLICIES' });
  });

  /** A redelivered «می‌پذیرم» is one acceptance, not two. */
  it('writes one consent row for a redelivered tap', async () => {
    await requirePolicies();
    const userId = await seedGuest(GUEST_TELEGRAM_ID);
    await type(GUEST_TELEGRAM_ID, '/create_event');

    const agree = update({
      update_id: 8500,
      callback_query: {
        id: 'cb-agree',
        from: sender(GUEST_TELEGRAM_ID),
        message: { message_id: 1, chat: { id: GUEST_TELEGRAM_ID, type: 'private' } },
        data: 'wz:agree:',
      },
    });
    await post(agree);
    await post(agree);

    expect(await prisma.consent.count({ where: { userId } })).toBe(2); // TERMS + PRIVACY, once each
  });

  /**
   * The rest of onboarding, without being asked for (report: "fix the flow").
   *
   * The gate used to end by naming `/discover` and `/create_event`, and both of
   * those then stopped the user again — a profile is where the city comes from,
   * and neither command works without one. So the acceptance hands a new user
   * the profile form rather than a list of commands that will refuse them.
   */
  it('opens the profile form after a new user accepts', async () => {
    await requirePolicies();

    // `/start` on an unseen Telegram id: an account, and no profile.
    await type(NEWCOMER_TELEGRAM_ID, '/start');
    await tap(NEWCOMER_TELEGRAM_ID, 'wz:agree:');

    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { telegramUserId: BigInt(NEWCOMER_TELEGRAM_ID) },
      select: { userId: true },
    });
    expect(
      await prisma.conversationState.findUniqueOrThrow({ where: { userId: account.userId } }),
    ).toMatchObject({ kind: 'EDIT_PROFILE' });
  });

  /**
   * And it stays out of the way of somebody who already has one — a returning
   * user re-accepting a republished policy is finished, and telling them to make
   * a profile they made months ago would be the product not knowing them.
   */
  it('leaves a user who already has a profile alone', async () => {
    await requirePolicies();
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/create_event');
    await tap(GUEST_TELEGRAM_ID, 'wz:agree:');

    expect(await prisma.conversationState.count({ where: { userId } })).toBe(0);
    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_CONSENT_ACCEPTED } }),
    ).toBe(1);
  });

  /** `/terms` for somebody up to date reports what they signed and when. */
  it('reports standing on /terms once accepted', async () => {
    await requirePolicies();
    await seedGuest(GUEST_TELEGRAM_ID);
    await type(GUEST_TELEGRAM_ID, '/create_event');
    await tap(GUEST_TELEGRAM_ID, 'wz:agree:');

    await type(GUEST_TELEGRAM_ID, '/terms');

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_TERMS_STANDING },
      select: { payload: true },
    });
    expect(String((row.payload as Record<string, unknown>)['text'])).toContain('قوانین');
  });
});

/**
 * `/edit_event` — `EditEventView`, as a conversation (ADR-0017).
 *
 * The property worth an integration test is **host-only**: the button that
 * carries an event id was built from the caller's own list, so the only way to
 * reach a stranger's event is to forge one, and `findOwned` is where that has to
 * fail.
 */
describe('POST /telegram/:secret — editing an event in the chat', () => {
  let sequence = 9000;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  async function tap(telegramUserId: number, data: string): Promise<void> {
    sequence += 1;
    await post(
      update({
        update_id: sequence,
        callback_query: {
          id: `cb-${String(sequence)}`,
          from: sender(telegramUserId),
          message: { message_id: 1, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      }),
    );
  }

  it('prefills the draft from the chosen event', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await type(HOST_TELEGRAM_ID, '/edit_event');
    await tap(HOST_TELEGRAM_ID, `wz:pick:${eventPublicId}`);

    const state = await prisma.conversationState.findFirstOrThrow();
    expect(state.kind).toBe('EDIT_EVENT');
    // The target is recorded, which is what `submitEventEdit` addresses.
    expect(state.targetPublicId).toBe(eventPublicId);
  });

  it('changes only what the host walked through', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const before = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });

    await type(HOST_TELEGRAM_ID, '/edit_event');
    await tap(HOST_TELEGRAM_ID, `wz:pick:${eventPublicId}`);
    await type(HOST_TELEGRAM_ID, 'نام تازهٔ فعالیت');
    // Skip the remaining ten steps; each means "leave this as it is".
    for (let i = 0; i < 12; i += 1) await tap(HOST_TELEGRAM_ID, 'wz:skip:');
    await tap(HOST_TELEGRAM_ID, 'wz:confirm:');

    const after = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(after.title).toBe('نام تازهٔ فعالیت');
    // Prefilled and written back unchanged, which is a no-op rather than a loss.
    expect(after.capacity).toBe(before.capacity);
    expect(after.startsAt.toISOString()).toBe(before.startsAt.toISOString());
    expect(await prisma.conversationState.count()).toBe(0);
  });

  /** A forged id names an event the caller does not host. */
  it('does not prefill from an event the caller does not host', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/edit_event');
    // The guest hosts nothing, so the command refuses before a wizard opens.
    expect(await prisma.conversationState.count()).toBe(0);

    // And even driven directly, the host's event is not reachable.
    await tap(GUEST_TELEGRAM_ID, `wz:pick:${eventPublicId}`);
    const event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.title).not.toBe('');
  });

  it('says so when there is nothing to edit', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/edit_event');

    const notice = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_NOTICE },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    expect(String((notice.payload as Record<string, unknown>)['text'])).toContain(
      'فعالیتی برای ویرایش ندارید',
    );
  });
});
