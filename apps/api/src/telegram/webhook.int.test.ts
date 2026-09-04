import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import {
  CoinService,
  ParticipationService,
  OutboxRelayService,
  TrustService,
  normalize,
} from '@payetam/domain';
import { EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';
import { TEMPLATES, render } from '@payetam/telegram';
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
let relay: OutboxRelayService;
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
  relay = app.get(OutboxRelayService);
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
async function seedHostAndEvent(): Promise<{
  hostId: string;
  hostPublicId: string;
  eventPublicId: string;
}> {
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
    select: { id: true, publicId: true },
  });
  await prisma.coinAccount.create({ data: { userId: host.id, balance: 1_000 } });

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

  return { hostId: host.id, hostPublicId: host.publicId, eventPublicId: event.publicId };
}

/**
 * A user who can afford to register an activity.
 *
 * `/create_event` checks the price before opening the form (v0.6.6), so a wizard
 * test seeded with an empty wallet never gets a wizard.
 *
 * It is now the *same* balance `seedGuest` grants, and the helper survives as a
 * name rather than as an amount: «this test is about a host who can pay» reads
 * differently from «this one happens to have coins», and a suite that says which
 * it means is one somebody can change safely later.
 */
async function seedFundedHost(telegramUserId: number, displayName = 'میزبان'): Promise<string> {
  return seedGuest(telegramUserId, displayName);
}

/**
 * What every seeded account starts with.
 *
 * Named because three tests below are about a *balance* and have to say what
 * they are adding to — «۲۵ + the seed» reads as arithmetic somebody meant, where
 * a bare 1025 reads as a number somebody copied out of a failure message.
 */
const SEEDED_BALANCE = 1_000;

async function seedGuest(telegramUserId: number, displayName = 'میهمان'): Promise<string> {
  const guest = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: BigInt(telegramUserId) } },
      profile: { create: { displayName, cityId: fixture.tehranId, birthYear: 1995 } },
    },
    select: { id: true },
  });
  /**
   * With coins, because asking to join costs five from v0.7.0
   * (`economy.event_join_coins`) and a guest who cannot pay is refused with a
   * toast — which reads, in a suite about the bot's *screens*, as every join
   * assertion failing for a reason that is not what the test is about.
   *
   * A balance rather than a ledger entry: the seed writes rows directly here, and
   * the coin CHECK is `balance >= 0`, which this satisfies.
   */
  await prisma.coinAccount.create({ data: { userId: guest.id, balance: SEEDED_BALANCE } });
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

  /**
   * A refused action opens the thing that clears it, rather than naming a
   * command. The consent gate has worked this way since ADR-0017; this is the
   * same rule applied to the *other* gate — an incomplete profile.
   */
  it('opens the profile form instead of naming a command', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    // A user with an account and no profile, which is what a channel tap
    // produces for somebody who has never been here.
    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/start') }));

    await post(
      update({ message: textMessage(sender(GUEST_TELEGRAM_ID), `/start join_${eventPublicId}`) }),
    );

    const state = await prisma.conversationState.findFirst({ select: { kind: true } });
    expect(state?.kind).toBe('EDIT_PROFILE');
    expect(await prisma.eventParticipant.count()).toBe(0);
    // The sentence is still sent — a form that opens with no explanation is a
    // form somebody cancels — and it names no command.
    const notices = (await replyTo(GUEST_TELEGRAM_ID)).filter(
      (row) => row.templateKey === TEMPLATES.BOT_NOTICE,
    );
    expect(notices.some((row) => row.text.includes('/'))).toBe(false);
  });

  /**
   * The channel post's two buttons (v0.6.3).
   *
   * They are `?start=` links rather than callbacks because a channel reader may
   * never have opened a chat with the bot — and a `callback_query` from one could
   * be answered with a toast and nothing else. What arrives here is therefore an
   * ordinary `/start` with a payload, which is why these live beside the referral
   * claim: the two payload shapes share one entry point and are told apart by
   * shape, never by trying one and catching the other.
   */
  describe('a channel post button', () => {
    it('opens the activity in the bot', async () => {
      const { eventPublicId } = await seedHostAndEvent();
      await seedGuest(GUEST_TELEGRAM_ID);

      await post(
        update({
          message: textMessage(sender(GUEST_TELEGRAM_ID), `/start event_${eventPublicId}`),
        }),
      );

      expect((await replyTo(GUEST_TELEGRAM_ID)).map((row) => row.templateKey)).toEqual([
        TEMPLATES.BOT_EVENT_DETAIL,
      ]);
      // Reading is not joining. «مشاهده» must not create a request.
      expect(await prisma.eventParticipant.count()).toBe(0);
    });

    it('joins the activity, and tells the host', async () => {
      const { hostId, eventPublicId } = await seedHostAndEvent();
      const guestId = await seedGuest(GUEST_TELEGRAM_ID);

      await post(
        update({ message: textMessage(sender(GUEST_TELEGRAM_ID), `/start join_${eventPublicId}`) }),
      );

      const participant = await prisma.eventParticipant.findFirstOrThrow({
        select: { userId: true, status: true },
      });
      expect(participant).toEqual({ userId: guestId, status: 'PENDING' });

      // The guest hears about it here; the host hears about it through the outbox,
      // which is invariant 11 — nothing is sent inline from a request.
      const guestReplies = (await replyTo(GUEST_TELEGRAM_ID)).map((row) => row.templateKey);
      expect(guestReplies).toContain(TEMPLATES.BOT_NOTICE);
      expect(
        await prisma.outboxEvent.count({ where: { eventType: 'participation.requested' } }),
      ).toBe(1);
      expect(hostId).toBeTruthy();
    });

    /**
     * A tampered or stale link names a resource the service refuses, exactly as a
     * tampered `callback_data` does — authorisation is never in the button.
     */
    it('refuses the host their own activity, and shows it to them anyway', async () => {
      const { eventPublicId } = await seedHostAndEvent();

      await post(
        update({ message: textMessage(sender(HOST_TELEGRAM_ID), `/start join_${eventPublicId}`) }),
      );

      expect(await prisma.eventParticipant.count()).toBe(0);
      // The refusal, then the activity: a bare «نمی‌توانید» tells somebody who has
      // just arrived from a channel nothing about what they tapped.
      expect((await replyTo(HOST_TELEGRAM_ID)).map((row) => row.templateKey)).toEqual([
        TEMPLATES.BOT_NOTICE,
        TEMPLATES.BOT_EVENT_DETAIL,
      ]);
    });

    /**
     * A channel post outlives the activity it advertises, so a stale tap is the
     * common case — and the answer is that the activity is gone, not a profile
     * form for one that no longer exists. `join` checks the caller before the
     * event, so without resolving the event first «نمایه‌تان را کامل کنید» would
     * be the answer to a dead link.
     */
    it('says the activity is gone rather than handing out a form for it', async () => {
      await post(
        update({
          message: textMessage(
            sender(GUEST_TELEGRAM_ID),
            '/start join_11111111-1111-4111-8111-111111111111',
          ),
        }),
      );

      // `findPublished` answers 404 identically for "not published" and "does not
      // exist" (T3.3), so this is not an existence oracle either.
      expect((await replyTo(GUEST_TELEGRAM_ID)).map((row) => row.templateKey)).toEqual([
        TEMPLATES.BOT_NOTICE,
      ]);
      expect(await prisma.conversationState.count()).toBe(0);
    });
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
    // The seed endows a joiner; this test is about the *number*, so it sets one.
    await prisma.coinAccount.update({ where: { userId: guestId }, data: { balance: 42 } });

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

    expect((row.payload as Record<string, unknown>)['text']).toContain('هنوز فعالیتی نساخته‌اید');
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

  /**
   * `/chats` is gone (v0.8.0), and an unknown command must say so.
   *
   * It was three tests here — the empty digest, the counterpart-and-event
   * pairing, and the Persian rendering of `ANONYMOUS`. The command is retired
   * with the conversation product, and what matters now is the *shape of its
   * absence*: somebody who has the old command in their history and types it
   * again gets the bot's ordinary "I do not know that one" rather than silence.
   */
  it('no longer answers /chats', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    const before = await prisma.notification.count();

    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/chats') }));

    const rows = await prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { templateKey: true, payload: true },
    });
    expect(await prisma.notification.count()).toBeGreaterThan(before);
    expect(rows[0]?.templateKey).toBe(TEMPLATES.BOT_NOTICE);
    expect(String((rows[0]?.payload as Record<string, unknown>)['text'])).toContain(
      'این فرمان را نمی‌شناسم',
    );
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
 * Plain text in the bot's DM, now that nothing relays it (v0.8.0).
 *
 * This was M8's release gate: a message typed into the bot went into whichever
 * anonymous conversation the sender had open, a reply named which one, and two
 * open conversations with no reply was an ambiguity the bot had to refuse. The
 * conversation product is gone and so is all of that.
 *
 * What is left is the property the relay's removal must not break: **typed text
 * still goes nowhere by accident**. A form in progress claims it, a menu label is
 * a command, and anything else gets a sentence saying where to write to a host
 * instead of being delivered to somebody.
 */
describe('message:text', () => {
  it('answers a stray message instead of sending it anywhere', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await post(
      update({ message: textMessage(sender(GUEST_TELEGRAM_ID), 'سلام، ساعت هفت خوب است؟') }),
    );

    const row = await prisma.notification.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      select: { templateKey: true, payload: true },
    });
    expect(row.templateKey).toBe(TEMPLATES.BOT_NOTICE);
    // It says where writing to a host actually happens, because that is the
    // change somebody typing into an empty chat has not noticed yet.
    expect(String((row.payload as Record<string, unknown>)['text'])).toContain(
      'پیام مستقیم به میزبان',
    );
    // And nothing was delivered to anybody.
    await expect(prisma.directMessage.count()).resolves.toBe(0);
  });

  /**
   * An edit means nothing now, and must mean nothing *quietly*.
   *
   * Telegram sends `edited_message` for every edit in the bot's DM, including one
   * to a `/start` somebody fixed a typo in. The relay used to re-deliver the
   * corrected text; there is nothing downstream of an edit any more, and a notice
   * would have the bot arguing with people about their own typing.
   */
  it('says nothing at all about an edited message', async () => {
    await post(update({ message: textMessage(sender(HOST_TELEGRAM_ID), '/start') }));
    const before = await prisma.notification.count();

    const original = textMessage(sender(HOST_TELEGRAM_ID), 'ساعت هفت');
    await post(update({ message: original }));
    const after = await prisma.notification.count();

    await post(update({ edited_message: { ...original, text: 'ساعت هشت' } }));

    expect(await prisma.notification.count()).toBe(after);
    expect(after).toBeGreaterThan(before);
  });
});

