import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import { ENV } from '@payetam/platform';
import {
  AdminAccessService,
  ChatService,
  ChatUnsealService,
  CoinService,
  ROLE_KEYS,
  ROLE_NAMES_FA,
  ReferralService,
  SessionService,
  normalize,
} from '@payetam/domain';
import { ADMIN_SESSION_COOKIE } from './admin/admin.guard';
import { registerCookies } from './admin/cookie.setup';
import {
  createTestPrisma,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../test/integration/db';

/**
 * §3.6 layer 5 — the automated leak scan.
 *
 * Layers 1–3 (storage separation, DTO allowlists, per-chat aliases) are design
 * decisions, and design decisions decay: someone adds a field to a mapper, or
 * swaps an explicit projection for a spread, and nothing fails. This walks every
 * endpoint a client can reach and fails on anything Telegram-identity-shaped in
 * the response, which is the regression net that keeps those three layers honest.
 *
 * It boots the **real** application — the real module graph, the real global
 * guard, the real exception filter — rather than calling mappers directly. A leak
 * that only appears once Nest serialises the response is exactly the kind this
 * has to catch, and a mapper called in isolation would never show it.
 *
 * It lives in `apps/api` rather than `test/` because it needs the API's own
 * dependencies (`@nestjs/platform-fastify`), which the workspace root does not
 * carry — and because the thing under test is this app's surface.
 *
 * The plan schedules it for M5 and expects it to grow: every milestone that adds
 * an endpoint adds it to `ENDPOINTS` below.
 */

const prisma: PrismaClient = createTestPrisma();

/** Distinctive so a match is unambiguous, and shaped like a real Telegram id. */
const TELEGRAM_USER_ID = 573_914_882n;
const TELEGRAM_USERNAME = 'leaky_test_handle';
const PHONE = '+989121234567';

let app: NestFastifyApplication;
let fixture: CatalogFixture;
let accessToken: string;
let eventPublicId: string;
let viewerEventPublicId: string;
let hostParticipantPublicId: string;
let viewerParticipantPublicId: string;
let chatPublicId: string;
let reviewedParticipantPublicId: string;
let hostPublicId: string;
let adminCookie: string;
let adminCsrf: string;
let reviewPublicId: string;
/** M19 addresses a gift code by `public_id`; the code itself is a secret. */
let scannedGiftCodePublicId: string;
/** The referral the scan rejects and reinstates, over and over, one pass each. */
let scannedReferralId: string;
/** An activity tag the scan edits and reorders. Never deleted, so every pass finds it. */
let scanTagId: string;
/** A second one, for the delete. Gone after the first pass — see the note at its endpoint. */
let scanDoomedTagId: string;

/** `METHOD /path/with/:params`, as Fastify registers them. */
const registeredRoutes = new Set<string>();

/** Counters for the two endpoints whose payload may be presented only once. */
let authAttempt = 0;
let refreshAttempt = 0;

interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** Endpoints that answer without a session; the rest are sent one. */
  anonymous?: boolean;
  /**
   * Reached with the **staff** session instead of the user's.
   *
   * The admin API is a separate identity system with a separate session
   * mechanism (ADR-0010), so scanning it needs a second credential — and it very
   * much needs scanning: it is the surface that returns other people's records.
   */
  admin?: boolean;
  /**
   * A cookie of this endpoint's own, for the one route that destroys the session
   * it is given. Without it, `logout` would sign the scan out on its first pass
   * and every admin read after that would be a 401 the scan mistook for coverage.
   */
  adminCookieFor?: () => string;
  /**
   * Sent as JSON for the endpoints that read one.
   *
   * A record rather than `unknown`: narrowing `unknown` by `!== undefined` leaves
   * `{} | null`, and `null` is not a payload Fastify's `inject` accepts.
   *
   * A **function** for the endpoints whose payload may be used only once —
   * `initData` is claimed as a one-time nonce by the replay guard. With a fixed
   * payload only the first of the four passes would read the success body and the
   * other three would read the refusal, which makes what actually gets scanned
   * depend on the order of `LEAK_PATTERNS`. A security test should not be
   * order-dependent.
   */
  body?: Record<string, unknown> | (() => Record<string, unknown>);
}

/**
 * Signs `initData` exactly the way Telegram does, so the scan reaches
 * `POST /auth/telegram`'s success path rather than only its refusal.
 */
