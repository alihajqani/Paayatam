import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import { SessionService, normalize } from '@payetam/domain';
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

interface Endpoint {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  /** Endpoints that answer without a session; the rest are sent one. */
  anonymous?: boolean;
  /** Sent as JSON for the endpoints that read one. */
  body?: unknown;
}

/**
 * Every endpoint a client can reach.
 *
 * The Telegram webhook is deliberately absent: it is authenticated by a secret
 * token rather than a session, answers 200 with an empty body by design (§3.1),
 * and is not a surface any user reads.
 */
const ENDPOINTS: Endpoint[] = [
  { method: 'GET', url: '/health', anonymous: true },
  { method: 'GET', url: '/ready', anonymous: true },
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
    select: { id: true },
  });

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
    select: { publicId: true },
  });
  viewerParticipantPublicId = viewerRequest.publicId;

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

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // Minted through the application's own SessionService, so the token is signed
  // with the same secret the guard verifies against.
  const sessions = app.get(SessionService);
  const tokens = await sessions.issue(user.publicId, user.onboardingState);
  accessToken = tokens.accessToken;

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
    { method: 'POST', url: `/api/v1/participants/${viewerParticipantPublicId}/cancel`, body: {} },
  );
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

async function fetchBody(endpoint: Endpoint): Promise<string> {
  const response = await app.inject({
    method: endpoint.method,
    url: endpoint.url,
    ...(endpoint.anonymous === true ? {} : { headers: { authorization: `Bearer ${accessToken}` } }),
    ...(endpoint.body === undefined ? {} : { payload: endpoint.body }),
  });

  // A 5xx means the endpoint did not really answer, so scanning its body would be
  // scanning an error page and reporting a false clean.
  expect(
    response.statusCode,
    `${endpoint.method} ${endpoint.url} → ${response.body.slice(0, 500)}`,
  ).toBeLessThan(500);
  return response.body;
}

/**
 * The four shapes from §3.6, each a distinct failure.
 *
 * The Telegram-id pattern looks for exactly the fixture's id rather than for "any
 * nine-digit number", which would match a price, a timestamp or a count and make
 * the scan famous for crying wolf.
 */
const LEAK_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'the Telegram user id', pattern: new RegExp(String(TELEGRAM_USER_ID)) },
  { name: 'an @username', pattern: /@[A-Za-z0-9_]{5,32}\b/ },
  { name: 'a t.me link', pattern: /t\.me\//i },
  { name: 'a phone number', pattern: /(?:\+98|0)9\d{9}/ },
];

describe('the response-leak scan (§3.6 layer 5)', () => {
  it('covers every endpoint the API exposes', () => {
    // A scan that silently stops covering new endpoints is worse than no scan,
    // because it still reports green. This fails when a route is added without
    // being listed here.
    expect(ENDPOINTS).toHaveLength(17);
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
   * A leak test's characteristic failure is a regex that matches nothing: it
   * looks exactly like a passing test. This asserts the detectors against the raw
   * row, so "clean" above means "searched and found nothing" rather than
   * "searched for nothing".
   */
  it('would catch a leak, if one were there', async () => {
    const account = await prisma.telegramAccount.findFirst({
      select: { telegramUserId: true, usernameCached: true },
    });

    const raw = JSON.stringify({
      telegramUserId: String(account?.telegramUserId),
      username: `@${account?.usernameCached}`,
      link: `https://t.me/${account?.usernameCached}`,
      phone: PHONE,
    });

    for (const { pattern } of LEAK_PATTERNS) {
      expect(pattern.test(raw)).toBe(true);
    }
  });

  it('identifies the host by public id and display name only', async () => {
    const body = await fetchBody({ method: 'GET', url: `/api/v1/events/${eventPublicId}` });
    const parsed = JSON.parse(body) as { host: Record<string, unknown> };

    expect(Object.keys(parsed.host).sort()).toEqual(['displayName', 'publicId']);
  });
});
