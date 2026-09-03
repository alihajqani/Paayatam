import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import { ENV } from '@payetam/platform';
import { normalize } from '@payetam/domain';
import {
  TEST_CHAT_ENCRYPTION_KEY,
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../test/integration/db';

/**
 * **B4 — the two-account privacy gate**, automated (M19).
 *
 * Acceptance criterion 4 is *"host and guest exchange ≥5 messages with zero
 * identity leakage, verified against raw Telegram payloads"*, and it has been the
 * one criterion nobody could tick since M8. `launch-readiness.md` called it a
 * manual gate with two real Telegram accounts, and §7's finding is the reason it
 * matters: **the automated layers agreed with each other for four milestones
 * while the feature they protect delivered empty messages.** Agreement between
 * things that share an assumption is not evidence.
 *
 * So this deliberately shares as few assumptions as it can with the rest of the
 * suite:
 *
 *  - **Two accounts are created the way a real one is** — signed `initData`
 *    through `POST /api/v1/auth/telegram`, with real Telegram ids, a real
 *    `@username` and a phone number in a bio. Not fixtures inserted with Prisma.
 *  - **The conversation happens over both surfaces**, because the product has
 *    two: some messages through the Mini App API and some through the **real
 *    webhook with real Telegram update bodies**, including a `text_mention`
 *    entity carrying a raw numeric user id — the exact shape T2.2 exists for.
 *  - **The verification is against raw payloads, not against responses.** Every
 *    API response *and* every `notification.payload`, `outbox_event.payload`,
 *    `chat_message` row and `audit_log` row is swept for four identifiers. The
 *    notification payload is what the worker hands to Telegram, which is as close
 *    to "the raw Telegram payload" as a process that never calls Telegram can
 *    get (ADR-0005).
 *
 * What it still does not cover is one live capture from a real Telegram client,
 * which needs a bot token and two phones. `docs/b4-privacy-gate.md` records the
 * procedure and what is left to do by hand; everything the procedure can assert
 * from this side is asserted here, and re-asserted on every commit.
 */

const SECRET_PATH = 'e5a9d3c2b1f04e678a9c0d1e2f3a4b5c';
const SECRET_TOKEN = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';

process.env['TELEGRAM_WEBHOOK_SECRET_PATH'] = SECRET_PATH;
process.env['TELEGRAM_WEBHOOK_SECRET_TOKEN'] = SECRET_TOKEN;
process.env['TELEGRAM_BOT_TOKEN'] ??= '1234567890:LOCAL-DEV-ONLY-NOT-A-REAL-TOKEN-0001';
process.env['CHAT_ENCRYPTION_KEY'] ??= TEST_CHAT_ENCRYPTION_KEY;
process.env['JWT_ACCESS_SECRET'] ??= 'a'.repeat(48);
process.env['JWT_REFRESH_SECRET'] ??= 'b'.repeat(48);

const prisma: PrismaClient = createTestPrisma();

/**
 * Account A — the host. Carries every identifier the gate hunts for, so a leak
 * has something real to leak.
 */
const A_TELEGRAM_ID = 574_113_902n;
const A_USERNAME = 'privacy_gate_host';
const A_PHONE = '+989121234567';
const A_NAME = 'مریم رضایی';

/** Account B — the guest. A clean, separate account. */
const B_TELEGRAM_ID = 611_884_205n;
const B_USERNAME = 'privacy_gate_guest';
const B_PHONE = '+989127654321';
const B_NAME = 'نگار موسوی';

/** Account C — a stranger, for the authorisation half. */
const C_TELEGRAM_ID = 655_010_101n;

let app: NestFastifyApplication;
let fixture: CatalogFixture;
let botToken: string;

interface Account {
  telegramId: bigint;
  userId: string;
  publicId: string;
  accessToken: string;
}

let hostAccount: Account;
let guestAccount: Account;
let strangerAccount: Account;

let eventPublicId: string;
let secondEventPublicId: string;
let participantPublicId: string;
let chatPublicId: string;

/**
 * Everything either account ever received, concatenated.
 *
 * Collected as the walk runs rather than re-fetched afterwards, because a
 * response that leaked once and was then fixed by a later state change is still
 * a response that leaked.
 */
const responses: string[] = [];

/**
 * How much of `responses` predates the guest's decision to share their number.
 *
 * The split is the difference between a leak and a feature: a phone number in a
 * response *before* consent is the thing ADR-0009 exists to prevent, and one
 * after it is the thing the consent was for.
 */
let anonymousStageEnd = 0;

function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

/** One API call as one of the two accounts, with its body recorded for the sweep. */
async function call(
  account: Account | null,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: string; json: unknown }> {
  const response = await app.inject({
    method,
    url,
    headers: account === null ? {} : { authorization: `Bearer ${account.accessToken}` },
    ...(payload === undefined ? {} : { payload }),
  });
  responses.push(`${method} ${url} → ${response.body}`);
  expect(response.statusCode, `${method} ${url} → ${response.body.slice(0, 300)}`).toBeLessThan(
    500,
  );

  let json: unknown = null;
  try {
    json = JSON.parse(response.body);
  } catch {
    // Empty bodies (204) are normal here.
  }
  return { status: response.statusCode, body: response.body, json };
}

let signInSequence = 0;
let updateSequence = 9000;
let telegramMessageSequence = 700;

/** A real Telegram update body, posted to the real webhook. */
async function webhook(body: Record<string, unknown>): Promise<void> {
  updateSequence += 1;
  const response = await app.inject({
    method: 'POST',
    url: `/telegram/webhook/${SECRET_PATH}`,
    headers: { 'x-telegram-bot-api-secret-token': SECRET_TOKEN },
    payload: { update_id: updateSequence, ...body },
  });
  // §3.1: the handler always answers 200, whatever happened inside.
  expect(response.statusCode).toBe(200);
  responses.push(`WEBHOOK → ${response.body}`);
}

function telegramMessage(
  from: { id: bigint; username?: string },
  text: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  telegramMessageSequence += 1;
  return {
    message: {
      message_id: telegramMessageSequence,
      from: {
        id: Number(from.id),
        first_name: 'Privacy',
        ...(from.username !== undefined ? { username: from.username } : {}),
        language_code: 'fa',
      },
      chat: { id: Number(from.id), type: 'private' },
      text,
      ...extra,
    },
  };
}

/** Sign in the way the Mini App does, and take the account it produces. */
async function signIn(telegramId: bigint, username: string, firstName: string): Promise<Account> {
  signInSequence += 1;
  const initData = signInitData({
    auth_date: String(Math.floor(Date.now() / 1000)),
    // Unique per call. `InitDataReplayGuard` claims each `hash` exactly once
    // (T1.2), so two sign-ins for the same account in the same second would
    // otherwise produce identical blobs and the second would be refused — which
    // is the guard working, and would look like a broken fixture.
    query_id: `AAH${String(telegramId)}-${String(signInSequence)}`,
    user: JSON.stringify({
      id: Number(telegramId),
      first_name: firstName,
      username,
      language_code: 'fa',
      allows_write_to_pm: true,
    }),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/telegram',
    payload: { initData },
  });
  responses.push(`POST /api/v1/auth/telegram → ${response.body}`);
  expect(response.statusCode).toBeLessThan(400);

  const body = JSON.parse(response.body) as {
    accessToken: string;
    user: { publicId: string };
  };
  const row = await prisma.user.findFirstOrThrow({
    where: { publicId: body.user.publicId },
    select: { id: true },
  });

  return {
    telegramId,
    userId: row.id,
    publicId: body.user.publicId,
    accessToken: body.accessToken,
  };
}

beforeAll(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);

  const { AppModule } = (await import('../dist/app.module.js')) as { AppModule: unknown };
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  botToken = app.get<{ TELEGRAM_BOT_TOKEN: string }>(ENV).TELEGRAM_BOT_TOKEN;

  // ── 1. Two accounts, created the way a real one is ────────────────────────
  hostAccount = await signIn(A_TELEGRAM_ID, A_USERNAME, 'Maryam');
  guestAccount = await signIn(B_TELEGRAM_ID, B_USERNAME, 'Negar');
  strangerAccount = await signIn(C_TELEGRAM_ID, 'privacy_gate_stranger', 'Ali');

  /**
   * Profiles with a phone number in the bio.
   *
   * Written directly rather than through the onboarding endpoint because the
   * endpoint's own moderation would reject a bio full of contact details — which
   * is correct, and would remove the thing the sweep is looking for. What is
   * being tested is whether the *projections* leak it, not whether the writer
   * accepted it.
   */
  const currentTerms = await prisma.policyVersion.findFirst({
    where: { type: 'TERMS', isCurrent: true },
    select: { id: true },
  });
  if (currentTerms) {
    await prisma.consent.createMany({
      data: [hostAccount.userId, guestAccount.userId, strangerAccount.userId].map((userId) => ({
        userId,
        policyVersionId: currentTerms.id,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.userProfile.createMany({
    data: [
      {
        userId: hostAccount.userId,
        displayName: A_NAME,
        cityId: fixture.tehranId,
        birthYear: 1993,
        bio: `برای هماهنگی تماس بگیرید ${A_PHONE}`,
      },
      {
        userId: guestAccount.userId,
        displayName: B_NAME,
        cityId: fixture.tehranId,
        birthYear: 1996,
        bio: `شمارهٔ من ${B_PHONE}`,
      },
      {
        userId: strangerAccount.userId,
        displayName: 'رهگذر',
        cityId: fixture.tehranId,
        birthYear: 1990,
      },
    ],
    skipDuplicates: true,
  });
  await prisma.user.updateMany({
    where: {
      id: { in: [hostAccount.userId, guestAccount.userId, strangerAccount.userId] },
    },
    data: { onboardingState: 'PROFILE_COMPLETE' },
  });

  // Fresh tokens, so the onboarding gate sees a completed profile.
  hostAccount = await signIn(A_TELEGRAM_ID, A_USERNAME, 'Maryam');
  guestAccount = await signIn(B_TELEGRAM_ID, B_USERNAME, 'Negar');
  strangerAccount = await signIn(C_TELEGRAM_ID, 'privacy_gate_stranger', 'Ali');

  // ── 2. A creates two events ───────────────────────────────────────────────
  eventPublicId = await createEvent('شب بازی رومیزی');
  secondEventPublicId = await createEvent('پیاده‌روی صبحگاهی');

  /**
   * Coins for B, who joins twice.
   *
   * Asking to join costs five from v0.7.0 (`economy.event_join_coins`). This
   * walk is about what each surface *renders*, so an affordability refusal would
   * fail it for a reason it is not testing.
   */
  await prisma.coinAccount.upsert({
    where: { userId: guestAccount.userId },
    create: { userId: guestAccount.userId, balance: 1_000 },
    update: { balance: 1_000 },
  });

  /**
   * ── 3. B asks to join the first event, and only the first ─────────────────
   *
   * The second join is deliberately deferred until after the conversation. A
   * plain Telegram message carries no indication of which chat it belongs to, so
   * the bot asks the sender to use "Reply" once they have more than one live
   * conversation — which is correct behaviour and would leave this walk sending
   * five messages that were never relayed.
   */
  const joined = await call(guestAccount, 'POST', `/api/v1/events/${eventPublicId}/join`);
  participantPublicId = (joined.json as { publicId: string }).publicId;
  chatPublicId = (joined.json as { chatPublicId: string }).chatPublicId;

  // ── 4. Five messages, across both surfaces ────────────────────────────────
  await call(guestAccount, 'POST', `/api/v1/chats/${chatPublicId}/messages`, {
    text: 'سلام، هنوز جا هست؟',
  });
  await call(hostAccount, 'POST', `/api/v1/chats/${chatPublicId}/messages`, {
    text: 'بله، خوش آمدید.',
  });
  await call(guestAccount, 'GET', `/api/v1/chats/${chatPublicId}/messages`);

  // …and through the bot, with the entity shape T2.2 exists for.
  await webhook(
    telegramMessage({ id: B_TELEGRAM_ID, username: B_USERNAME }, 'ساعت چند شروع می‌شود؟'),
  );
  await webhook(
    telegramMessage({ id: A_TELEGRAM_ID, username: A_USERNAME }, 'هفت عصر، جلوی کافه.', {
      entities: [
        {
          type: 'text_mention',
          offset: 0,
          length: 3,
          user: { id: Number(A_TELEGRAM_ID), first_name: 'Maryam', username: A_USERNAME },
        },
      ],
    }),
  );
  await webhook(
    telegramMessage({ id: B_TELEGRAM_ID, username: B_USERNAME }, `شمارهٔ من ${B_PHONE} است`),
  );

  // ── 5. A accepts ──────────────────────────────────────────────────────────
  await call(hostAccount, 'GET', `/api/v1/events/${eventPublicId}/participants`);
  await call(hostAccount, 'POST', `/api/v1/participants/${participantPublicId}/accept`);

  /**
   * Everything above happened while neither side had consented to anything, so
   * it is what the *anonymous stage* is judged on. The sweep for a phone number
   * runs against this prefix alone — after the next line the guest has chosen to
   * disclose theirs, and finding it afterwards is the feature working.
   */
  anonymousStageEnd = responses.length;

  // ── 6. B shares contact, deliberately ─────────────────────────────────────
  await call(guestAccount, 'POST', `/api/v1/chats/${chatPublicId}/share-contact`);
  await call(guestAccount, 'POST', `/api/v1/chats/${chatPublicId}/messages`, {
    text: `حالا می‌توانم بفرستم: ${B_PHONE}`,
  });

  // ── 7. And now the second event, for the correlation half ─────────────────
  await call(guestAccount, 'POST', `/api/v1/events/${secondEventPublicId}/join`);

  // ── 8. Both sides read everything they can ────────────────────────────────
  await call(guestAccount, 'GET', '/api/v1/chats');
  await call(hostAccount, 'GET', '/api/v1/chats');
  await call(hostAccount, 'GET', `/api/v1/chats/${chatPublicId}/messages`);
  await call(guestAccount, 'GET', '/api/v1/me/participations');
  await call(hostAccount, 'GET', '/api/v1/me/events');
  await call(guestAccount, 'GET', `/api/v1/events/${eventPublicId}`);
  await call(hostAccount, 'GET', `/api/v1/events/${secondEventPublicId}/participants`);
  await call(guestAccount, 'GET', '/api/v1/me');
  await call(hostAccount, 'GET', '/api/v1/me');
  await call(guestAccount, 'GET', '/api/v1/me/referral');
  await call(guestAccount, 'GET', '/api/v1/me/coins');
  await call(guestAccount, 'GET', '/api/v1/me/reviews/pending');
  await call(hostAccount, 'GET', `/api/v1/users/${guestAccount.publicId}/reviews`);
  await call(guestAccount, 'GET', `/api/v1/users/${hostAccount.publicId}/reviews`);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function createEvent(title: string): Promise<string> {
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی، مناسب همهٔ سطوح.';
  const startsAt = new Date(Date.now() + 9 * 24 * 3_600_000);
  const created = await prisma.event.create({
    data: {
      hostUserId: hostAccount.userId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 3_600_000),
      capacity: 5,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
    },
    select: { publicId: true },
  });
  return created.publicId;
}

/**
 * The four shapes, exactly as §3.6 layer 5 defines them.
 *
 * Both accounts' identifiers, because this walk has two real people in it and a
 * gate that only looked for one would pass a product that leaked the other.
 */
const IDENTIFIERS: Array<{ name: string; pattern: RegExp }> = [
  { name: "account A's Telegram id", pattern: new RegExp(String(A_TELEGRAM_ID)) },
  { name: "account B's Telegram id", pattern: new RegExp(String(B_TELEGRAM_ID)) },
  { name: 'an @username', pattern: /(?<![\w.+-])@[A-Za-z0-9_]{5,32}\b/ },
  { name: 'a t.me link', pattern: /t\.me\//i },
];

/**
 * The phone number, which is the one identifier a user is *allowed* to disclose.
 *
 * It is therefore checked separately and over a narrower slice: everything before
 * the guest chose to share, and never `GET /me`, which returns the caller their
 * own bio. A sweep that failed on somebody's own data would be silenced rather
 * than fixed — the mistake M5 already had to correct once.
 */
const PHONE_PATTERN = /(?:\+98|0)9\d{9}/;

/** Everything the worker would hand to Telegram, plus what it was derived from. */
async function rawPayloads(): Promise<Record<string, string>> {
  const [notifications, outbox, messages, audit, chats] = await Promise.all([
    prisma.notification.findMany(),
    prisma.outboxEvent.findMany(),
    prisma.chatMessage.findMany(),
    prisma.auditLog.findMany(),
    prisma.anonymousChat.findMany({ include: { chatParticipants: true } }),
  ]);

  return {
    'notification.payload (what the worker sends to Telegram)': render(notifications),
    'outbox_event.payload': render(outbox),
    'chat_message (ciphertext and metadata at rest)': render(messages),
    audit_log: render(audit),
    'anonymous_chat + chat_participant': render(chats),
  };
}

/**
 * `JSON.stringify` with bigints rendered rather than thrown on.
 *
 * `telegram_account.telegram_user_id` and `chat_message.telegram_message_ids` are
 * BIGINT, which Prisma maps to `bigint`, which `JSON.stringify` refuses — the
 * "useful accident" the schema comment celebrates, because it makes serialising
 * one into a *response* fail loudly. Here it would make the sweep fail loudly for
 * the wrong reason, and a sweep that cannot read a payload is a sweep that
 * reports clean on it. So the values are rendered as digits, which is precisely
 * the form the patterns below are hunting for.
 */
function render(rows: unknown): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

describe('B4 — two accounts, one conversation, zero identity leakage', () => {
  it('exchanged at least five messages', async () => {
    // Criterion 4 says ≥5, and a gate that ran on four would be a gate that
    // passed without exercising the thing it is named after.
    const stored = await prisma.chatMessage.count({
      where: { chat: { publicId: chatPublicId }, kind: 'TEXT' },
    });
    expect(stored).toBeGreaterThanOrEqual(5);
  });

  it.each(IDENTIFIERS)('never puts $name in any API response', ({ pattern }) => {
    const offenders = responses.filter((response) => pattern.test(response));
    expect(offenders).toEqual([]);
  });

  /**
   * T2.3 and criterion 6 together: before consent, a phone number reaches
   * nobody — including one the sender typed into the conversation themselves,
   * which is the case the masking exists for.
   */
  it('never puts a phone number in a response before either side consented', () => {
    const offenders = responses
      .slice(0, anonymousStageEnd)
      // A caller reading their own profile is not a disclosure to anybody.
      .filter((response) => !response.startsWith('GET /api/v1/me →'))
      .filter((response) => PHONE_PATTERN.test(response));
    expect(offenders).toEqual([]);
  });

  /**
   * The other half, and the reason the split above exists: after the guest
   * consents, their own number does reach the host. That is the feature, and a
   * gate that treated it as a leak would be arguing with ADR-0009 rather than
   * enforcing it.
   */
  it('does deliver the number once its owner has said so', () => {
    const afterConsent = responses.slice(anonymousStageEnd).join('\n');
    expect(PHONE_PATTERN.test(afterConsent)).toBe(true);
  });

  /**
   * The half that is not a response.
   *
   * ADR-0005 means this process never calls Telegram — the worker does — so the
   * closest thing to "the raw Telegram payload" available here is the
   * `notification` row the worker renders and sends. If an identifier reaches
   * that row, it reaches Telegram.
   */
  it.each(IDENTIFIERS)('never puts $name in a raw stored payload', async ({ pattern }) => {
    const payloads = await rawPayloads();
    const offenders = Object.entries(payloads)
      .filter(([, blob]) => pattern.test(blob))
      .map(([where]) => where);
    expect(offenders).toEqual([]);
  });

  /**
   * T2.3 — the user typed their own number *before* the chat opened, and the
   * masking has to have fired rather than merely not being asserted. The stored
   * body is ciphertext, so this checks the redaction record instead: a message
   * that was masked says so.
   */
  it('masked the contact details typed during the anonymous stage', async () => {
    const rows = await prisma.chatMessage.findMany({
      where: { chat: { publicId: chatPublicId } },
      select: { redactions: true },
    });
    const kinds = rows.flatMap((row) =>
      Array.isArray(row.redactions)
        ? row.redactions.map((entry) =>
            typeof entry === 'object' && entry !== null
              ? (entry as { kind?: unknown }).kind
              : undefined,
          )
        : [],
    );
    expect(kinds).toContain('PHONE');
  });

  /**
   * T2.2 — the `text_mention` entity carried a raw numeric user id, and the
   * relay must have stripped every entity rather than passing them through.
   */
  it('kept no message entity from the update that carried one', async () => {
    const payloads = await rawPayloads();
    expect(payloads['notification.payload (what the worker sends to Telegram)']).not.toContain(
      'text_mention',
    );
    expect(payloads['outbox_event.payload']).not.toContain('text_mention');
  });
});

describe('B4 — what each side can and cannot reach', () => {
  it('shows the host the guest’s name in their own queue, and no identifier beyond it', async () => {
    const { json } = await call(hostAccount, 'GET', `/api/v1/events/${eventPublicId}/participants`);
    const participants = (json as { participants: Array<Record<string, unknown>> }).participants;

    expect(participants[0]?.['displayName']).toBe(B_NAME);
    // ADR-0014's disclosure, and nothing else: no handle, no phone, no birth year.
    expect(Object.keys(participants[0] ?? {}).sort()).toEqual([
      'displayName',
      'hostDeadlineAt',
      'publicId',
      'requestedAt',
      'status',
      'trustScore',
      'userPublicId',
      'waitlistRank',
    ]);
  });

  it('refuses the stranger every private surface, as not-found rather than forbidden', async () => {
    // T3.3: a 403 confirms the thing exists, and confirming the existence of a
    // private conversation to somebody outside it is itself a disclosure.
    const chat = await call(strangerAccount, 'GET', `/api/v1/chats/${chatPublicId}/messages`);
    expect(chat.status).toBe(404);

    const queue = await call(
      strangerAccount,
      'GET',
      `/api/v1/events/${eventPublicId}/participants`,
    );
    expect(queue.status).toBe(404);

    const accept = await call(
      strangerAccount,
      'POST',
      `/api/v1/participants/${participantPublicId}/accept`,
    );
    expect(accept.status).toBeGreaterThanOrEqual(400);
  });

  it('tells the stranger nothing about who is in the event they can see', async () => {
    const { body } = await call(strangerAccount, 'GET', `/api/v1/events/${eventPublicId}`);
    // The host is a public id and a name — the event is an invitation, and an
    // invitation with nobody behind it is not one anybody accepts. The *guest*
    // is not there at all.
    expect(body).toContain(A_NAME);
    expect(body).not.toContain(B_NAME);
    expect(body).not.toContain(guestAccount.publicId);
  });

  /**
   * R8, asserted from the API rather than from the services: the host sees the
   * same person on both of their queues. Accepted, disclosed in `ChatsView`, and
   * pinned here so a change in either direction is deliberate.
   */
  it('lets the host correlate the guest across their own two events, and no further', async () => {
    const first = await call(hostAccount, 'GET', `/api/v1/events/${eventPublicId}/participants`);
    const second = await call(
      hostAccount,
      'GET',
      `/api/v1/events/${secondEventPublicId}/participants`,
    );

    const idOf = (json: unknown): unknown =>
      (json as { participants: Array<{ userPublicId: string }> }).participants[0]?.userPublicId;
    expect(idOf(first.json)).toBe(idOf(second.json));

    // And there is no route from that identifier to anything else the guest did.
    const discovery = await call(
      hostAccount,
      'GET',
      `/api/v1/events?q=${encodeURIComponent(B_NAME)}`,
    );
    expect(discovery.body).not.toContain(secondEventPublicId);
  });

  /**
   * Invariant 8. Neither side has reviewed, so neither may read one — and the
   * endpoint that would show them is the one a counterparty would try.
   */
  it('shows no unrevealed review to either party', async () => {
    const aboutGuest = await call(
      hostAccount,
      'GET',
      `/api/v1/users/${guestAccount.publicId}/reviews`,
    );
    const aboutHost = await call(
      guestAccount,
      'GET',
      `/api/v1/users/${hostAccount.publicId}/reviews`,
    );

    expect((aboutGuest.json as { reviews: unknown[] }).reviews).toEqual([]);
    expect((aboutHost.json as { reviews: unknown[] }).reviews).toEqual([]);
  });

  it('keeps the guest’s coins, referral code and gift codes to themselves', async () => {
    const referral = await call(guestAccount, 'GET', '/api/v1/me/referral');
    const code = (referral.json as { code: string }).code;

    // The referrer's own code is theirs; nothing lets somebody else read it, and
    // nothing lets a redemption name an amount.
    const hostReferral = await call(hostAccount, 'GET', '/api/v1/me/referral');
    expect((hostReferral.json as { code: string }).code).not.toBe(code);

    const redeem = await call(strangerAccount, 'POST', '/api/v1/gift-codes/redeem', {
      code: 'NOSUCHCODE',
    });
    expect(redeem.status).toBeGreaterThanOrEqual(400);
    expect(redeem.body).not.toContain(strangerAccount.publicId);
  });

  it('leaves the contact masking on until the sharer says otherwise', async () => {
    // The guest shared; the host did not. So the host's own messages are still
    // masked, which is the asymmetry `share-contact` actually creates.
    const chat = await prisma.anonymousChat.findFirstOrThrow({
      where: { publicId: chatPublicId },
      include: { chatParticipants: { select: { role: true, contactSharedAt: true } } },
    });
    const byRole = new Map(chat.chatParticipants.map((p) => [p.role, p.contactSharedAt]));
    expect(byRole.get('GUEST')).not.toBeNull();
    expect(byRole.get('HOST')).toBeNull();
  });
});