function signInitData(botToken: string, fields: Record<string, string>): string {
  const dataCheckString = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

/**
 * Every endpoint a client can reach.
 *
 * The reads that need no fixture are listed here; the rest are appended once the
 * ids they address exist. The Telegram webhook is deliberately absent — it is
 * authenticated by a secret token rather than a session, answers 200 with an
 * empty body by design (§3.1), and is not a surface any user reads.
 */
const ENDPOINTS: Endpoint[] = [
  { method: 'GET', url: '/health', anonymous: true },
  { method: 'GET', url: '/ready', anonymous: true },
  /**
   * `/metrics` is scanned like everything else, and it is one of the few endpoints
   * where a leak would be *structural* rather than accidental: a label taken from a
   * URL rather than a route pattern would publish an event id, a user public id, or a
   * search term to anything that can scrape. M16 labels on the route pattern for
   * exactly that reason, and this is what holds it there.
   *
   * The scan reaches it over loopback, which is what the controller's own network
   * check permits — so this also asserts that a legitimate scraper gets a body
   * rather than the 404 an outside caller gets.
   */
  { method: 'GET', url: '/metrics', anonymous: true },
  { method: 'GET', url: '/api/v1/policies/current?type=TERMS', anonymous: true },
  { method: 'GET', url: '/api/v1/me' },
  { method: 'GET', url: '/api/v1/catalog' },
  { method: 'GET', url: '/api/v1/me/events' },
  { method: 'GET', url: '/api/v1/events' },
  { method: 'GET', url: '/api/v1/events?q=دورهمی&sort=SOONEST' },
  { method: 'GET', url: '/api/v1/events?sort=NEWEST&limit=5' },
];

beforeAll(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);

  /**
   * Two users, and the split is the whole point.
   *
   * The *host* carries every identifier the scan hunts for, so a leak has
   * something to leak. The *viewer* is a clean, separate account, and it is the
   * one that authenticates. Every response the scan reads is therefore what a
   * stranger sees of somebody else — which is the property §3.6 protects.
   *
   * Authenticating as the leaky user instead would make `GET /me` return that
   * user's own bio and phone, and the scan would fail on data the caller wrote
   * about themselves. That is not a leak, and a test that calls it one gets
   * silenced rather than fixed.
   */
  const host = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: {
        create: {
          telegramUserId: TELEGRAM_USER_ID,
          usernameCached: TELEGRAM_USERNAME,
          firstNameCached: 'Leaky',
        },
      },
      profile: {
        create: {
          displayName: 'میزبان آزمایشی',
          cityId: fixture.tehranId,
          birthYear: 1995,
          bio: `برای هماهنگی تماس بگیرید ${PHONE}`,
        },
      },
    },
    select: { id: true, publicId: true },
  });
  hostPublicId = host.publicId;

  const user = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: 100_200_300n } },
      profile: {
        create: { displayName: 'بازدیدکننده', cityId: fixture.tehranId, birthYear: 1996 },
      },
    },
    select: { id: true, publicId: true, onboardingState: true },
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
      districtId: fixture.tehranDistrictId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity: 6,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
    },
    select: { id: true, publicId: true },
  });
  eventPublicId = event.publicId;

  /**
   * A second event, hosted by the *viewer*, so the scan can read the surface M6
   * introduces: the list a host sees of everyone who asked to join. That list is
   * the first place in the product where one user is shown rows describing
   * another, which makes it the highest-risk projection built so far.
   *
   * The leaky user is the one who asks to join it, so their identifiers are
   * genuinely present in the data behind the response.
   */
  const viewerEvent = await prisma.event.create({
    data: {
      hostUserId: user.id,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity: 6,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
    },
    select: { id: true, publicId: true },
  });
  viewerEventPublicId = viewerEvent.publicId;

  const hostRequest = await prisma.eventParticipant.create({
    data: { eventId: viewerEvent.id, userId: host.id, status: 'PENDING' },
    select: { publicId: true },
  });
  hostParticipantPublicId = hostRequest.publicId;

  const viewerRequest = await prisma.eventParticipant.create({
    data: {
      eventId: event.id,
      userId: user.id,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
      graceExpiresAt: new Date(Date.now() + 15 * 60_000),
    },
    select: { id: true, publicId: true },
  });
  viewerParticipantPublicId = viewerRequest.publicId;

  /**
   * A finished meeting between the two of them, reviewed on both sides (M11).
   *
   * `GET /users/:publicId/reviews` is **public** and returns free text one user
   * wrote about another, which makes it the highest-risk read this milestone adds.
   * It needs real revealed rows to be worth scanning at all — an empty list proves
   * nothing — so a third event is settled and reviewed here.
   *
   * The comment is deliberately clean. A review comment containing a phone number
   * is a *moderation* question, not a leak-scan one: the scan's job is to catch the
   * platform leaking identity, not to catch a user publishing their own. What is
   * being asserted is that the envelope carries no reviewer id, no internal id and
   * no Telegram handle.
   */
  const pastEvent = await prisma.event.create({
    data: {
      hostUserId: host.id,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000),
      capacity: 6,
      costType: 'FREE',
      status: 'COMPLETED',
      moderationStatus: 'APPROVED',
      publishedAt: new Date(),
      acceptedCount: 1,
    },
    select: { id: true },
  });

  const pastRequest = await prisma.eventParticipant.create({
    data: {
      eventId: pastEvent.id,
      userId: user.id,
      status: 'COMPLETED',
      acceptedAt: new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
      attended: true,
    },
    select: { id: true, publicId: true },
  });
  reviewedParticipantPublicId = pastRequest.publicId;

  const revealedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [aboutViewer, aboutHost] = await Promise.all([
    prisma.review.create({
      data: {
        eventId: pastEvent.id,
        participantId: pastRequest.id,
        reviewerUserId: host.id,
        revieweeUserId: user.id,
        rating: 5,
        tags: ['PUNCTUAL', 'FRIENDLY'],
        comment: 'همراه بسیار خوبی بود.',
        status: 'REVEALED',
        revealedAt,
        editDeadlineAt: revealedAt,
      },
      select: { id: true, publicId: true },
    }),
    prisma.review.create({
      data: {
        eventId: pastEvent.id,
        participantId: pastRequest.id,
        reviewerUserId: user.id,
        revieweeUserId: host.id,
        rating: 4,
        tags: ['WELL_ORGANISED'],
        comment: 'برنامهٔ منظمی بود.',
        status: 'REVEALED',
        revealedAt,
        editDeadlineAt: revealedAt,
      },
      select: { id: true },
    }),
  ]);

  reviewPublicId = aboutViewer.publicId;

  await prisma.reviewPair.create({
    data: {
      participantId: pastRequest.id,
      eventId: pastEvent.id,
      hostReviewId: aboutViewer.id,
      guestReviewId: aboutHost.id,
      status: 'REVEALED',
      revealedAt,
      opensAt: new Date(revealedAt.getTime() - 24 * 60 * 60 * 1000),
      deadlineAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  /**
   * The chat M8 introduces, between the viewer and the leaky host.
   *
   * This is the highest-risk projection in the product so far and the reason the
   * scan exists: a chat response is one user being shown rows that another user
   * wrote, in a feature whose entire promise is that they cannot tell who that
   * is. OPEN rather than ANONYMOUS so the contact-sharing endpoint has something
   * to answer.
   */
  const chat = await prisma.anonymousChat.create({
    data: {
      eventId: event.id,
      participantId: viewerRequest.id,
      status: 'OPEN',
      openedAt: new Date(),
      chatParticipants: {
        create: [
          { userId: host.id, role: 'HOST', alias: 'میزبان', aliasIndex: 0 },
          { userId: user.id, role: 'GUEST', alias: 'میهمان ۱', aliasIndex: 1 },
        ],
      },
    },
    select: { publicId: true },
  });
  chatPublicId = chat.publicId;

  // Both participations above hold a seat (PENDING and ACCEPTED both do), so the
  // counter has to say so. Seeding the rows without it would leave the fixture
  // describing a state the product cannot reach, and the first cancellation
  // would try to release a seat from a count of zero.
  await prisma.event.updateMany({
    where: { id: { in: [event.id, viewerEvent.id] } },
    data: { acceptedCount: 1 },
  });

  await prisma.policyVersion.create({
    data: {
      type: 'TERMS',
      version: 1,
      contentMd: 'شرایط استفاده از پایه‌تَم.',
      summaryFa: 'خلاصهٔ شرایط',
      isCurrent: true,
    },
  });

  // The compiled module, not the TypeScript source: NestJS DI reads
  // `design:paramtypes`, which `tsc` emits and the test runner's esbuild
  // transform does not. Importing the source would leave every constructor
  // parameter unresolvable.
  const { AppModule } = (await import('../dist/app.module.js')) as { AppModule: unknown };

  /**
   * `abortOnError: false`, which is the difference between a diagnosable failure and
   * an unreadable one.
   *
   * Nest's default on an initialisation error is `process.abort()`. Under Vitest that
   * kills the worker before anything is flushed, and the entire report is "Worker
   * exited unexpectedly" with a native stack trace — no module, no provider, no
   * missing dependency. M16 spent a while on exactly that. With this flag the promise
   * rejects and the message names the provider it could not resolve.
   */
  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );

  /**
   * Every route the application actually registers, collected from Fastify as
   * Nest declares them.
   *
   * The hook goes on before `init()` because that is when Nest walks the
   * controllers. This is what makes the coverage assertion below real rather than
   * a magic number: M9 added five endpoints and the old `toHaveLength(22)` stayed
   * green, which is precisely the failure mode a leak scan cannot afford — it
   * kept reporting clean about a surface it had stopped covering.
   */
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route: { method: string | string[]; url: string }) => {
      for (const method of [route.method].flat()) {
        // Fastify synthesises these; neither returns a body worth scanning.
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        registeredRoutes.add(`${method} ${route.url}`);
      }
    });

  // The admin API authenticates with a cookie, and the plugin has to be on the
  // instance before Nest boots it — the same call `bootstrap()` makes.
  await registerCookies(app);

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // Minted through the application's own SessionService, so the token is signed
  // with the same secret the guard verifies against.
  const sessions = app.get(SessionService);
  const tokens = await sessions.issue(user.publicId, user.onboardingState);
  accessToken = tokens.accessToken;

  /**
   * The leaky host tries to hand over every identifier at once.
   *
   * Sent through the application's own `ChatService`, so the message goes through
   * the real sanitizer and the real cipher rather than being seeded past them.
   * What the scan then asserts about `GET /chats/:id/messages` is the property
   * M8 exists for: the recipient reads the conversation and none of it arrives.
   *
   * A message body is content the recipient is *entitled* to see, so this only
   * works because the masking is what removes the identifiers. Seeding an
   * unmasked body and calling the read a leak would be testing the wrong thing —
   * the same mistake M5 had to correct when the scan authenticated as the user
   * whose own data it was reading.
   */
  const chats = app.get(ChatService);
  await chats.send(host.id, chatPublicId, {
    text: `برای هماهنگی: ${PHONE} یا @${TELEGRAM_USERNAME} — https://t.me/${TELEGRAM_USERNAME}`,
  });

  /**
   * The viewer needs coins, and the *leaky host* needs to be the one who invited
   * them — both so M9's endpoints answer with real data rather than with an empty
   * balance and a null referrer.
   *
   * The referral is the shape worth scanning: the referred user knows exactly who
   * referred them in real life, but the API must still not hand over a Telegram
   * handle for that person, and `GET /me/referral` on the *other* side counts
   * invitees without naming any of them.
   */
  await app.get(CoinService).apply({
    userId: user.id,
    amount: 500,
    type: 'ADMIN_ADJUSTMENT',
    reasonCode: 'leak-scan.funding',
    idempotencyKey: `leak-scan:${user.id}`,
    actorType: 'ADMIN',
  });
  const hostReferralCode = (await app.get(ReferralService).summaryFor(host.id)).code;

  /**
   * `initData` for the **leaky host**, signed the way Telegram signs it.
   *
   * This is the one endpoint in the product that takes a raw Telegram user id as
   * *input*, which makes it the likeliest place for one to come straight back
   * out — and until now it was never scanned. Signed rather than faked so the
   * response is a real session for a real account rather than a 401 that proves
   * nothing about the success path.
   *
   * Freshly signed per call, because the replay guard claims each hash once. A
   * fixed payload would leave the success body scanned by whichever pattern
   * happens to run first and the refusal by the other three.
   */
  const env = app.get<{ TELEGRAM_BOT_TOKEN: string }>(ENV);
  const hostInitData = (): Record<string, unknown> => ({
    initData: signInitData(env.TELEGRAM_BOT_TOKEN, {
      auth_date: String(Math.floor(Date.now() / 1000)),
      // A nonce, so each call is a distinct payload with a distinct hash rather
      // than the same one presented again.
      query_id: `leak-scan-${String(authAttempt++)}`,
      user: JSON.stringify({
        id: Number(TELEGRAM_USER_ID),
        first_name: 'Leaky',
        username: TELEGRAM_USERNAME,
        language_code: 'fa',
      }),
    }),
  });

  // Fresh families for the same reason, and separate from the session every other
  // endpoint in the scan authenticates with — consuming one must not disturb it.
  const refreshTokens = await Promise.all(
    Array.from({ length: LEAK_PATTERNS.length }, () =>
      sessions.issue(user.publicId, user.onboardingState),
    ),
  );
  const nextRefresh = (): Record<string, unknown> => ({
    refreshToken: refreshTokens[refreshAttempt++ % refreshTokens.length]?.refreshToken ?? '',
  });

  /**
   * A staff account with every capability, so the admin API answers with real
   * data rather than with refusals.
   *
   * SUPER_ADMIN on purpose: the scan is looking for what the *most* privileged
   * response contains, and a role that could not reach an endpoint would leave it
   * unscanned while looking scanned.
   */
  for (const key of Object.values(ROLE_KEYS)) {
    await prisma.role.upsert({
      where: { key },
      update: {},
      create: { key, name: ROLE_NAMES_FA[key] },
    });
  }
  const adminAccess = app.get(AdminAccessService);
  const adminPassword = 'leak-scan-admin-password';
  const created = await adminAccess.createAdmin({
    email: 'leak-scan@payetam.test',
    password: adminPassword,
    displayName: 'اسکن',
    roles: [ROLE_KEYS.SUPER_ADMIN],
  });
  const { base32Decode, totpCode } = await import('@payetam/domain');
  const signedIn = await adminAccess.login({
    email: 'leak-scan@payetam.test',
    password: adminPassword,
    totpCode: totpCode(base32Decode(created.totpSecret), Date.now()),
  });
  adminCookie = signedIn.sessionToken;
  adminCsrf = signedIn.csrfToken;

  // Throwaway sessions for `logout`, which consumes the one it is handed. The
  // CSRF token is shared because every one of these is the same account.
  const disposableAdmin: string[] = [];
  for (let index = 0; index < LEAK_PATTERNS.length + 1; index += 1) {
    const extra = await adminAccess.login({
      email: 'leak-scan@payetam.test',
      password: adminPassword,
      totpCode: totpCode(base32Decode(created.totpSecret), Date.now()),
    });
    disposableAdmin.push(extra.sessionToken);
    adminCsrf = extra.csrfToken;
  }
  adminCookie = disposableAdmin[0] ?? adminCookie;
  let logoutIndex = 1;

  /**
   * An open case on the chat, and a live grant against it.
   *
   * Break-glass needs all three of a permission, an open case and a reason (T14),
   * so scanning the read path at all means satisfying them — and the read is the
   * one endpoint in the product that returns decrypted private messages, which
   * makes it the single most important response in this file to scan.
   */
  const chatRow = await prisma.anonymousChat.findFirstOrThrow({
    where: { publicId: chatPublicId },
    select: { id: true },
  });
  await prisma.moderationCase.create({
    data: {
      subjectType: 'MESSAGE',
      subjectId: chatRow.id,
      trigger: 'REPORT_THRESHOLD',
      status: 'OPEN',
      reportCount: 3,
    },
  });
  const liveGrant = await app
    .get(ChatUnsealService)
    .grant(
      { ...signedIn.session, adminUserId: created.adminUserId },
      chatPublicId,
      'scanning the unsealed read path for identity leakage',
    );

  const currentTerms = await prisma.policyVersion.findFirstOrThrow({
    where: { type: 'TERMS', isCurrent: true },
    select: { id: true },
  });

  /**
   * A campaign the scan can address by `public_id` (M19, ADR-0016).
   *
   * Minted here rather than by the scanned `POST` because the routes below have
   * to name it in a URL, and the scan runs its list several times — the create
   * would be a duplicate on the second pass and the `PATCH` would then be
   * addressing something that never existed.
   */
  scannedGiftCodePublicId = (
    await prisma.giftCode.create({
      data: { code: 'LEAKSCANTARGET', coins: 5, campaign: 'leak-scan' },
      select: { publicId: true },
    })
  ).publicId;

  /**
   * A referral of its own, for the review queue.
   *
   * Between two throwaway accounts rather than between the fixture pair, because
   * `POST /api/v1/referrals/claim` is itself scanned and has to reach its
   * *success* body at least once — pre-claiming for the viewer would leave that
   * endpoint answering `ALREADY_REFERRED` on every pass.
   *
   * The referrer carries the leaky identifiers, so the queue has something to
   * leak if it were going to. Reject and reinstate form a **cycle** —
   * `PENDING → REJECTED → PENDING` — so each pass leaves the row where it found
   * it and the next pass reads a success rather than a transition refusal.
   */
  const scanReferrer = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: {
        create: { telegramUserId: TELEGRAM_USER_ID + 1n, usernameCached: TELEGRAM_USERNAME },
      },
      profile: {
        create: { displayName: 'معرف', cityId: fixture.tehranId, birthYear: 1994 },
      },
    },
    select: { id: true },
  });
  const scanReferred = await prisma.user.create({
    data: { onboardingState: 'PROFILE_COMPLETE' },
    select: { id: true },
  });
  scannedReferralId = (
    await prisma.referral.create({
      data: {
        referrerUserId: scanReferrer.id,
        referredUserId: scanReferred.id,
        code: 'SCANREF1',
        status: 'PENDING',
        fraudSignals: { reason: 'velocity', recentReferrals: 12 },
      },
      select: { id: true },
    })
  ).id;

  // Two activity tags (M21): one the scan edits on every pass, one it deletes.
  scanTagId = (
    await prisma.category.create({
      data: { slug: 'leak-scan-tag', nameFa: 'پویش نشتی', isActive: false },
      select: { id: true },
    })
  ).id;
  scanDoomedTagId = (
    await prisma.category.create({
      data: { slug: 'leak-scan-doomed', nameFa: 'پویش حذف', isActive: false },
      select: { id: true },
    })
  ).id;

  ENDPOINTS.push(
    { method: 'GET', url: `/api/v1/events/${eventPublicId}` },
    { method: 'GET', url: `/api/v1/events/${eventPublicId}/explain-rank` },
    // M6. The two reads are the ones that matter: `participants` shows a host
    // rows describing other people, and `me/participations` is the same data
    // from the other side. The writes are included because §3.6 says *every*
    // endpoint, and because an error body is a response too — a 409 that named
    // the person it conflicted with would be just as much of a leak.
    { method: 'GET', url: '/api/v1/me/participations' },
    { method: 'GET', url: `/api/v1/events/${viewerEventPublicId}/participants` },
    { method: 'POST', url: `/api/v1/events/${eventPublicId}/join` },
    { method: 'POST', url: `/api/v1/participants/${hostParticipantPublicId}/accept` },
    { method: 'POST', url: `/api/v1/participants/${hostParticipantPublicId}/reject` },
    // M10's dry run, immediately before the cancel it quotes for — it has to see
    // a live participation, and the next line ends this one.
    { method: 'GET', url: `/api/v1/participants/${viewerParticipantPublicId}/cancel-preview` },
    { method: 'POST', url: `/api/v1/participants/${viewerParticipantPublicId}/cancel`, body: {} },
    // M8. `close` is deliberately last: it ends the conversation, and the passes
    // that follow then read a closed chat and get the refusals — which are
    // responses too, and an error body that named the person it refused would be
    // just as much of a leak as a success body that did.
    { method: 'GET', url: '/api/v1/chats' },
    { method: 'GET', url: `/api/v1/chats/${chatPublicId}/messages` },
    {
      method: 'POST',
      url: `/api/v1/chats/${chatPublicId}/messages`,
      body: { text: 'ساعت هفت جلوی کافه' },
    },
    { method: 'POST', url: `/api/v1/chats/${chatPublicId}/share-contact` },
    { method: 'POST', url: `/api/v1/chats/${chatPublicId}/close`, body: {} },
    /**
     * The six the coverage check above found uncovered — every one of them a
     * *write*, and every one of them there since M2 or M4.
     *
     * They matter more than their late arrival suggests: `auth/telegram` is the
     * only endpoint that receives a Telegram user id, and `onboarding/profile`
     * and `events` are where a user's own words enter the system. A write's
     * response is a projection like any other, and nothing was reading them.
     *
     * The bodies are deliberately clean. Putting the leaky identifiers in a title
     * or a bio here would make the scan fail on content the *caller* wrote about
     * themselves, which is not a leak — the mistake M5 already had to correct.
     */
    { method: 'POST', url: '/api/v1/auth/telegram', anonymous: true, body: hostInitData },
    { method: 'POST', url: '/api/v1/auth/refresh', anonymous: true, body: nextRefresh },
    {
      method: 'POST',
      url: '/api/v1/onboarding/consent',
      body: { policyVersionIds: [currentTerms.id] },
    },
    {
      method: 'POST',
      url: '/api/v1/onboarding/profile',
      body: {
        displayName: 'بازدیدکننده',
        birthYear: 1996,
        cityId: fixture.tehranId,
        interestIds: [fixture.boardGamesId],
      },
    },
    {
      method: 'POST',
      url: '/api/v1/events',
      body: {
        title: 'پیاده‌روی صبحگاهی',
        description: 'یک پیاده‌روی آرام در پارک، مناسب همهٔ سطوح.',
        categoryId: fixture.categoryId,
        cityId: fixture.tehranId,
        startsAt: new Date(Date.now() + 10 * 24 * 3_600_000).toISOString(),
        endsAt: new Date(Date.now() + 10 * 24 * 3_600_000 + 2 * 3_600_000).toISOString(),
        capacity: 5,
        costType: 'FREE',
      },
    },
    {
      method: 'PATCH',
      url: `/api/v1/events/${viewerEventPublicId}`,
      body: { capacity: 7 },
    },
    // M9. `claim` names the leaky host's referral code, so the referral behind
    // every read below genuinely points at the account carrying the identifiers.
    // Repeated passes get ALREADY_REFERRED, which is a response too — a 409 that
    // named the person it conflicted with would be just as much of a leak.
    { method: 'POST', url: '/api/v1/referrals/claim', body: { code: hostReferralCode } },
    { method: 'GET', url: '/api/v1/me/coins' },
    { method: 'GET', url: '/api/v1/me/trust' },
    { method: 'GET', url: '/api/v1/me/referral' },
    // The only endpoint in the product that spends a user's own coins. Its
    // response is the event, which carries the host's projection — the same one
    // `GET /events/:id` is scanned for, reached by a different mapper.
    { method: 'POST', url: `/api/v1/events/${viewerEventPublicId}/boost`, body: { kind: 'BOOST' } },
    /**
     * M10. The host's dry run reads and changes nothing, so it goes above the
     * cancellation it quotes for.
     *
     * `no-show` names the **leaky host's** participation on the viewer's event,
     * which is the shape worth scanning: one user making an accusation about
     * another, where the response must still describe that other person by
     * nothing at all. It refuses today — the event has not happened — and the
     * refusal is a response like any other.
     */
    { method: 'GET', url: `/api/v1/events/${viewerEventPublicId}/cancel-preview` },
    { method: 'POST', url: `/api/v1/participants/${hostParticipantPublicId}/no-show` },
    /**
     * M11. `users/:id/reviews` returns free text one user wrote about another to
     * any signed-in caller, which makes it the highest-risk read this milestone
     * adds — so it is scanned against a real revealed pair rather than an empty
     * list, which would have proved nothing.
     *
     * The two writes address the *revealed* participation, so they refuse — the
     * window is closed and the review already exists. Both refusals are responses,
     * and a 409 that named the counterparty would leak exactly as much as a
     * success body that did.
     */
    { method: 'GET', url: `/api/v1/users/${hostPublicId}/reviews` },
    { method: 'GET', url: '/api/v1/me/reviews/pending' },
    { method: 'GET', url: `/api/v1/participants/${reviewedParticipantPublicId}/review` },
    {
      method: 'POST',
      url: `/api/v1/participants/${reviewedParticipantPublicId}/review`,
      body: { rating: 5, tags: [], comment: 'دوباره هم می‌آیم.' },
    },
    {
      method: 'PUT',
      url: `/api/v1/participants/${reviewedParticipantPublicId}/review`,
      body: { rating: 4, tags: [] },
    },
    /**
     * M12's user-facing half. Reporting is a *user* action, and the response says
     * only that the report was filed — never how many others there are, which
     * would let somebody probe how close a rival's event is to being hidden.
     */
    {
      method: 'POST',
      url: `/api/v1/events/${eventPublicId}/report`,
      body: { reason: 'SPAM', description: 'تبلیغاتی به نظر می‌رسد' },
    },
    { method: 'POST', url: `/api/v1/users/${hostPublicId}/report`, body: { reason: 'HARASSMENT' } },
    { method: 'POST', url: `/api/v1/reviews/${reviewPublicId}/report`, body: { reason: 'OTHER' } },
    { method: 'POST', url: `/api/v1/chats/${chatPublicId}/report`, body: { reason: 'SAFETY' } },
    /**
     * M18's gift codes, both sides.
     *
     * The user's redeem endpoint answers a refusal here — no such code — which is
     * the response shape that most needs scanning: an error body is a projection
     * like any other, and one that named the account it refused would be exactly
     * the leak §3.6 exists to catch.
     */
    { method: 'POST', url: '/api/v1/gift-codes/redeem', body: { code: 'NOSUCHCODE' } },
    {
      method: 'POST',
      url: '/admin/v1/gift-codes',
      admin: true,
      body: { code: 'LEAKSCAN1', coins: 5, note: 'scan coverage', campaign: 'leak-scan' },
    },
    /**
     * M19's bulk mint, which is the one admin response in the product that
     * deliberately returns secrets — and therefore the one where the scan's job
     * is to prove that what it returns is *only* those secrets.
     */
    {
      method: 'POST',
      url: '/admin/v1/gift-codes/batch',
      admin: true,
      body: { count: 3, coins: 5, campaign: 'leak-scan', prefix: 'SCAN' },
    },
    { method: 'GET', url: '/admin/v1/gift-codes', admin: true },
    { method: 'GET', url: '/admin/v1/gift-codes?campaign=leak-scan&limit=5', admin: true },
    {
      method: 'PATCH',
      url: `/admin/v1/gift-codes/${scannedGiftCodePublicId}`,
      admin: true,
      body: { note: 'retuned by the scan' },
    },
    { method: 'GET', url: '/admin/v1/gift-codes/campaigns', admin: true },
    {
      method: 'GET',
      url: `/admin/v1/gift-codes/${scannedGiftCodePublicId}/analytics`,
      admin: true,
    },
    {
      method: 'GET',
      url: `/admin/v1/gift-codes/${scannedGiftCodePublicId}/redemptions`,
      admin: true,
    },
    {
      method: 'POST',
      url: `/admin/v1/gift-codes/${scannedGiftCodePublicId}/active`,
      admin: true,
      body: { isActive: false },
    },
    /**
     * M12's admin API, reached with the staff session.
     *
     * This is the surface that exists to show one person another person's records,
     * so it is the surface where a Telegram identifier would be least surprising
     * and most damaging. The moderation queue, the audit trail and the unsealed
     * conversation are all scanned.
     */
    /**
     * M19's referral review. The queue is a screen full of *other people's*
     * relationships, which makes it exactly the kind of admin surface a Telegram
     * identifier would be least surprising and most damaging on.
     */
    { method: 'GET', url: '/admin/v1/referrals', admin: true },
    { method: 'GET', url: '/admin/v1/referrals?status=PENDING&flagged=true', admin: true },
    { method: 'GET', url: `/admin/v1/referrals/${scannedReferralId}`, admin: true },
    {
      method: 'POST',
      url: `/admin/v1/referrals/${scannedReferralId}/reject`,
      admin: true,
      body: { reason: 'FRAUD', note: 'scan coverage for the rejection path' },
    },
    {
      method: 'POST',
      url: `/admin/v1/referrals/${scannedReferralId}/reinstate`,
      admin: true,
      body: { note: 'scan coverage for the reinstatement path' },
    },
    /**
     * M19's panel surface — every screen the admin SPA reads.
     *
     * This is the largest block of admin reads in the product and the one where a
     * Telegram identifier would be least surprising: a user detail page exists to
     * answer "who is this and what have they done", and the temptation to reach
     * one relation further is exactly what the scan is here to catch.
     */
    { method: 'GET', url: '/admin/v1/dashboard', admin: true },
    { method: 'GET', url: '/admin/v1/users', admin: true },
    { method: 'GET', url: '/admin/v1/users?query=میزبان&limit=5', admin: true },
    { method: 'GET', url: `/admin/v1/users/${hostPublicId}`, admin: true },
    { method: 'GET', url: '/admin/v1/events', admin: true },
    { method: 'GET', url: '/admin/v1/events?status=PUBLISHED&limit=5', admin: true },
    { method: 'GET', url: `/admin/v1/events/${eventPublicId}`, admin: true },
    {
      method: 'POST',
      url: `/admin/v1/events/${eventPublicId}/moderate`,
      admin: true,
      // Refuses after the first pass — a PUBLISHED event has nowhere to go from
      // PUBLISH — and a refusal body is a response worth scanning too.
      body: { action: 'PUBLISH', reason: 'scan coverage for the moderation path' },
    },
    { method: 'GET', url: '/admin/v1/reports', admin: true },
    { method: 'GET', url: '/admin/v1/reports?status=OPEN&targetType=EVENT', admin: true },
    {
      method: 'POST',
      url: '/admin/v1/reports/00000000-0000-4000-8000-000000000000/decide',
      admin: true,
      body: { status: 'DISMISSED', note: 'scan coverage' },
    },
    { method: 'GET', url: '/admin/v1/ledger', admin: true },
    { method: 'GET', url: `/admin/v1/ledger?userPublicId=${hostPublicId}`, admin: true },
    { method: 'GET', url: '/admin/v1/ledger/reconcile', admin: true },
    { method: 'GET', url: '/admin/v1/audit/search', admin: true },
    { method: 'GET', url: '/admin/v1/audit/search?action=giftcode.&limit=20', admin: true },
    { method: 'GET', url: '/admin/v1/settings', admin: true },
    {
      method: 'POST',
      url: '/admin/v1/settings/economy.boost_coins',
      admin: true,
      body: { value: 40, reason: 'scan coverage, restoring the documented default' },
    },
    { method: 'GET', url: '/admin/v1/me', admin: true },
    { method: 'GET', url: '/admin/v1/moderation/cases', admin: true },
    { method: 'GET', url: '/admin/v1/audit', admin: true },
    // Activity tags (M21).
    { method: 'GET', url: '/admin/v1/activity-tags', admin: true },
    { method: 'GET', url: '/admin/v1/places', admin: true },
    {
      /**
       * A fresh slug per call, through the function form of `body`.
       *
       * The scan runs the whole list once per leak pattern, and a fixed slug
       * would answer `CATALOG_SLUG_TAKEN` on every pass after the first — so
       * the *created* body, the one worth scanning, would be read once and the
       * rest of the passes would scan an error envelope.
       */
      method: 'POST',
      url: '/admin/v1/activity-tags',
      admin: true,
      body: () => ({ slug: `leak-scan-${randomUUID()}`, nameFa: 'پویش', icon: '🔎' }),
    },
    {
      method: 'PATCH',
      url: `/admin/v1/activity-tags/${scanTagId}`,
      admin: true,
      body: { nameFa: 'پویش نشتی' },
    },
    {
      method: 'POST',
      url: '/admin/v1/activity-tags/reorder',
      admin: true,
      body: { order: [scanTagId] },
    },
    {
      /**
       * 200 on the first pass and 404 afterwards, which is the same bargain the
       * chat-close and duplicate-join endpoints already make here: a refusal is
       * a response the scan wants to read, and only the GETs are held to
       * answering successfully at least once.
       */
      method: 'DELETE',
      url: `/admin/v1/activity-tags/${scanDoomedTagId}`,
      admin: true,
    },
    {
      method: 'POST',
      url: `/admin/v1/coins/adjust`,
      admin: true,
      body: {
        userPublicId: hostPublicId,
        amount: 5,
        reason: 'goodwill gesture',
        reference: 'leak-scan-adjust',
      },
    },
    {
      method: 'POST',
      url: `/admin/v1/chats/${chatPublicId}/unseal`,
      admin: true,
      body: { reason: 'investigating a reported safety concern' },
    },
    { method: 'GET', url: `/admin/v1/chats/unseal/${liveGrant.grantId}`, admin: true },
    {
      method: 'POST',
      url: '/admin/v1/moderation/cases/no-such-case/decide',
      admin: true,
      body: { decision: 'APPROVED', note: 'nothing to answer' },
    },
    {
      method: 'POST',
      url: '/admin/v1/trust/adjust',
      admin: true,
      body: {
        userPublicId: hostPublicId,
        delta: 1,
        reason: 'manual correction',
        reference: 'leak-scan-trust',
      },
    },
    {
      method: 'POST',
      url: `/admin/v1/users/${hostPublicId}/status`,
      admin: true,
      body: { status: 'ACTIVE', reason: 'no action needed' },
    },
    {
      method: 'POST',
      url: '/admin/v1/roles/requests',
      admin: true,
      body: {
        subjectAdminId: created.adminUserId,
        roleKey: 'MODERATOR',
        granting: true,
        reason: 'scan coverage',
      },
    },
    {
      method: 'POST',
      url: '/admin/v1/roles/requests/no-such-request/approve',
      admin: true,
    },
    // Anonymous: logging in is how a session is obtained, so it cannot need one.
    {
      method: 'POST',
      url: '/admin/v1/auth/login',
      anonymous: true,
      body: { email: 'leak-scan@payetam.test', password: 'wrong-password', totpCode: '000000' },
    },
    // Consumes the session it is given, so it gets one of its own each pass.
    {
      method: 'POST',
      url: '/admin/v1/auth/logout',
      admin: true,
      adminCookieFor: () => disposableAdmin[logoutIndex++] ?? 'already-spent',
    },
    // Last of all: it retires the viewer's event, and the passes that follow then
    // read the refusals — which are responses too.
    { method: 'POST', url: `/api/v1/events/${viewerEventPublicId}/cancel`, body: {} },
  );
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function fetchBody(endpoint: Endpoint): Promise<string> {
  const payload = typeof endpoint.body === 'function' ? endpoint.body() : endpoint.body;

  const headers =
    endpoint.anonymous === true
      ? {}
      : endpoint.admin === true
        ? {
            cookie: `${ADMIN_SESSION_COOKIE}=${endpoint.adminCookieFor?.() ?? adminCookie}`,
            'x-csrf-token': adminCsrf,
          }
        : { authorization: `Bearer ${accessToken}` };

  const response = await app.inject({
    method: endpoint.method,
    url: endpoint.url,
    headers,
    ...(payload === undefined ? {} : { payload }),
  });

  // A 5xx means the endpoint did not really answer, so scanning its body would be
  // scanning an error page and reporting a false clean.
  expect(
    response.statusCode,
    `${endpoint.method} ${endpoint.url} → ${response.body.slice(0, 500)}`,
  ).toBeLessThan(500);

  const key = `${endpoint.method} ${endpoint.url}`;
  statuses.set(key, [...(statuses.get(key) ?? []), response.statusCode]);
  return response.body;
}

