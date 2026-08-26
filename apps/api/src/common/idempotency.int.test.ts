import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@payetam/db';
import { SessionService } from '@payetam/domain';
import {
  TEST_CHAT_ENCRYPTION_KEY,
  createTestPrisma,
  grantCoins,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';

/**
 * `Idempotency-Key`, against the real HTTP surface (plan §6, acceptance criterion 21).
 *
 * > A replayed `Idempotency-Key` returns the identical stored response.
 *
 * Driven through `app.inject` rather than by calling the interceptor directly,
 * because everything worth asserting here is a property of the request path: that a
 * replay never reaches the service, that a *failed* attempt leaves nothing behind,
 * and that one caller's key cannot reach another caller's stored response.
 *
 * `POST /events` is the subject because its side effect is countable — an event row
 * either exists once or twice, and no amount of interpretation changes that.
 */

process.env['TELEGRAM_BOT_TOKEN'] ??= '1234567890:LOCAL-DEV-ONLY-NOT-A-REAL-TOKEN-0001';
process.env['CHAT_ENCRYPTION_KEY'] ??= TEST_CHAT_ENCRYPTION_KEY;
process.env['JWT_ACCESS_SECRET'] ??= 'a'.repeat(48);
process.env['JWT_REFRESH_SECRET'] ??= 'b'.repeat(48);

const prisma: PrismaClient = createTestPrisma();

let app: NestFastifyApplication;
let sessions: SessionService;
let fixture: CatalogFixture;

beforeAll(async () => {
  // The compiled module: NestJS DI reads `design:paramtypes`, which `tsc` emits and
  // the test runner's transform does not (ADR-0013).
  const { AppModule } = (await import('../../dist/app.module.js')) as { AppModule: unknown };

  app = await NestFactory.create<NestFastifyApplication>(
    AppModule as Parameters<typeof NestFactory.create>[0],
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
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

let telegramId = 880_000_000n;

/** A user who has finished onboarding, and a bearer token for them. */
async function signedInUser(): Promise<{ token: string; userId: string }> {
  telegramId += 1n;
  const user = await prisma.user.create({
    data: {
      onboardingState: 'PROFILE_COMPLETE',
      telegramAccount: { create: { telegramUserId: telegramId } },
      profile: {
        create: {
          displayName: 'میزبان',
          birthYear: 1995,
          cityId: fixture.tehranId,
        },
      },
    },
  });

  // Creating an event costs coins from M22 (phase 5), and this user was written
  // straight to the table rather than through onboarding — so the grant that
  // funds a real account never ran. Enough for several events, because this
  // suite is about the header rather than about affordability.
  await grantCoins(prisma, user.id, 500);

  const tokens = await sessions.issue(user.publicId, 'PROFILE_COMPLETE');
  return { token: tokens.accessToken, userId: user.id };
}

function eventBody(title = 'شب بازی رومیزی'): Record<string, unknown> {
  const startsAt = new Date(Date.now() + 5 * 24 * 3_600_000);
  return {
    title,
    description: 'یک شب بازی دوستانه برای آزمودن کلید یکتاسازی درخواست.',
    categoryId: fixture.categoryId,
    cityId: fixture.tehranId,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
    capacity: 4,
    costType: 'SPLIT',
  };
}

async function createEvent(
  token: string,
  body: Record<string, unknown>,
  key?: string,
): Promise<{ status: number; body: string; replayed: string | undefined }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/events',
    headers: {
      authorization: `Bearer ${token}`,
      ...(key !== undefined ? { 'idempotency-key': key } : {}),
    },
    payload: body,
  });

  return {
    status: response.statusCode,
    body: response.body,
    replayed: response.headers['idempotency-replayed'] as string | undefined,
  };
}

describe('Idempotency-Key — replay', () => {
  it('returns the identical stored response and performs the work once', async () => {
    const { token, userId } = await signedInUser();
    const body = eventBody();

    const first = await createEvent(token, body, 'key-1');
    const second = await createEvent(token, body, 'key-1');

    expect(first.status).toBe(201);
    // Criterion 21, stated exactly: identical.
    expect(second.status).toBe(first.status);
    expect(second.body).toBe(first.body);
    expect(second.replayed).toBe('true');
    expect(first.replayed).toBeUndefined();

    // The part a stored response could otherwise hide.
    const events = await prisma.event.count({ where: { hostUserId: userId } });
    expect(events).toBe(1);
  });

  it('stores exactly one row for the pair', async () => {
    const { token, userId } = await signedInUser();
    await createEvent(token, eventBody(), 'key-2');
    await createEvent(token, eventBody(), 'key-2');

    const rows = await prisma.requestIdempotency.count({ where: { userId } });
    expect(rows).toBe(1);
  });
});

describe('Idempotency-Key — honesty', () => {
  it('refuses the same key carrying a different request', async () => {
    const { token } = await signedInUser();
    await createEvent(token, eventBody('شب بازی رومیزی'), 'key-3');

    const different = await createEvent(token, eventBody('کوهنوردی صبحگاهی'), 'key-3');

    // Answering with the first response would compound a client bug rather than
    // report it.
    expect(different.status).toBe(409);
    expect(JSON.parse(different.body).error.code).toBe('CONFLICT_STALE_VERSION');
  });

  it('does not let one caller replay another caller key', async () => {
    const first = await signedInUser();
    const second = await signedInUser();
    const body = eventBody();

    await createEvent(first.token, body, 'shared-key');
    const other = await createEvent(second.token, body, 'shared-key');

    expect(other.status).toBe(201);
    expect(other.replayed).toBeUndefined();
    expect(await prisma.event.count({ where: { hostUserId: second.userId } })).toBe(1);
  });

  it('leaves a rejected request retryable', async () => {
    const { token, userId } = await signedInUser();

    // `capacity: 0` is below the schema's floor, so this never reaches the service.
    const rejected = await createEvent(token, { ...eventBody(), capacity: 0 }, 'key-4');
    expect(rejected.status).toBeGreaterThanOrEqual(400);

    // The same key must still work: a network blip must not pin a user to an error.
    const retried = await createEvent(token, eventBody(), 'key-4');
    expect(retried.status).toBe(201);
    expect(retried.replayed).toBeUndefined();
    expect(await prisma.event.count({ where: { hostUserId: userId } })).toBe(1);
  });
});

describe('Idempotency-Key — absent', () => {
  it('changes nothing when no key is sent', async () => {
    const { token, userId } = await signedInUser();

    const first = await createEvent(token, eventBody());
    const second = await createEvent(token, eventBody());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.replayed).toBeUndefined();
    // Two deliberate requests are two events. The header is what expresses "these
    // are the same intention"; without it there is nothing to infer from.
    expect(await prisma.event.count({ where: { hostUserId: userId } })).toBe(2);
    expect(await prisma.requestIdempotency.count({ where: { userId } })).toBe(0);
  });
});