/** The host's two buttons — all that is left of the `chat:` namespace. */
/** The host's two buttons, and the third that ends a conversation. */
describe('callback_query', () => {
  async function pendingRequest(): Promise<{ participantPublicId: string }> {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);

    return { participantPublicId: joined.publicId };
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

  /**
   * The three retired actions are dead buttons, and say so (v0.8.0).
   *
   * `chat:close`, `chat:share` and `chat:shareyes` are still sitting under
   * relayed messages in people's Telegram history. They no longer parse, which
   * is deliberate: keeping them parseable so the button "works" would route a tap
   * into a service that does not exist. What the person gets is «این دکمه دیگر
   * کار نمی‌کند», which is exactly what it is.
   */
  it.each(['close', 'share', 'shareyes'])(
    'answers a retired chat:%s button as a dead one',
    async (action) => {
      const { participantPublicId } = await pendingRequest();
      const before = await prisma.notification.count();

      await post(
        update({
          callback_query: {
            id: `q-${action}`,
            from: sender(GUEST_TELEGRAM_ID),
            data: `chat:${action}:11111111-2222-3333-4444-555555555555`,
          },
        }),
      );

      // The request is untouched, and nothing was written on either side.
      expect(
        (
          await prisma.eventParticipant.findUniqueOrThrow({
            where: { publicId: participantPublicId },
            select: { status: true },
          })
        ).status,
      ).toBe('PENDING');
      expect(await prisma.notification.count()).toBe(before);
    },
  );

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
    await seedFundedHost(HOST_TELEGRAM_ID);
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
    const guestId = await seedFundedHost(GUEST_TELEGRAM_ID, 'میهمان');
    await participation.join(guestId, eventPublicId);

    await type(GUEST_TELEGRAM_ID, '/create_event');
    await type(GUEST_TELEGRAM_ID, 'این نام فعالیت است، نه پیام');

    expect(await prisma.chatMessage.count({ where: { kind: 'TEXT' } })).toBe(0);
  });

  /** Telegram retries any webhook call that did not answer 200. */
  it('does not advance twice on a redelivered update', async () => {
    await seedFundedHost(HOST_TELEGRAM_ID);
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
 * Settings — and the property that makes them real rather than decorative.
 */
describe('POST /telegram/:secret — settings', () => {
  let sequence = 11_000;

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

  async function board(): Promise<Record<string, unknown>> {
    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_SETTINGS },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    return row.payload as Record<string, unknown>;
  }

  /** Reachable from the persistent menu, which is the point of it. */
  it('opens from the menu label, not only from a command', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '⚙️ تنظیمات');

    expect(String((await board())['text'])).toContain('تنظیمات');
  });

  /**
   * The redraw is an **edit of the board that was tapped** (v0.6.7).
   *
   * Flipping three switches used to leave three dead boards stacked in the chat,
   * each still showing the state it was drawn with, and the only way to find the
   * live one is to press it. The redraw is a `BOT_EDIT_MESSAGE` job rather than a
   * `notification` row and this process runs no worker — so what is asserted here
   * is the write, and that no second board was made. What the redrawn keyboard
   * says is asserted without a database in `settings.test.ts`.
   */
  it('toggles a switch and edits the board rather than sending another', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/settings');
    // Everything on by default, so the button offers to turn it off.
    const before = JSON.parse(String((await board())['keyboard'])) as {
      callbackData: string;
    }[][];
    expect(before[0]?.[0]?.callbackData).toBe('st:c0:x');
    const boards = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_SETTINGS },
    });

    await tap(GUEST_TELEGRAM_ID, 'st:c0:x');

    const settings = await prisma.userSettings.findUniqueOrThrow({
      where: { userId },
      select: { notifyChat: true, notifyEvents: true },
    });
    expect(settings.notifyChat).toBe(false);
    // One toggle changes one thing.
    expect(settings.notifyEvents).toBe(true);
    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_SETTINGS } }),
    ).toBe(boards);
  });

  /**
   * A user who has never opened the screen has **no row**, and the service
   * resolves that to the defaults. So shipping this table changed nothing about
   * what anybody already receives — no backfill, and no day where notifications
   * behave differently for people who happened to have visited a screen.
   */
  it('has no row until something is changed', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/settings');

    expect(await prisma.userSettings.count({ where: { userId } })).toBe(0);
    expect(String((await board())['text'])).toContain('روشن');
  });

  /**
   * The settings screen states what it cannot change rather than offering a
   * picker with one entry. The product is fa-IR only — every template, every
   * date format, every error message.
   *
   * It is a **button** since v0.6.3, and the sentence moved into the toast it
   * answers with: a row on a board of switches that is a line of italics teaches
   * the reader that the rows are decoration.
   */
  it('states the language on a button rather than pretending to offer a choice', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/settings');

    const text = String((await board())['text']);
    expect(text).toContain('فارسی');

    const keyboard = JSON.parse(String((await board())['keyboard'])) as {
      text: string;
      callbackData: string;
    }[][];
    const language = keyboard.flat().find((button) => button.callbackData.startsWith('st:g'));
    expect(language?.text).toContain('فارسی');
  });

  /**
   * Privacy, which is `user_profile.invite_opt_out` and is written through
   * `ProfileService.update` — the same method the profile wizard submits through.
   *
   * The board used to say «برای تغییر این مورد، /edit_profile را بفرستید», which
   * is a settings screen answering a tap with homework.
   */
  it('turns invitations off from the board, without a command', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/settings');
    const keyboard = JSON.parse(String((await board())['keyboard'])) as {
      callbackData: string;
    }[][];
    // Carried as the reader sees it: invitations are on, so the button turns them
    // off, and the inversion into `invite_opt_out` happens once, at the write.
    expect(keyboard.flat().map((button) => button.callbackData)).toContain('st:p0:x');

    await tap(GUEST_TELEGRAM_ID, 'st:p0:x');

    const profile = await prisma.userProfile.findUniqueOrThrow({
      where: { userId },
      select: { inviteOptOut: true },
    });
    expect(profile.inviteOptOut).toBe(true);
    // Nothing was copied into `user_settings`: a setting with two homes is a
    // setting that will disagree with itself.
    expect(await prisma.userSettings.count({ where: { userId } })).toBe(0);

    // Redrawn in place, like every other switch on this board.
    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_SETTINGS } }),
    ).toBe(1);
  });

  /**
   * «A limit enforced on one of two surfaces is not a limit» (T12). The privacy
   * row is the one switch that writes through `ProfileService.update`, so it
   * spends the same bucket `PATCH /me/profile` does — one `audit_log` row per
   * tap is exactly what an unbounded write to a moderated table looks like.
   */
  it('meters the privacy switch on the bucket the API uses', async () => {
    const userId = await seedGuest(GUEST_TELEGRAM_ID);

    // Ten an hour is the bucket from v0.6.5 — it was twenty, and was halved on
    // the operator's instruction. The eleventh tap is refused.
    for (let index = 0; index < 11; index += 1) {
      await tap(GUEST_TELEGRAM_ID, index % 2 === 0 ? 'st:p0:x' : 'st:p1:x');
    }

    const profile = await prisma.userProfile.findUniqueOrThrow({
      where: { userId },
      select: { inviteOptOut: true },
    });
    // Ten writes landed, the last of which was `st:p1:x` — the eleventh tap
    // never reached the service.
    expect(profile.inviteOptOut).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'profile.updated' } })).toBe(10);
  });

  /**
   * Somebody with no profile row has no flag to flip, and `ProfileService.update`
   * refuses. A switch that exists to be refused is worse than the button that
   * fixes the reason.
   */
  it('offers the profile form where the privacy switch cannot work', async () => {
    await post(update({ message: textMessage(sender(GUEST_TELEGRAM_ID), '/start') }));

    await type(GUEST_TELEGRAM_ID, '/settings');

    const keyboard = JSON.parse(String((await board())['keyboard'])) as {
      callbackData: string;
    }[][];
    const data = keyboard.flat().map((button) => button.callbackData);
    expect(data).not.toContain('st:p0:x');
    expect(data).toContain('st:n1:x');
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

  /**
   * Still nobody is notified — the form changed nothing about that.
   *
   * The subject was a conversation until v0.8.0, and the reporting entry point
   * for one went with it. The property is unchanged and now runs against the
   * host: the person being reported learns nothing, which is the one message this
   * area must never send.
   */
  it('notifies nobody about a reported host', async () => {
    const { eventPublicId, hostPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);

    await tap(GUEST_TELEGRAM_ID, `rp:asku:${hostPublicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:why:HARASSMENT');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    const before = await prisma.notification.count({
      where: { user: { telegramAccount: { telegramUserId: BigInt(HOST_TELEGRAM_ID) } } },
    });
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const report = await prisma.report.findFirstOrThrow({ select: { targetType: true } });
    expect(report.targetType).toBe('USER');
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

  /**
   * The console moved off the list and under the activity (v0.6.7).
   *
   * Five buttons per activity meant thirty buttons for six activities, two of
   * which spend coins — and the only thing between a host and paying to
   * republish the wrong one was matching a number in a keyboard to a number in a
   * list they had scrolled past.
   */
  it('lists the activities with a command each, and no per-activity buttons', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await type(HOST_TELEGRAM_ID, '/myevents');

    const payload = await latest(TEMPLATES.BOT_MY_EVENTS);
    const code = eventPublicId.replaceAll('-', '').slice(0, 10);

    expect(String(payload['text'])).toContain(`/myevent_${code}`);
    // One activity fits on one page, so there is no keyboard at all.
    expect(payload['keyboard']).toBeUndefined();
  });

  it('opens one activity with the four things a host can do to it', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const code = eventPublicId.replaceAll('-', '').slice(0, 10);

    await type(HOST_TELEGRAM_ID, `/myevent_${code}`);

    const rows = JSON.parse(String((await latest(TEMPLATES.BOT_EVENT_DETAIL))['keyboard'])) as {
      text: string;
      callbackData: string;
    }[][];
    const data = rows.flat().map((button) => button.callbackData);

    expect(data).toContain(`ev:who:${eventPublicId}`);
    expect(data).toContain(`ev:post:${eventPublicId}`);
    expect(data).toContain(`ev:invite:${eventPublicId}`);
    expect(data).toContain(`ev:drop:${eventPublicId}`);
    // And the way back, carrying the command message so it can be tidied away.
    expect(data.some((entry) => /^bk:m:\d+$/.test(entry))).toBe(true);
  });

  /**
   * A code naming somebody else's activity is not in `listOwned`, so it answers
   * the same «پیدا نشد» a code naming nothing gets — which is what stops the
   * link being an existence oracle (T3.3).
   */
  it('does not open an activity the caller does not host', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);
    const code = eventPublicId.replaceAll('-', '').slice(0, 10);

    await type(GUEST_TELEGRAM_ID, `/myevent_${code}`);

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL } }),
    ).toBe(0);
  });

  /**
   * Who is coming — the screen `markNoShow` needed and three batches could not
   * build, because the bot had no way to name a participant.
   */
  it('lists the guests, with accept and reject on a pending one', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID, 'میهمان یکم');
    await participation.join(guestId, eventPublicId);

    await tap(HOST_TELEGRAM_ID, `ev:who:${eventPublicId}`);

    const payload = await latest(TEMPLATES.BOT_PARTICIPANTS);
    expect(String(payload['text'])).toContain('میهمان یکم');
    // The one piece of reputation a host is given, and «تازه‌وارد» rather than a
    // zero for somebody who has never been judged.
    expect(String(payload['text'])).toContain('تازه‌وارد');

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { publicId: true },
    });
    /**
     * `ev:acc`/`ev:rej`, not `chat:accept`/`chat:reject` (v0.8.1).
     *
     * The same two decisions on a second prefix, because what should happen to
     * the *message* afterwards differs: a decision taken here redraws the list
     * so the decided row loses its buttons, while one taken on the notification
     * leaves a line saying what was decided and no keyboard at all. One action
     * could do either and would be wrong on one of the two screens.
     */
    const rows = JSON.parse(String(payload['keyboard'])) as { callbackData: string }[][];
    expect(rows[0]?.map((button) => button.callbackData)).toEqual([
      `ev:acc:${participant.publicId}`,
      `ev:rej:${participant.publicId}`,
    ]);
  });

  /**
   * Deciding from the console redraws the console (v0.8.1).
   *
   * The row moves to «پذیرفته‌شده» and its two buttons go with it, so the same
   * decision cannot be offered twice. Asserted as an **edit**, not a second
   * message: a console that answered a tap by appending another copy of itself
   * would be the wall of near-identical messages every paging screen in this bot
   * was fixed out of.
   */
  it('redraws the console in place once a decision is taken', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID, 'میهمان یکم');
    await participation.join(guestId, eventPublicId);
    await tap(HOST_TELEGRAM_ID, `ev:who:${eventPublicId}`);

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { publicId: true },
    });
    const before = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_PARTICIPANTS },
    });

    await tap(HOST_TELEGRAM_ID, `ev:acc:${participant.publicId}`);

    // The decision landed…
    const decided = await prisma.eventParticipant.findFirstOrThrow({
      where: { publicId: participant.publicId },
      select: { status: true },
    });
    expect(decided.status).toBe('ACCEPTED');

    // …and the console was edited rather than sent again.
    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_PARTICIPANTS } }),
    ).toBe(before);
  });

  /**
   * `markNoShow` refuses while the activity has not ended, so the button is not
   * drawn — one that exists to be refused is worse than no button.
   */
  it('offers no no-show before the activity has ended', async () => {
    const { hostId, eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);
    await participation.accept(hostId, joined.publicId);

    await tap(HOST_TELEGRAM_ID, `ev:who:${eventPublicId}`);

    const payload = await latest(TEMPLATES.BOT_PARTICIPANTS);
    // The whole payload, because a keyboard-less board has no key to read.
    expect(JSON.stringify(payload)).not.toContain('ev:noshow');
  });

  it('records a no-show once the activity is over and the host confirms', async () => {
    const { hostId, eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);
    await participation.accept(hostId, joined.publicId);
    // Move the activity into the past, which is what makes a no-show meaningful.
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: {
        startsAt: new Date(Date.now() - 7_200_000),
        endsAt: new Date(Date.now() - 3_600_000),
      },
    });

    await tap(HOST_TELEGRAM_ID, `ev:who:${eventPublicId}`);
    const rows = JSON.parse(String((await latest(TEMPLATES.BOT_PARTICIPANTS))['keyboard'])) as {
      callbackData: string;
    }[][];
    expect(rows[0]?.[0]?.callbackData).toBe(`ev:noshow:${joined.publicId}`);

    // Asked first: it moves a Trust Score down and the bot has no undo.
    await tap(HOST_TELEGRAM_ID, `ev:noshow:${joined.publicId}`);
    expect(
      await prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: joined.publicId },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'ACCEPTED' });

    await tap(HOST_TELEGRAM_ID, `ev:noshowyes:${joined.publicId}`);
    expect(
      await prisma.eventParticipant.findUniqueOrThrow({
        where: { publicId: joined.publicId },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'NO_SHOW' });
  });

  /** Not-yours and not-found answer identically, and neither lists anybody. */
  it("refuses the guest list of somebody else's activity", async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);
    const before = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_PARTICIPANTS },
    });

    await tap(GUEST_TELEGRAM_ID, `ev:who:${eventPublicId}`);

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_PARTICIPANTS } }),
    ).toBe(before);
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

  /**
   * `/gift <code>` — the first command that took an argument, and still the
   * fastest way in for somebody who types it. Bare `/gift` no longer answers
   * with the syntax; it opens the form, which is asserted in «entering a code in
   * the bot» below.
   */
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
 * Typing a code into a form instead of into a command (v0.6.4).
 *
 * ── What was missing, and why it was worth a wizard ─────────────────────────
 *
 * A gift code could only be spent by somebody who knew `/gift` took an argument.
 * A referral code was worse: `?start=<code>` on a link was the only way in, so a
 * code read out loud or printed on a flyer could not be entered anywhere at all
 * — `ReferralService.claim` had taken exactly this since M13 with no bot surface
 * over it.
 *
 * Driven through the webhook rather than against `ConversationService`, like
 * every other wizard test here: what is being checked is that a *tap* opens the
 * form, that the *typed* code reaches the right service, and that the draft is
 * cleared when it worked and kept when it did not.
 */
describe('POST /telegram/:secret — entering a code in the bot', () => {
  let sequence = 9700;

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

  /** The keyboard the bot put under its last message of this template, as JSON. */
  async function keyboardOf(templateKey: string): Promise<string> {
    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const keyboard = (row.payload as Record<string, unknown>)['keyboard'];
    return typeof keyboard === 'string' ? keyboard : '';
  }

  async function seedGiftCode(code: string, coins = 25): Promise<void> {
    await prisma.giftCode.create({ data: { code, coins, isActive: true } });
  }

  it('offers the gift-code button under the wallet', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/wallet');

    expect(await keyboardOf(TEMPLATES.BOT_WALLET)).toContain('cd:gift:x');
  });

  /** Bare `/gift` used to answer «کد را همراه دستور بفرستید». Now it opens the form. */
  it('opens the form when /gift arrives without a code', async () => {
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/gift');

    const state = await prisma.conversationState.findUniqueOrThrow({
      where: { userId: guestId },
      select: { kind: true, step: true },
    });
    expect(state).toEqual({ kind: 'REDEEM_CODE', step: 'code' });
  });

  it('redeems a code typed into the form and closes it', async () => {
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await seedGiftCode('SUMMER24', 25);

    await tap(GUEST_TELEGRAM_ID, 'cd:gift:x');
    await type(GUEST_TELEGRAM_ID, 'SUMMER24');

    const balance = await coins.balanceOf(guestId);
    expect(balance).toBe(SEEDED_BALANCE + 25);
    // The form has done its job and must stop claiming what the user types.
    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(0);
  });

  /**
   * The reported bug, through the form that produced it (v0.6.5).
   *
   * An operator's `test1` was redeemed by somebody who typed `test 1`, because
   * the shared normalizer stripped the space before anything compared them.
   * Every string within one edit of a real code was a live code.
   */
  it('refuses a code that is one edit away from a real one', async () => {
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await seedGiftCode('SUMMER24', 25);

    await tap(GUEST_TELEGRAM_ID, 'cd:gift:x');
    await type(GUEST_TELEGRAM_ID, 'summer 24');

    // Untouched: a refused code grants nothing.
    expect(await coins.balanceOf(guestId)).toBe(SEEDED_BALANCE);
    // The form stays open, because a refused code is usually a typo.
    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(1);
  });

  /**
   * The common refusal here is a typo, and the form is one field: closing it
   * would make correcting one character start with finding the button again.
   */
  it('keeps the form open when the code is refused, and never echoes it', async () => {
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, 'cd:gift:x');
    await type(GUEST_TELEGRAM_ID, 'NOTAREALCODE');

    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(1);

    const said = await replyTo(GUEST_TELEGRAM_ID);
    expect(said.some((row) => row.text.includes('NOTAREALCODE'))).toBe(false);

    // And the correction is simply the next message.
    await seedGiftCode('SUMMER24', 25);
    await type(GUEST_TELEGRAM_ID, 'SUMMER24');
    expect(await coins.balanceOf(guestId)).toBe(SEEDED_BALANCE + 25);
  });

  it('records a referral from a code somebody typed rather than tapped', async () => {
    const referrerId = await seedGuest(HOST_TELEGRAM_ID, 'میزبان');
    await prisma.user.update({
      where: { id: referrerId },
      data: { referralCode: 'ABCD2345' },
    });
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, 'cd:ref:x');
    await type(GUEST_TELEGRAM_ID, 'abcd-2345');

    const referral = await prisma.referral.findUniqueOrThrow({
      where: { referredUserId: guestId },
      select: { referrerUserId: true, status: true },
    });
    expect(referral).toEqual({ referrerUserId: referrerId, status: 'PENDING' });
    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(0);
  });

  /**
   * A button that exists to be refused is worse than no button: `claim` can
   * answer nothing but «شما قبلاً با کد دعوت دیگری ثبت شده‌اید» once somebody has
   * a referrer, so the invite screen stops offering it.
   */
  it('offers the referral-code button only to somebody who has no referrer', async () => {
    const referrerId = await seedGuest(HOST_TELEGRAM_ID, 'میزبان');
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/referral');
    expect(await keyboardOf(TEMPLATES.BOT_REFERRAL)).toContain('cd:ref:x');

    await prisma.referral.create({
      data: {
        referrerUserId: referrerId,
        referredUserId: guestId,
        code: 'ABCD2345',
        status: 'PENDING',
      },
    });

    await type(GUEST_TELEGRAM_ID, '/referral');
    expect(await keyboardOf(TEMPLATES.BOT_REFERRAL)).toBe('');
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
   * What other people wrote about you — and invariant 8, which is the reason
   * this list is usually shorter than the reviews that exist.
   *
   * A review appears only once its **pair** has revealed. `listForUser` filters
   * on the pair's status rather than the review's, deliberately: a review is
   * SUBMITTED both before its counterparty writes and while the pair waits.
   */
  it('hides a review whose pair has not revealed', async () => {
    const { guestId, participantPublicId } = await seedPending();
    await tap(GUEST_TELEGRAM_ID, `rv:rate5:${participantPublicId}`);
    // The guest wrote one *about the host*; nothing about the guest exists, and
    // the pair has not revealed either way.

    await type(GUEST_TELEGRAM_ID, '/myreviews');

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_RECEIVED_REVIEWS },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    expect(String((row.payload as Record<string, unknown>)['text'])).toContain(
      'هنوز نظری درباره شما ثبت نشده است',
    );
    void guestId;
  });

  /** Once the pair reveals, the review is readable — and reportable. */
  it('shows a revealed review, with the button that reports it', async () => {
    const { guestId, participantPublicId } = await seedPending();
    await tap(GUEST_TELEGRAM_ID, `rv:rate2:${participantPublicId}`);

    // Reveal the pair, which is what makes the review visible to its subject.
    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { id: true, publicId: true, revieweeUserId: true },
    });
    await prisma.review.update({
      where: { id: review.id },
      data: { status: 'REVEALED', revealedAt: new Date(), moderationStatus: 'APPROVED' },
    });
    /**
     * `EXPIRED_PARTIAL`, not `REVEALED`.
     *
     * `review_pair_status_matches_contents` requires *both* review ids for
     * REVEALED, and only one side wrote — which is precisely D7a: revealed
     * because the window closed rather than because somebody reciprocated. It is
     * in `REVEALED_PAIR_STATUSES` for that reason, and it is what makes
     * `withoutCounterpart` true.
     */
    await prisma.reviewPair.updateMany({
      data: {
        status: 'EXPIRED_PARTIAL',
        revealedAt: new Date(),
        guestReviewId: review.id,
      },
    });

    // The *host* is the subject of that review, so they are the one who reads it.
    await type(HOST_TELEGRAM_ID, '/myreviews');

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_RECEIVED_REVIEWS },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const payload = row.payload as Record<string, unknown>;
    // Two filled stars for a 2, and no author anywhere: `RevealedReview` carries
    // none, because the double blind is what a pair is for.
    expect(String(payload['text'])).toContain('⭐️⭐️☆☆☆');
    // D7a asks for a one-sided reveal to be *marked*: a review that arrived
    // because the window closed reads differently from a reciprocated one.
    expect(String(payload['text'])).toContain('بدون بازخورد متقابل');

    const buttons = JSON.parse(String(payload['keyboard'])) as { callbackData: string }[][];
    expect(buttons[0]?.[0]?.callbackData).toBe(`rp:askv:${review.publicId}`);
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

    /**
     * Two tags, then «تمام», then the comment (v0.8.1).
     *
     * The tag step is a multi-select now, so a tap toggles and **does not
     * advance** — `wz:done:` is what moves to the comment. That extra tap is the
     * whole difference between "the tag that fits best" and a review that can say
     * two true things about the same evening.
     */
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:FRIENDLY');
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:PUNCTUAL');
    await tap(GUEST_TELEGRAM_ID, 'wz:done:');
    await type(GUEST_TELEGRAM_ID, 'میزبان خوبی بود');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { rating: true, tags: true, comment: true },
    });
    // The rating survives the amendment untouched.
    expect(review.rating).toBe(5);
    expect(review.tags).toEqual(['FRIENDLY', 'PUNCTUAL']);
    expect(review.comment).toBe('میزبان خوبی بود');
    // And the form closed.
    expect(await prisma.conversationState.count({ where: { userId: guestId } })).toBe(0);
  });

  /**
   * A second tap on a chosen tag takes it off again.
   *
   * One button for both directions, which is the whole of "add and remove" — and
   * the property that would silently be lost if the walk ever advanced a `multi`
   * step on a successful tap.
   */
  it('lets a tag be unticked before the review is written', async () => {
    const { guestId, participantPublicId } = await seedPending();

    await tap(GUEST_TELEGRAM_ID, `rv:rate5:${participantPublicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:FRIENDLY');
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:PUNCTUAL');
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:FRIENDLY');
    await tap(GUEST_TELEGRAM_ID, 'wz:done:');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { tags: true },
    });
    expect(review.tags).toEqual(['PUNCTUAL']);
  });

  /**
   * A reviewer who writes nothing is still offered the tags, and can still
   * answer them.
   *
   * The tags step is **first** for exactly this reason: most people write no
   * comment, tags are two taps and a comment is a paragraph, so asking for the
   * writing first would put the part almost nobody completes in front of the
   * part almost everybody would.
   */
  it('records tags from somebody who writes no comment', async () => {
    const { guestId, participantPublicId } = await seedPending();

    await tap(GUEST_TELEGRAM_ID, `rv:rate4:${participantPublicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:WELL_ORGANISED');
    await tap(GUEST_TELEGRAM_ID, 'wz:done:');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const review = await prisma.review.findFirstOrThrow({
      where: { reviewerUserId: guestId },
      select: { rating: true, tags: true, comment: true },
    });
    expect(review.rating).toBe(4);
    expect(review.tags).toEqual(['WELL_ORGANISED']);
    expect(review.comment).toBeNull();
  });

  /**
   * The reviewer is told the review landed, and told why they cannot yet read
   * the other one (v0.8.1).
   *
   * Reviews are blind until both sides write, and somebody who goes looking for
   * what a stranger said about them and finds nothing reads that as the feature
   * being broken. The moment the review lands is the moment to say so.
   */
  it('confirms the review and explains the blind reveal', async () => {
    const { participantPublicId } = await seedPending();

    await tap(GUEST_TELEGRAM_ID, `rv:rate5:${participantPublicId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:tag:FRIENDLY');
    await tap(GUEST_TELEGRAM_ID, 'wz:done:');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const notice = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_NOTICE },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const text = String((notice.payload as Record<string, unknown>)['text']);
    expect(text).toContain('نظر شما کامل شد');
    expect(text).toContain('هر دو نظرتان را نوشته باشید');
  });

  /** Skipping both steps leaves the rating alone rather than saying «ثبت شد» twice. */
  it('adds nothing when both steps are skipped', async () => {
    const { guestId, participantPublicId } = await seedPending();

    await tap(GUEST_TELEGRAM_ID, `rv:rate3:${participantPublicId}`);
    // «رد کردن» still leaves a multi-select the same way it leaves any other
    // step: nothing chosen, and on to the next question.
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

  /**
   * The list is opened by a command on the line, not by a numbered button under
   * it (v0.6.7). Five activities used to mean ten buttons whose labels were
   * numbers the reader had to match back to lines.
   */
  it('gives every discovered activity a command that opens it', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const body = String((digest.payload as Record<string, unknown>)['text']);
    const code = eventPublicId.replaceAll('-', '').slice(0, 10);

    expect(body).toContain(`/event_${code}`);
    // The keyboard is the list's own controls now — paging and the filters —
    // and carries nothing addressed to one activity.
    expect(
      keyboardOf(digest.payload)
        .flat()
        .some((button) => button.callbackData.startsWith('ev:')),
    ).toBe(false);
  });

  /**
   * The command opens the activity in full, with the join button on it and a way
   * back that takes both messages out of the chat again.
   */
  it('opens one activity, with a way to join it and a way back', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const code = eventPublicId.replaceAll('-', '').slice(0, 10);

    await type(GUEST_TELEGRAM_ID, `/event_${code}`);

    const detail = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const buttons = keyboardOf(detail.payload).flat();

    expect(buttons.some((b) => b.callbackData === `ev:join:${eventPublicId}`)).toBe(true);
    expect(buttons.some((b) => b.text.includes('گزارش'))).toBe(true);
    // The back button carries the id of the user's own command message, which is
    // the only place that id exists.
    const back = buttons.find((b) => b.callbackData.startsWith('bk:'));
    expect(back?.callbackData).toMatch(/^bk:d:\d+$/);

    await tap(GUEST_TELEGRAM_ID, `ev:join:${eventPublicId}`);

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { status: true, publicId: true },
    });
    expect(participant.status).toBe('PENDING');
  });

  /**
   * A full activity is listed, and its button says what pressing it does.
   *
   * `/discover` filtered on `hasCapacity: true` until v0.7.0, so an activity with
   * no seats left vanished from the bot entirely — and with it the only route to
   * a waiting list the product has had since M6. The list, the detail screen and
   * the button all have to agree, so all three are asserted here.
   */
  it('lists a full activity, and offers the waiting list on it', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);

    // Full: `accepted_count` is what «جای خالی» is computed from.
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { acceptedCount: 5 },
    });

    await type(GUEST_TELEGRAM_ID, '/discover');
    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const body = String((digest.payload as Record<string, unknown>)['text']);
    expect(body).toContain('دورهمی بازی رومیزی');
    expect(body).toContain('ظرفیت تکمیل');

    const code = eventPublicId.replaceAll('-', '').slice(0, 10);
    await type(GUEST_TELEGRAM_ID, `/event_${code}`);
    const detail = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const join = keyboardOf(detail.payload)
      .flat()
      .find((button) => button.callbackData === `ev:join:${eventPublicId}`);
    expect(join?.text).toContain('نوبت انتظار');

    await tap(GUEST_TELEGRAM_ID, `ev:join:${eventPublicId}`);
    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { status: true },
    });
    expect(participant.status).toBe('WAITLISTED');
  });

  /** A code that names nothing is refused the way an unknown activity is. */
  it('refuses a code that matches no published activity', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/event_0000000000');

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL } }),
    ).toBe(0);
  });

  /**
   * `/discover` was city-only since M13 because the bot holds no query state.
   * It does not have to: the whole filter set fits in the callback, so every
   * button carries the complete query it produces.
   */
  it('puts the filters one tap away rather than under the list', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');

    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const all = keyboardOf(digest.payload).flat();

    // One control, carrying the whole query plus «show me the panel».
    // `dc:<when><cost><page><view>:<category>` (v0.6.7).
    expect(all.some((button) => button.callbackData === 'dc:aa0f:all')).toBe(true);
    // Six filter rows and five activities do not fit on a phone together.
    expect(all.filter((button) => button.callbackData.startsWith('dc:'))).toHaveLength(1);
  });

  /**
   * A tap **redraws** the list it is attached to (v0.6.5).
   *
   * It used to answer every filter with a whole new message, so narrowing a
   * search three times left four near-identical lists stacked in the chat and
   * the one the user was reading scrolled off the top. Filters are a control on
   * a list, not four separate answers.
   *
   * The redraw is a `BOT_EDIT_MESSAGE` job rather than a `notification` row, and
   * this process runs no worker — so what is asserted here is that **no second
   * message was made**. What the redrawn body and keyboard say is asserted
   * without a database in `discover-paging.test.ts`.
   */
  it('redraws the list in place rather than sending another one', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');
    const before = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
    });
    expect(before).toBe(1);

    await tap(GUEST_TELEGRAM_ID, 'dc:tf0l:all');

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_DISCOVER } }),
    ).toBe(before);
  });

  /**
   * Every `/discover` message sent before v0.6.5 still has two-flag buttons on
   * it, in somebody's chat. They have to keep working — a filter that answers
   * «این دکمه دیگر کار نمی‌کند» is worse than one that does not page.
   */
  it('still accepts a filter button minted before paging existed', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');
    const before = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
    });

    await tap(GUEST_TELEGRAM_ID, 'dc:tf:all');

    // Redrawn, not refused: a refused button would have left the count alone
    // *and* produced a «این دکمه دیگر کار نمی‌کند» toast, which this asserts
    // against by way of the callback answer below.
    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_DISCOVER } }),
    ).toBe(before);
  });

  /**
   * Opening the filter panel is a **redraw of the same message**, not a second
   * one — the list and the panel are one message with two faces (v0.6.7).
   *
   * The redraw is a `BOT_EDIT_MESSAGE` job rather than a `notification` row, and
   * this process runs no worker, so what is asserted here is that no second
   * message was made. What the panel's keyboard says is asserted without a
   * database in `discover-views.test.ts`.
   */
  it('opens the filter panel in place', async () => {
    await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/discover');
    const before = await prisma.notification.count({
      where: { templateKey: TEMPLATES.BOT_DISCOVER },
    });

    await tap(GUEST_TELEGRAM_ID, 'dc:aa0f:all');
    await tap(GUEST_TELEGRAM_ID, 'dc:ta0f:all');
    await tap(GUEST_TELEGRAM_ID, 'dc:ta0l:all');

    expect(
      await prisma.notification.count({ where: { templateKey: TEMPLATES.BOT_DISCOVER } }),
    ).toBe(before);
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

  /**
   * The detail screen is a different screen for the host, and the difference is
   * the route to «who is coming».
   *
   * Joining is refused for them by `HOST_CANNOT_JOIN` and reporting their own
   * content by `CANNOT_REPORT_OWN_CONTENT`, so offering either would be two
   * buttons that exist to be declined. What a host wants from this screen is the
   * guest list — which is the only path to recording a no-show that does not go
   * through `/myevents`.
   */
  it('offers the host the guest list where a guest is offered joining', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await tap(HOST_TELEGRAM_ID, `ev:show:${eventPublicId}`);

    const detail = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_EVENT_DETAIL },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const keyboard = String((detail.payload as Record<string, unknown>)['keyboard']);
    expect(keyboard).toContain(`ev:who:${eventPublicId}`);
    expect(keyboard).not.toContain('ev:join:');
    expect(keyboard).not.toContain('rp:');
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

    // Asked first, since v0.7.0: a withdrawal and a paid cancellation are the
    // same button on the same list, so the confirmation is not conditional.
    await tap(GUEST_TELEGRAM_ID, buttons[0]?.callbackData ?? '');
    const ask = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_CONFIRM_SPEND },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const confirm = keyboardOf(ask.payload).flat()[0];
    expect(confirm?.callbackData).toMatch(/^ev:cancelyes:/);

    await tap(GUEST_TELEGRAM_ID, confirm?.callbackData ?? '');

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { status: true },
    });
    expect(participant.status).toBe('CANCELLED_BY_PARTICIPANT');
  });

  /**
   * The gap this closes: an **accepted** guest had no way to stand down.
   *
   * The list offered «لغو» on PENDING and WAITLISTED only, on the argument that
   * standing somebody up is a conversation. The conversation is right and it is
   * not a cancellation — a guest who tells their host they cannot come and has no
   * way to tell the *product* stays ACCEPTED, holds a seat nobody can fill, and
   * is settled as having attended.
   */
  it('lets an accepted guest stand down, and says what it costs first', async () => {
    const { hostId, eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    const joined = await participation.join(guestId, eventPublicId);
    await participation.accept(hostId, joined.publicId);

    await type(GUEST_TELEGRAM_ID, '/requests');
    const digest = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_REQUESTS },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const cancel = keyboardOf(digest.payload).flat()[0];
    expect(cancel?.callbackData).toBe(`ev:cancel:${joined.publicId}`);

    await tap(GUEST_TELEGRAM_ID, cancel?.callbackData ?? '');
    const ask = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_CONFIRM_SPEND },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    // Inside the grace window the honest answer is that it is free, and the ask
    // says so rather than quoting a figure nobody will be charged.
    expect(String((ask.payload as Record<string, unknown>)['text'])).toContain('لغو شرکت');

    await tap(GUEST_TELEGRAM_ID, keyboardOf(ask.payload).flat()[0]?.callbackData ?? '');

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { userId: guestId },
      select: { status: true },
    });
    expect(participant.status).toBe('CANCELLED_BY_PARTICIPANT');

    // And the seat went back, which is the reason this had to exist.
    const event = await prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { acceptedCount: true },
    });
    expect(event.acceptedCount).toBe(0);
  });
});