/** Every status each endpoint answered with, across all the passes. */
const statuses = new Map<string, number[]>();

/**
 * The four shapes from §3.6, each a distinct failure.
 *
 * The Telegram-id pattern looks for exactly the fixture's id rather than for "any
 * nine-digit number", which would match a price, a timestamp or a count and make
 * the scan famous for crying wolf.
 */
const LEAK_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'the Telegram user id', pattern: new RegExp(String(TELEGRAM_USER_ID)) },
  {
    name: 'an @username',
    /**
     * A Telegram handle, not an email address.
     *
     * The lookbehind is what separates them: a handle appears after whitespace, a
     * quote or the start of a value, while an email has its local part pressed up
     * against the `@`. Without it this matched the domain of every address in every
     * response — which M12 surfaced the moment the admin API started returning a
     * staff member's own email to themselves. That is not a leak, and a detector
     * that calls it one gets silenced rather than fixed.
     */
    pattern: /(?<![\w.+-])@[A-Za-z0-9_]{5,32}\b/,
  },
  { name: 'a t.me link', pattern: /t\.me\//i },
  { name: 'a phone number', pattern: /(?:\+98|0)9\d{9}/ },
];

/**
 * The webhook is deliberately uncovered: it is authenticated by a secret token
 * rather than a session, answers 200 with an empty body by design (§3.1), and is
 * not a surface any user reads.
 */
