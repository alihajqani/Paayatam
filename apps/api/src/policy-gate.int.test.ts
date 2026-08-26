import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import { SessionService } from '@payetam/domain';
import { MetricsRegistry } from '@payetam/platform';
import { registerObservability } from './common/observability';
import {
  TEST_CHAT_ENCRYPTION_KEY,
  createTestPrisma,
  grantCoins,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../test/integration/db';

/**
 * The re-acceptance gate, over HTTP (M22 phase 8).
 *
 * The requirement it exists for is *"ensure API routes enforce acceptance where
 * required; do not rely only on the UI"* — so this deliberately never touches the
 * Mini App's router. It publishes a new version behind a signed-in user's back and
 * then calls the endpoints directly, which is exactly what a client that skipped
 * the screen would do.
 *
 * Two halves matter equally:
 *
 *  - A **protected write** is refused with `POLICY_VERSION_STALE`, not with the
 *    generic `TERMS_NOT_ACCEPTED` a first-time user gets. The two are different
 *    situations and lead to different screens.
 *  - **Reads stay open.** A user who has to accept new terms must still be able to
 *    fetch them and see their own profile, or the gate locks them away from the
 *    thing it is asking them to do.
 */

process.env['NODE_ENV'] ??= 'test';
process.env['TELEGRAM_BOT_TOKEN'] ??= '123456789:AAF-payetam-policy-gate-test-token-x';
process.env['CHAT_ENCRYPTION_KEY'] ??= TEST_CHAT_ENCRYPTION_KEY;
process.env['PII_HASH_PEPPER'] ??= TEST_CHAT_ENCRYPTION_KEY;
process.env['JWT_ACCESS_SECRET'] ??= 'a'.repeat(48);
process.env['JWT_REFRESH_SECRET'] ??= 'b'.repeat(48);

const prisma: PrismaClient = createTestPrisma();

let app: NestFastifyApplication;
let sessions: SessionService;
let fixture: CatalogFixture;

beforeAll(async () => {
  // The compiled module: NestJS DI reads `design:paramtypes`, which `tsc` emits and
  // the test runner's transform does not (ADR-0013).
  const { AppModule } = (await import('../dist/app.module.js')) as { AppModule: unknown };

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  // The same hook `main.ts` installs. Registered here because one of the
  // assertions below is that an acceptance carries the request id — which only
  // exists because `onRequest` opens the async context the controller reads from.
  // A harness without it would test the controller against a context that is
  // always empty, and pass for the wrong reason.
  registerObservability(app, app.get(MetricsRegistry));

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  sessions = app.get(SessionService);
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase(prisma);
  fixture = await seedCatalog(prisma);
});

const CONTENT = 'ماده ۱. متن آزمایشی برای این نسخه. '.repeat(4);

async function publish(type: 'TERMS' | 'PRIVACY', version: number): Promise<string> {
  // Written straight to the table rather than through `PolicyAdminService`: this
  // suite is about the *gate*, and going through the admin API would need a staff
  // session, a TOTP secret and a cookie for no additional coverage.
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
      contentMd: CONTENT,
    },
    select: { id: true },
  });
  return row.id;
}

let telegramId = 990_000_000n;

async function signedInUser(): Promise<{ token: string; userId: string }> {
  telegramId += 1n;
  const user = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: telegramId } },
      profile: { create: { displayName: 'کاربر', birthYear: 1995, cityId: fixture.tehranId } },
    },
  });
  // Creating an event costs coins from M22 (phase 5).
  await grantCoins(prisma, user.id, 500);

  const tokens = await sessions.issue(user.publicId, 'PROFILE_COMPLETE');
  return { token: tokens.accessToken, userId: user.id };
}

async function acceptCurrent(token: string): Promise<number> {
  const current = await prisma.policyVersion.findMany({
    where: { isCurrent: true, type: { in: ['TERMS', 'PRIVACY'] } },
    select: { id: true },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/onboarding/consent',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { policyVersionIds: current.map((row) => row.id) },
  });
  return response.statusCode;
}

function eventBody(title = 'شب بازی رومیزی'): Record<string, unknown> {
  const startsAt = new Date(Date.now() + 5 * 24 * 3_600_000);
  return {
    title,
    description: 'یک شب بازی دوستانه برای آزمودن دروازهٔ پذیرش قوانین.',
    categoryId: fixture.categoryId,
    cityId: fixture.tehranId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    capacity: 4,
    costType: 'SPLIT',
  };
}

async function createEvent(token: string, title?: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: eventBody(title),
  });
  return {
    status: response.statusCode,
    code: (JSON.parse(response.body) as { error?: { code?: string } }).error?.code,
  };
}

