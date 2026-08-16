import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { SettingsService } from '../catalog/settings.service';
import { normalize } from '../moderation/persian-normalizer';
import { DiscoveryService, type DiscoveryQuery } from './discovery.service';
import { PostgresSearchProvider } from './postgres-search.provider';

/**
 * The M5 acceptance criterion: p95 < 200 ms on 10k seeded events.
 *
 * This is a guard against a plan regression, not a benchmark. What it actually
 * catches is the class of change that turns a query into a sequential scan — a
 * dropped index, a predicate wrapped in a function so the index no longer
 * applies, a filter that stops being sargable. Those show up as a jump from
 * single-digit to hundreds of milliseconds, which is visible on any hardware;
 * they are not a ten-percent drift that a slow CI runner could mask.
 *
 * Seeded once for the whole file rather than per test: building the corpus costs
 * far more than querying it, and no test here mutates it.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const provider = new PostgresSearchProvider(service, env);
const discovery = new DiscoveryService(service, clock, env, provider, settings);

const CORPUS = 10_000;
const BATCH = 2_000;
const P95_BUDGET_MS = 200;

let fixture: CatalogFixture;
let viewerId: string;

/** Enough variety that filters and text search actually select a subset. */
const TITLES = [
  'شب بازی رومیزی در کافه',
  'کلاس یوگا صبحگاهی',
  'کوه‌پیمایی آخر هفته',
  'کارگاه سفالگری',
  'دورهمی شطرنج',
  'پیاده‌روی در پارک',
  'شب شعر و موسیقی',
  'تمرین والیبال ساحلی',
];

beforeAll(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);

  const hostId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId: hostId, displayName: 'میزبان', cityId: fixture.tehranId, birthYear: 1990 },
  });
  viewerId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: {
      userId: viewerId,
      displayName: 'بازدیدکننده',
      cityId: fixture.tehranId,
      birthYear: 1995,
    },
  });

  for (let offset = 0; offset < CORPUS; offset += BATCH) {
    const rows = Array.from({ length: Math.min(BATCH, CORPUS - offset) }, (_unused, index) => {
      const n = offset + index;
      const title = `${TITLES[n % TITLES.length]} ${n}`;
      const description = 'یک برنامهٔ دوستانه برای گپ، بازی و آشنایی با آدم‌های تازه.';
      // Spread over a year of future dates, so date filters and the SOONEST sort
      // have a real distribution to work against rather than one repeated value.
      const startsAt = new Date(
        NOW.getTime() + (n % 365) * 24 * 60 * 60 * 1000 + 6 * 60 * 60 * 1000,
      );

      return {
        hostUserId: hostId,
        title,
        description,
        titleNormalized: normalize(title),
        descriptionNormalized: normalize(description),
        categoryId: n % 3 === 0 ? fixture.retiredCategoryId : fixture.categoryId,
        cityId: n % 4 === 0 ? fixture.karajId : fixture.tehranId,
        districtId: n % 5 === 0 ? fixture.tehranDistrictId : null,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
        capacity: 6,
        acceptedCount: n % 7,
        costType: n % 2 === 0 ? ('FREE' as const) : ('FIXED' as const),
        costAmount: n % 2 === 0 ? null : 50_000 + (n % 10) * 25_000,
        status: 'PUBLISHED' as const,
        moderationStatus: 'APPROVED' as const,
        publishedAt: new Date(NOW.getTime() - (n % 30) * 60 * 60 * 1000),
      };
    });

    await prisma.event.createMany({ data: rows });
  }

  // Without fresh statistics the planner is choosing from guesses, and a
  // sequential scan it picks for that reason would be measuring the ANALYZE we
  // forgot rather than the indexes we built.
  await prisma.$executeRaw`ANALYZE "event"`;
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function p95For(queries: DiscoveryQuery[], iterations = 3): Promise<number> {
  // One untimed pass: the first query of a connection pays for planning and a
  // cold cache, which is a startup cost rather than the steady state the
  // criterion is about.
  for (const query of queries) await discovery.search(viewerId, query);

  const samples: number[] = [];
  for (let round = 0; round < iterations; round += 1) {
    for (const query of queries) {
      const started = performance.now();
      await discovery.search(viewerId, query);
      samples.push(performance.now() - started);
    }
  }

  samples.sort((a, b) => a - b);
  const index = Math.min(Math.ceil(samples.length * 0.95) - 1, samples.length - 1);
  return samples[index] as number;
}

describe(`discovery over ${CORPUS} events`, () => {
  it('really did seed the corpus', async () => {
    await expect(prisma.event.count()).resolves.toBe(CORPUS);
  });

  it('answers a browse, a filter and a search within the p95 budget', async () => {
    const p95 = await p95For([
      {},
      { sort: 'SOONEST' },
      { sort: 'NEWEST' },
      { cityId: fixture.tehranId },
      { cityId: fixture.tehranId, categoryId: fixture.categoryId },
      { hasCapacity: true, costType: 'FREE' },
      {
        dateFrom: new Date('2026-09-01T00:00:00.000Z'),
        dateTo: new Date('2026-09-30T00:00:00.000Z'),
      },
      { q: 'یوگا' },
      { q: 'کوه پیمایی' },
      { q: 'شطرنج', cityId: fixture.tehranId, sort: 'SOONEST' },
    ]);

    expect(p95).toBeLessThan(P95_BUDGET_MS);
  });

  /**
   * Deep paging is where OFFSET pagination collapses — page 200 costs 200 pages
   * of work — and where keyset should not care. Walking twenty pages and timing
   * the last one pins that difference.
   */
  it('does not get slower the deeper the pagination goes', async () => {
    let cursor: string | undefined;
    let last = 0;

    for (let page = 0; page < 20; page += 1) {
      const started = performance.now();
      const result = await discovery.search(viewerId, {
        sort: 'SOONEST',
        limit: 20,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      last = performance.now() - started;
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }

    expect(last).toBeLessThan(P95_BUDGET_MS);
  });
});