const UNCOVERED_BY_DESIGN = /^POST \/telegram\/webhook\//;

/** Does a listed URL reach this route pattern? Query strings do not count. */
function reaches(pattern: string, url: string): boolean {
  const path = url.split('?')[0] ?? url;
  const escaped = pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`^${escaped.replaceAll(/:[^/]+/g, '[^/]+')}$`).test(path);
}

describe('the response-leak scan (§3.6 layer 5)', () => {
  /**
   * A scan that silently stops covering new endpoints is worse than no scan,
   * because it still reports green. Derived from the routes the application
   * actually registered rather than from a number somebody has to remember to
   * bump — which is how M9's five endpoints went uncovered while this test passed.
   */
  it('covers every endpoint the API exposes', () => {
    const uncovered = [...registeredRoutes]
      .filter((route) => !UNCOVERED_BY_DESIGN.test(route))
      .filter((route) => {
        const [method, ...rest] = route.split(' ');
        const pattern = rest.join(' ');
        return !ENDPOINTS.some(
          (endpoint) => endpoint.method === method && reaches(pattern, endpoint.url),
        );
      });

    expect(uncovered).toEqual([]);
    // The routes were collected at all, so an empty list means "nothing missing"
    // rather than "nothing looked at".
    expect(registeredRoutes.size).toBeGreaterThan(ENDPOINTS.length / 2);
  });

  it.each(LEAK_PATTERNS)('never returns $name', async ({ pattern }) => {
    const offenders: string[] = [];

    for (const endpoint of ENDPOINTS) {
      const body = await fetchBody(endpoint);
      if (pattern.test(body)) {
        offenders.push(`${endpoint.method} ${endpoint.url} → ${body.slice(0, 300)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The other way this scan can pass for the wrong reason.
   *
   * A regex that matches nothing is one failure mode; a *session* that stopped
   * working is the other. Every authenticated endpoint would then answer 401, and
   * four clean passes over twenty error envelopes would report green while
   * scanning none of the projections the whole exercise is about.
   *
   * Asserted on the reads, which have no legitimate reason to refuse. The writes
   * are deliberately excluded: several of them 409 by design on the later passes —
   * a chat closed by the pass before, a join that is already a duplicate — and
   * those refusals are responses the scan wants to read, not failures.
   */
  it('read a real session rather than a wall of refusals', () => {
    const refused = [...statuses.entries()]
      .filter(([key]) => key.startsWith('GET '))
      .filter(([, seen]) => !seen.some((status) => status < 400));

    expect(refused.map(([key]) => key)).toEqual([]);
    // `POST /auth/telegram` is the one write with a success path worth naming: it
    // is the endpoint that receives a Telegram id, so a 401 on every pass would
    // mean the id never entered the system and nothing was really tested.
    expect(statuses.get('POST /api/v1/auth/telegram')).toContain(200);
  });

  /**
   * A leak test's characteristic failure is a regex that matches nothing: it
   * looks exactly like a passing test. This asserts the detectors against the raw
   * row, so "clean" above means "searched and found nothing" rather than
   * "searched for nothing".
   */
  it('would catch a leak, if one were there', async () => {
    // The *leaky* account by id, not `findFirst`. Two accounts exist and only one
    // carries a username, so an unordered read can return the clean one — and the
    // detectors would then be asserted against a row with nothing in it to
    // detect, which passes for the wrong reason and fails for a worse one.
    const account = await prisma.telegramAccount.findUniqueOrThrow({
      where: { telegramUserId: TELEGRAM_USER_ID },
      select: { telegramUserId: true, usernameCached: true },
    });

    const raw = JSON.stringify({
      telegramUserId: String(account.telegramUserId),
      username: `@${account.usernameCached}`,
      link: `https://t.me/${account.usernameCached}`,
      phone: PHONE,
    });

    for (const { pattern } of LEAK_PATTERNS) {
      expect(pattern.test(raw)).toBe(true);
    }
  });

  /**
   * The chat's own version of the projection assertion above, stated as an exact
   * key set for the reason M5 gave: `not.toHaveProperty(…)` keeps passing when a
   * new column arrives, and the next leak is always a field nobody thought about.
   */
  it('describes a chat by alias and name, and gives the reader no other handle on anyone', async () => {
    const body = await fetchBody({
      method: 'GET',
      url: `/api/v1/chats/${chatPublicId}/messages`,
    });
    const parsed = JSON.parse(body) as {
      chat: Record<string, unknown>;
      messages: Record<string, unknown>[];
    };

    expect(Object.keys(parsed.chat).sort()).toEqual([
      'alias',
      'contactShared',
      'counterpartAlias',
      'counterpartContactShared',
      /**
       * M18, ADR-0014. The counterpart's **profile display name**, which titles the
       * conversation beside `eventTitle` and falls back to their alias when there is
       * no profile.
       *
       * Added here deliberately rather than by relaxing this assertion, because this
       * is the check that would otherwise have caught it: an exact key set is what
       * makes a new field on this projection a decision somebody had to make, and
       * this one is recorded in an ADR. What it is **not** is a Telegram identifier —
       * the pattern scan above still runs over this same body, and nothing here can
       * reach `telegram_account`.
       */
      'counterpartName',
      'createdAt',
      'eventPublicId',
      'eventTitle',
      'lastMessageAt',
      'publicId',
      'role',
      'status',
      'unreadCount',
    ]);

    const [first] = parsed.messages;
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'createdAt',
      'deletedAt',
      'editedAt',
      'kind',
      'mine',
      'redactionKinds',
      'senderAlias',
      'seq',
      'text',
    ]);
    // The counterpart is «میزبان» and nothing else — no id, no name, no handle.
    expect(first?.senderAlias).toBe('میزبان');
  });

  it('identifies the host by public id, display name and Trust Score, and nothing else', async () => {
    const body = await fetchBody({ method: 'GET', url: `/api/v1/events/${eventPublicId}` });
    const parsed = JSON.parse(body) as { host: Record<string, unknown> };

    // `trustScore` is M18's addition (ADR-0014): a number a guest is entitled to
    // before deciding whether to meet a stranger, and **only** the number — nothing
    // from `trust_score_ledger`, which is a record of specific incidents.
    expect(Object.keys(parsed.host).sort()).toEqual(['displayName', 'publicId', 'trustScore']);
  });

  /**
   * The host's queue, which is the other place a Trust Score now appears.
   *
   * Stated as an exact key set for the same reason as the two above: this endpoint
   * returns rows describing *other people* to somebody who is not them, and it is the
   * projection most likely to grow a field nobody thought about.
   */
  it('describes a requester by public id, display name and Trust Score, and nothing else', async () => {
    const body = await fetchBody({
      method: 'GET',
      url: `/api/v1/events/${viewerEventPublicId}/participants`,
    });
    const parsed = JSON.parse(body) as { participants: Record<string, unknown>[] };

    const [first] = parsed.participants;
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'displayName',
      'hostDeadlineAt',
      'publicId',
      'requestedAt',
      'status',
      'trustScore',
      'userPublicId',
      'waitlistRank',
    ]);
    // No birth year, no gender, no city. Hosting an event does not entitle somebody
    // to a stranger's profile because that stranger asked to come.
  });
});