describe('the re-acceptance gate', () => {
  /**
   * The state a fresh deployment is in, and the one that broke the product.
   *
   * `hasAcceptedCurrentPolicies` returned `false` when nothing was published,
   * which `AuthGuard` turns into `POLICY_VERSION_STALE` — so on any deployment
   * whose legal text was still in draft, **every gated write was refused for
   * every user**, and the refusal told them to go and re-read a document that did
   * not exist. It also disagreed with `/me/policies`, which correctly reported
   * nothing pending.
   *
   * Both halves are asserted here, because the bug was the two disagreeing.
   */
  it('does not gate on a document nobody has published', async () => {
    // `resetDatabase` truncates `policy_version`, so this is genuinely empty.
    const { token } = await signedInUser();

    await expect(createEvent(token)).resolves.toMatchObject({ status: 201 });

    const standing = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(standing.statusCode).toBe(200);
    expect((JSON.parse(standing.body) as { pending: unknown[] }).pending).toEqual([]);
  });

  it('gates again the moment a required document is published', async () => {
    // The other direction of the same fix: `true` on empty must not become
    // "the gate is off", only "there is nothing to be stale about".
    const { token } = await signedInUser();
    await expect(createEvent(token)).resolves.toMatchObject({ status: 201 });

    await publish('TERMS', 1);
    await publish('PRIVACY', 1);

    await expect(createEvent(token, 'رویداد دوم')).resolves.toMatchObject({
      status: 403,
      code: 'POLICY_VERSION_STALE',
    });
    await expect(acceptCurrent(token)).resolves.toBe(200);
    await expect(createEvent(token, 'رویداد سوم')).resolves.toMatchObject({ status: 201 });
  });

  it('lets a user through once they have accepted the current versions', async () => {
    await publish('TERMS', 1);
    await publish('PRIVACY', 1);
    const { token } = await signedInUser();

    await expect(acceptCurrent(token)).resolves.toBe(200);
    await expect(createEvent(token)).resolves.toMatchObject({ status: 201 });
  });

  it('refuses a protected write after a new version is published', async () => {
    await publish('TERMS', 1);
    await publish('PRIVACY', 1);
    const { token } = await signedInUser();
    await acceptCurrent(token);

    // Published behind the user's back — which is exactly the situation.
    await publish('TERMS', 2);

    const refused = await createEvent(token, 'شب بازی دوم');
    expect(refused.status).toBe(403);
    // Not TERMS_NOT_ACCEPTED: that one means "you have never accepted anything",
    // and it leads to a different screen.
    expect(refused.code).toBe('POLICY_VERSION_STALE');
  });

  it('keeps reads open while the gate is closed', async () => {
    await publish('TERMS', 1);
    await publish('PRIVACY', 1);
    const { token } = await signedInUser();
    await acceptCurrent(token);
    await publish('TERMS', 2);

    // A user being asked to accept must still be able to fetch what they are
    // being asked to accept, and to see their own account.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);

    const standing = await app.inject({
      method: 'GET',
      url: '/api/v1/me/policies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(standing.statusCode).toBe(200);
    const body = JSON.parse(standing.body) as {
      pending: { label: string }[];
      accepted: { policy: { label: string } }[];
    };
    expect(body.pending.map((policy) => policy.label)).toEqual(['TERMS v2']);
    expect(body.accepted.map((entry) => entry.policy.label)).toEqual(['PRIVACY v1']);
  });

  it('opens again as soon as the new version is accepted', async () => {
    await publish('TERMS', 1);
    await publish('PRIVACY', 1);
    const { token } = await signedInUser();
    await acceptCurrent(token);
    await publish('TERMS', 2);

    await expect(createEvent(token, 'قبل از پذیرش')).resolves.toMatchObject({ status: 403 });
    await expect(acceptCurrent(token)).resolves.toBe(200);
    await expect(createEvent(token, 'پس از پذیرش')).resolves.toMatchObject({ status: 201 });
  });

  it('records the re-acceptance as REACCEPT, with the request id', async () => {
    await publish('TERMS', 1);
    await publish('PRIVACY', 1);
    const { token, userId } = await signedInUser();
    await acceptCurrent(token);
    await publish('TERMS', 2);
    await acceptCurrent(token);

    const rows = await prisma.consent.findMany({
      where: { userId },
      orderBy: { acceptedAt: 'asc' },
    });
    expect(rows).toHaveLength(3);
    const reaccept = rows.find((row) => row.context === 'REACCEPT');
    expect(reaccept?.policyVersionLabel).toBe('TERMS v2');
    // Every request gets one, generated when the client does not supply it.
    expect(reaccept?.requestId).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
  });
});