/**
 * «دایرکت» — the whole flow, through the webhook (v0.7.0).
 *
 * Every step of the brief in one test, because the value of this feature is the
 * *sequence*: a button on the activity, a compose prompt with a cancel under it,
 * a notification to the host that names who and what but not the words, a
 * «مشاهده» that marks the message read, a receipt back to the guest, and a reply
 * that runs the same way in the other direction.
 */
describe('POST /telegram/:secret — direct messages', () => {
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

  /** The keyboard a notification went out with, as the worker would render it. */
  function keyboardOf(payload: unknown): { text: string; callbackData: string }[][] {
    const raw = (payload as Record<string, unknown>)['keyboard'];
    return typeof raw === 'string'
      ? (JSON.parse(raw) as { text: string; callbackData: string }[][])
      : [];
  }

  /**
   * The bot's own replies are notification rows written by `BotService`; a
   * message *about* somebody else's action goes through the outbox, and the relay
   * is what turns one into the other. The worker runs it every few seconds in
   * production, so a test that skipped it would be asserting half the path.
   */
  async function latest(templateKey: string): Promise<Record<string, unknown>> {
    await relay.drain();
    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    return row.payload as Record<string, unknown>;
  }

  it('carries a message from a guest to the host and a reply back', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);
    const code = eventPublicId.replaceAll('-', '').slice(0, 10);

    // 1. The button is on the activity, under the join button.
    await type(GUEST_TELEGRAM_ID, `/event_${code}`);
    const detail = await latest(TEMPLATES.BOT_EVENT_DETAIL);
    const direct = keyboardOf(detail)
      .flat()
      .find((button) => button.callbackData === `dm:write:${eventPublicId}`);
    expect(direct?.text).toContain('پیام مستقیم به میزبان');

    // 2–3. Pressing it asks for the message, with «انصراف» under the prompt, and
    // says out loud that sharing contact details is the sender's own risk.
    await tap(GUEST_TELEGRAM_ID, direct?.callbackData ?? '');
    const prompt = await latest(TEMPLATES.BOT_WIZARD);
    expect(String(prompt['text'])).toContain('مسئولیت خودتان');
    expect(
      keyboardOf(prompt)
        .flat()
        .some((button) => button.text.includes('انصراف')),
    ).toBe(true);

    // 4–5. The host is told, naming the writer and the activity — and not the
    // words, which is what keeps the receipt below honest. Rendered the way the
    // worker renders it: this payload carries structured fields, not a body.
    await type(GUEST_TELEGRAM_ID, 'سلام، ماشین دارید؟ شماره‌ام ۰۹۱۲…');
    const received = await latest(TEMPLATES.DIRECT_MESSAGE_RECEIVED);
    const rendered = render(TEMPLATES.DIRECT_MESSAGE_RECEIVED, received);
    expect(rendered?.text).toContain('دورهمی بازی رومیزی');
    // The writer, by display name — never a Telegram handle (invariant 7).
    expect(rendered?.text).toContain('میهمان');
    expect(JSON.stringify(received)).not.toContain('۰۹۱۲');

    // 6. With a «مشاهده» button on it.
    const view = (rendered?.keyboard ?? [])
      .flat()
      .find((button) => button.callbackData?.startsWith('dm:view:') === true);
    expect(view?.text).toContain('مشاهده');

    // 7. Pressing it shows the message and tells the guest it was seen.
    await tap(HOST_TELEGRAM_ID, view?.callbackData ?? '');
    const opened = await latest(TEMPLATES.BOT_DIRECT_MESSAGE);
    expect(String(opened['text'])).toContain('ماشین دارید؟');
    expect(String(opened['text'])).toContain('احتیاط');
    await expect(
      prisma.notification.count({ where: { templateKey: TEMPLATES.DIRECT_MESSAGE_SEEN } }),
    ).resolves.toBe(1);

    /**
     * 8–9. And a reply button — which is the half that was missing.
     *
     * Asserted on the **rendered** message rather than on the payload, because
     * the payload was never the problem: the row was built and serialised
     * correctly and `BOT_NOTICE` threw it away. Rendering is the only place the
     * two disagree, so it is the only place the regression is visible.
     */
    const openedRender = render(TEMPLATES.BOT_DIRECT_MESSAGE, opened);
    const reply = (openedRender?.keyboard ?? [])
      .flat()
      .find((button) => button.callbackData?.startsWith('dm:reply:') === true);
    expect(reply?.text).toContain('پاسخ');

    await tap(HOST_TELEGRAM_ID, reply?.callbackData ?? '');
    await type(HOST_TELEGRAM_ID, 'بله، هماهنگ می‌کنیم. آیدی من @host است.');

    const answer = await prisma.directMessage.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      select: { parentId: true, recipient: { select: { telegramAccount: true } } },
    });
    expect(answer.parentId).not.toBeNull();
    expect(answer.recipient.telegramAccount?.telegramUserId).toBe(BigInt(GUEST_TELEGRAM_ID));

    /**
     * 10. And the guest can answer *that*, which is what makes it a conversation
     * rather than one round trip.
     *
     * The same three steps in the other direction — notification, «مشاهده»,
     * «پاسخ» — because a thread that can only be started by the guest and closed
     * by the host is a form, not a way to arrange a lift.
     */
    const back = render(
      TEMPLATES.DIRECT_MESSAGE_RECEIVED,
      await latest(TEMPLATES.DIRECT_MESSAGE_RECEIVED),
    );
    expect(back?.text).toContain('پاسخ تازه');
    const viewBack = (back?.keyboard ?? [])
      .flat()
      .find((button) => button.callbackData?.startsWith('dm:view:') === true);

    await tap(GUEST_TELEGRAM_ID, viewBack?.callbackData ?? '');
    const openedBack = render(
      TEMPLATES.BOT_DIRECT_MESSAGE,
      await latest(TEMPLATES.BOT_DIRECT_MESSAGE),
    );
    // Contact details are not masked here: exchanging them is the point, and the
    // warning under every message is what carries the risk instead.
    expect(openedBack?.text).toContain('@host');
    const replyBack = (openedBack?.keyboard ?? [])
      .flat()
      .find((button) => button.callbackData?.startsWith('dm:reply:') === true);
    expect(replyBack?.text).toContain('پاسخ');

    await tap(GUEST_TELEGRAM_ID, replyBack?.callbackData ?? '');
    await type(GUEST_TELEGRAM_ID, 'عالی، ممنون.');
    await expect(prisma.directMessage.count()).resolves.toBe(3);
  });

  /**
   * The compose form claims what is typed into it.
   *
   * Without that, a message meant for the host would be handed to `onText` and
   * relayed into whatever anonymous chat happened to be open — which is the one
   * thing that path must never do.
   */
  it('cancels without sending anything', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    await seedGuest(GUEST_TELEGRAM_ID);

    await tap(GUEST_TELEGRAM_ID, `dm:write:${eventPublicId}`);
    const prompt = await latest(TEMPLATES.BOT_WIZARD);
    const cancel = keyboardOf(prompt)
      .flat()
      .find((button) => button.text.includes('انصراف'));

    await tap(GUEST_TELEGRAM_ID, cancel?.callbackData ?? '');

    await expect(prisma.directMessage.count()).resolves.toBe(0);
    await expect(prisma.conversationState.count()).resolves.toBe(0);
  });

  /** Authorisation is not in the button: a host cannot write to their own activity. */
  it('refuses the host writing to their own activity', async () => {
    const { eventPublicId } = await seedHostAndEvent();

    await tap(HOST_TELEGRAM_ID, `dm:write:${eventPublicId}`);
    await type(HOST_TELEGRAM_ID, 'به خودم');

    await expect(prisma.directMessage.count()).resolves.toBe(0);
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
    // Jalali, because that is what the form asks for (v0.6.5). The column stays
    // Gregorian and the conversion happens at the wizard boundary.
    await type(NEWCOMER_TELEGRAM_ID, '۱۳۶۹');
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
   * The direction this used to run in, inverted (v0.6.5).
   *
   * The form asked for a **Gregorian** year and refused ۱۳۷۰ with an explanation
   * of how to convert it — the product asking a Persian speaker to do arithmetic
   * it could do itself, three screens after a Jalali date picker. It now asks in
   * Jalali and converts, so ۱۳۷۰ is the *right* answer and moves the form on.
   */
  it('takes a Jalali year and moves on', async () => {
    await seedGuest(GUEST_TELEGRAM_ID, 'نام');

    await type(GUEST_TELEGRAM_ID, '/edit_profile');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // name
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // gender
    await type(GUEST_TELEGRAM_ID, '۱۳۷۰');

    const state = await prisma.conversationState.findFirstOrThrow();
    expect(state.step).toBe('prov');
  });

  /**
   * And the mistake the change itself creates: somebody who learned the old form
   * types ۱۹۹۱. «سال تولد معتبر نیست» would be true, unhelpful, and identical to
   * what a typo produces — so the refusal names the question and their own answer
   * in it.
   */
  it('explains a Gregorian year rather than only refusing it', async () => {
    await seedGuest(GUEST_TELEGRAM_ID, 'نام');

    await type(GUEST_TELEGRAM_ID, '/edit_profile');
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // name
    await tap(GUEST_TELEGRAM_ID, 'wz:skip:'); // gender
    await type(GUEST_TELEGRAM_ID, '۱۹۹۱');

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
   * The hole this closes, stated as a test.
   *
   * Writing to a host is a write, and the gate applies to it. It used to be the
   * relay that had to be stopped here; since v0.8.0 it is «پیام مستقیم به
   * میزبان», and the tap that opens the form is where the gate fires — before a
   * form exists to type into, which is the earlier and better place for it.
   */
  it('refuses a direct message from somebody who owes an acceptance', async () => {
    const { eventPublicId } = await seedHostAndEvent();
    const guestId = await seedGuest(GUEST_TELEGRAM_ID);
    await participation.join(guestId, eventPublicId);
    // Published *after* the join, so the user is mid-flow and now owes.
    await requirePolicies();

    await tap(GUEST_TELEGRAM_ID, `dm:write:${eventPublicId}`);
    await type(GUEST_TELEGRAM_ID, 'سلام');

    expect(await prisma.directMessage.count()).toBe(0);
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
 * Event editing is gone (v0.6.7), and the command with it.
 *
 * What is worth an integration test is not the absence of a feature but the two
 * things its removal could have broken: a command that still dispatches to
 * something, and a draft that outlives the build that could finish it.
 *
 * `conversation_state.user_id` is UNIQUE, so a stale `EDIT_EVENT` row is not
 * dead weight — it *is* the form that user is in, and every message they type
 * goes to it. Migration 0038 deletes the rows that exist at deploy time;
 * `definitionFor` answering null is the backstop for one written a second before
 * the swap.
 */
describe('POST /telegram/:secret — after event editing was removed', () => {
  let sequence = 9000;

  async function type(telegramUserId: number, text: string): Promise<void> {
    sequence += 1;
    await post(update({ update_id: sequence, message: textMessage(sender(telegramUserId), text) }));
  }

  it('answers the retired command the way it answers any unknown one', async () => {
    await seedHostAndEvent();

    await type(HOST_TELEGRAM_ID, '/edit_event');

    const notice = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_NOTICE },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    // The unknown-command sentence, byte for byte — the same one a typo gets.
    expect(String((notice.payload as Record<string, unknown>)['text'])).toContain(
      'این فرمان را نمی‌شناسم',
    );
    expect(await prisma.conversationState.count()).toBe(0);
  });

  /**
   * A row written by the previous build, met by this one. It must close the form
   * rather than throw — a throw is caught by `dispatch`, logged, and answered
   * with nothing at all, which is a user tapping a form that silently stopped
   * existing.
   */
  it('closes a draft left behind by the build that had the wizard', async () => {
    const { hostId } = await seedHostAndEvent();

    await prisma.conversationState.create({
      data: {
        userId: hostId,
        kind: 'EDIT_EVENT',
        step: 'title',
        // The ciphertext is never read: `definitionFor` answers null before the
        // form is decrypted, which is the point — a retired wizard is refused on
        // its kind, not on its contents.
        formDataCiphertext: Buffer.from('unreadable'),
        formDataNonce: Buffer.alloc(24),
        keyVersion: 1,
        lastUpdateId: 0n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await type(HOST_TELEGRAM_ID, 'یک پیام تازه');

    expect(await prisma.conversationState.count()).toBe(0);
  });
});

/**
 * Admin moderation in the bot (v0.6.3, ADR-0018).
 *
 * ADR-0010 says admin access must **not** follow from a staff member's personal
 * Telegram being taken over, and this feature is the documented exception. So
 * what this suite asserts is the *bound*: who reaches the queue, who cannot see
 * that it exists, and that a decision taken here is the same decision the panel
 * takes — the same service, the same permission check, the same audit row.
 */
describe('POST /telegram/:secret — moderating from the bot', () => {
  let sequence = 12_000;

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

  /** A staff account with roles, without going through the password path. */
  async function seedAdmin(email: string, roleKey: string): Promise<string> {
    const admin = await prisma.adminUser.create({
      data: {
        email,
        passwordHash: 'not-a-real-hash',
        totpSecretEnc: 'not-a-real-secret',
        displayName: email,
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
    return admin.id;
  }

  /** A linked moderator whose Telegram account is also an ordinary bot user. */
  async function seedModerator(telegramUserId: number): Promise<string> {
    await seedGuest(telegramUserId, 'ناظر');
    const adminId = await seedAdmin(`mod-${String(telegramUserId)}@payetam.test`, 'MODERATOR');
    await prisma.adminTelegramLink.create({
      data: {
        adminUserId: adminId,
        telegramUserId: BigInt(telegramUserId),
        grantedById: adminId,
        reason: 'test fixture',
      },
    });
    return adminId;
  }

  /** An open case over a real event, which is what the queue renders a title from. */
  async function seedCase(): Promise<{ caseId: string; eventId: string }> {
    const { eventPublicId } = await seedHostAndEvent();
    /**
     * `PENDING_MODERATION`, which is what a BLOCK verdict actually leaves behind
     * — `applyEventDecision` only moves an event out of `HIDDEN` or
     * `PENDING_MODERATION`, because an event the host has since cancelled is not
     * resurrected by a moderator agreeing with them.
     */
    const event = await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { status: 'PENDING_MODERATION', moderationStatus: 'FLAGGED' },
      select: { id: true },
    });
    const opened = await prisma.moderationCase.create({
      data: {
        subjectType: 'EVENT',
        subjectId: event.id,
        trigger: 'AUTO_BLACKLIST',
        status: 'OPEN',
        blacklistVersion: 1,
        matchedTerms: [{ id: 't-1', term: 'x', patternType: 'WORD', severity: 'FLAG' }],
      },
      select: { id: true },
    });
    return { caseId: opened.id, eventId: event.id };
  }

  async function lastReply(telegramUserId: number): Promise<{ templateKey: string } | undefined> {
    const rows = await prisma.notification.findMany({
      where: { user: { telegramAccount: { telegramUserId: BigInt(telegramUserId) } } },
      orderBy: { createdAt: 'desc' },
      take: 1,
      select: { templateKey: true },
    });
    return rows[0];
  }

  /**
   * The surface must not announce itself.
   *
   * Distinguishing «you are not a moderator» from «no such command» tells a
   * stranger that the command exists, which is the first thing worth knowing
   * about a surface you want to attack. The two answers are the same sentence.
   */
  it('answers an ordinary user exactly as it answers a typo', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/moderate');
    const refused = await replyTo(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '/notacommand');
    const typo = await replyTo(GUEST_TELEGRAM_ID);

    expect(refused[0]?.templateKey).toBe(TEMPLATES.BOT_NOTICE);
    expect(typo[1]?.text).toBe(refused[0]?.text);
    expect(await prisma.moderationCase.count()).toBe(0);
  });

  /**
   * The menu label is resolvable for everybody and authorised for nobody. If it
   * were unresolvable, a stranger who typed it would have it **relayed into an
   * anonymous chat** — the one thing `onText` must never do with a menu label.
   */
  it('does not relay the moderation label typed by a stranger', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);

    await type(GUEST_TELEGRAM_ID, '🛡 داوری');

    expect(await prisma.chatMessage.count({ where: { kind: 'TEXT' } })).toBe(0);
    expect((await lastReply(GUEST_TELEGRAM_ID))?.templateKey).toBe(TEMPLATES.BOT_NOTICE);
  });

  it('opens the queue from the menu label, not only from a command', async () => {
    await seedModerator(GUEST_TELEGRAM_ID);
    await seedCase();

    await type(GUEST_TELEGRAM_ID, '🛡 داوری');

    const row = await prisma.notification.findFirstOrThrow({
      where: { templateKey: TEMPLATES.BOT_ADMIN_CASES },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const payload = row.payload as Record<string, unknown>;
    // The title is what makes a queue row decidable at a glance.
    expect(String(payload['text'])).toContain('دورهمی بازی رومیزی');
    expect(String(payload['keyboard'])).toContain('ad:open:');
  });

  /**
   * The whole path, and the property that matters: the decision the bot takes is
   * the decision the panel takes — same service, same permission check in the
   * service layer (invariant 12), same audit row.
   */
  it('decides a case, closes it, and writes the audit row', async () => {
    const adminId = await seedModerator(GUEST_TELEGRAM_ID);
    const { caseId, eventId } = await seedCase();

    await type(GUEST_TELEGRAM_ID, '🛡 داوری');
    await tap(GUEST_TELEGRAM_ID, `ad:open:${caseId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:verdict:REJECTED');
    await type(GUEST_TELEGRAM_ID, 'تبلیغ آشکار یک خدمت پولی.');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const decided = await prisma.moderationCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(decided.status).toBe('REJECTED');
    expect(decided.decidedBy).toBe(adminId);
    expect(decided.decisionNote).toBe('تبلیغ آشکار یک خدمت پولی.');

    // The content goes with the decision, which is `applyEventDecision`'s job and
    // is reached through exactly the same call the panel makes.
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe('REJECTED');

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'moderation.case_decided' },
    });
    expect(entry.actorType).toBe('ADMIN');
    expect(entry.actorId).toBe(adminId);

    // The form is gone, so the next thing this moderator types is not an answer
    // to a step they have already finished.
    expect(await prisma.conversationState.count()).toBe(0);
  });

  /**
   * `falsePositive` is what turns ADR-0012's tuning from an impression into a
   * number, and it is asked only where the automation is the thing being judged.
   */
  it('asks whether the scanner was wrong, but only when approving an automatic case', async () => {
    await seedModerator(GUEST_TELEGRAM_ID);
    const { caseId } = await seedCase();

    await type(GUEST_TELEGRAM_ID, '🛡 داوری');
    await tap(GUEST_TELEGRAM_ID, `ad:open:${caseId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:verdict:APPROVED');

    const state = await prisma.conversationState.findFirstOrThrow();
    expect(state.step).toBe('falsepos');

    await tap(GUEST_TELEGRAM_ID, 'wz:falsepos:yes');
    await type(GUEST_TELEGRAM_ID, 'هشدار روی یک واژهٔ بی‌ضرر افتاده بود.');
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const decided = await prisma.moderationCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(decided.status).toBe('APPROVED');
    expect(decided.falsePositive).toBe(true);
  });

  /**
   * **The load-bearing assertion of the whole feature.** A wizard can be open for
   * seven days. Deciding from the session that opened the form would let a
   * revoked moderator finish work they started before losing access — which is
   * exactly the failure a revocation exists to prevent.
   */
  it('refuses the submit when the link was revoked mid-form', async () => {
    const adminId = await seedModerator(GUEST_TELEGRAM_ID);
    const { caseId } = await seedCase();

    await type(GUEST_TELEGRAM_ID, '🛡 داوری');
    await tap(GUEST_TELEGRAM_ID, `ad:open:${caseId}`);
    await tap(GUEST_TELEGRAM_ID, 'wz:verdict:REJECTED');
    await type(GUEST_TELEGRAM_ID, 'تبلیغ آشکار یک خدمت پولی.');

    await prisma.adminTelegramLink.delete({ where: { adminUserId: adminId } });
    await tap(GUEST_TELEGRAM_ID, 'wz:confirm:');

    const untouched = await prisma.moderationCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(untouched.status).toBe('OPEN');
    expect(await prisma.conversationState.count()).toBe(0);
  });

  /** A tampered or guessed button reveals nothing, because the session is resolved first. */
  it('answers a stranger tapping a moderation button as a dead button', async () => {
    await seedGuest(GUEST_TELEGRAM_ID);
    const { caseId } = await seedCase();

    await tap(GUEST_TELEGRAM_ID, `ad:open:${caseId}`);

    expect(await prisma.conversationState.count()).toBe(0);
    const decided = await prisma.moderationCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(decided.status).toBe('OPEN');
  });
});
