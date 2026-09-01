import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type {
  CostType,
  EventStatus,
  GenderPreference,
  PrismaClient,
  PrismaService,
} from '@payetam/db';
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
 * Discovery against a real database.
 *
 * Every property here is a property of Postgres rather than of TypeScript: the
 * tsvector the trigger fills, the trigram operator behind a typo match, and the
 * keyset predicate that has to survive rows being inserted mid-scan. Stubbing the
 * provider would prove none of them, so nothing is stubbed.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const provider = new PostgresSearchProvider(service, env);
const discovery = new DiscoveryService(service, clock, env, provider, settings);

let fixture: CatalogFixture;
let hostId: string;
let viewerId: string;

/** Well clear of NOW, so nothing is filtered out for having already started. */
const SOON = new Date('2026-08-20T14:00:00.000Z');

interface PublishOptions {
  title?: string;
  description?: string;
  cityId?: string;
  districtId?: string | null;
  categoryId?: string;
  startsAt?: Date;
  capacity?: number;
  acceptedCount?: number;
  costType?: CostType;
  costAmount?: number | null;
  genderPreference?: GenderPreference | null;
  minAge?: number | null;
  maxAge?: number | null;
  status?: EventStatus;
  deletedAt?: Date | null;
  publishedAt?: Date | null;
  hostUserId?: string;
}

let titleSequence = 0;

/**
 * An event as discovery expects to find it: PUBLISHED, undeleted, upcoming.
 *
 * Written straight to the table rather than through `EventService`, so a test can
 * put a row in a state the authoring path will not produce — HIDDEN, soft-deleted,
 * already started. The normalized columns are filled with the same `normalize`
 * the service uses, because the search-vector trigger reads those and nothing
 * else.
 */
async function publish(options: PublishOptions = {}): Promise<string> {
  titleSequence += 1;
  const title = options.title ?? `دورهمی شماره ${titleSequence}`;
  const description = options.description ?? 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';
  const startsAt = options.startsAt ?? SOON;

  const event = await prisma.event.create({
    data: {
      hostUserId: options.hostUserId ?? hostId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: options.categoryId ?? fixture.categoryId,
      cityId: options.cityId ?? fixture.tehranId,
      districtId: options.districtId ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000),
      capacity: options.capacity ?? 6,
      acceptedCount: options.acceptedCount ?? 0,
      costType: options.costType ?? 'FREE',
      costAmount: options.costAmount ?? null,
      genderPreference: options.genderPreference ?? null,
      minAge: options.minAge ?? null,
      maxAge: options.maxAge ?? null,
      status: options.status ?? 'PUBLISHED',
      moderationStatus: 'APPROVED',
      deletedAt: options.deletedAt ?? null,
      publishedAt: options.publishedAt ?? NOW,
    },
    select: { publicId: true },
  });

  return event.publicId;
}

async function idsFor(query: DiscoveryQuery = {}): Promise<string[]> {
  const page = await discovery.search(viewerId, query);
  return page.events.map((event) => event.publicId);
}

/** A user who has finished onboarding, so they can host and be a viewer. */
async function createProfiledUser(birthYear = 1995): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE');
  await prisma.userProfile.create({
    data: { userId, displayName: 'کاربر', cityId: fixture.tehranId, birthYear },
  });
  return userId;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  titleSequence = 0;
  fixture = await seedCatalog(prisma);
  hostId = await createProfiledUser();
  viewerId = await createProfiledUser();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('what discovery is allowed to show', () => {
  it('offers a published, undeleted, upcoming event', async () => {
    const wanted = await publish();
    await expect(idsFor()).resolves.toEqual([wanted]);
  });

  it.each<EventStatus>(['DRAFT', 'PENDING_MODERATION', 'HIDDEN', 'REJECTED', 'CANCELLED_BY_HOST'])(
    'hides a %s event',
    async (status) => {
      await publish({ status });
      await expect(idsFor()).resolves.toEqual([]);
    },
  );

  it('hides a soft-deleted event even though it is still PUBLISHED', async () => {
    await publish({ deletedAt: NOW });
    await expect(idsFor()).resolves.toEqual([]);
  });

  it('hides an event that has already started — discovery lists what you can still go to', async () => {
    await publish({ startsAt: new Date('2026-08-15T08:00:00.000Z') });
    await expect(idsFor()).resolves.toEqual([]);
  });
});

describe('each filter, on its own', () => {
  it('filters by city', async () => {
    const wanted = await publish({ cityId: fixture.tehranId });
    await publish({ cityId: fixture.karajId });

    await expect(idsFor({ cityId: fixture.tehranId })).resolves.toEqual([wanted]);
  });

  it('filters by district', async () => {
    const wanted = await publish({ districtId: fixture.tehranDistrictId });
    await publish({ districtId: null });

    await expect(idsFor({ districtId: fixture.tehranDistrictId })).resolves.toEqual([wanted]);
  });

  it('filters by category', async () => {
    const wanted = await publish({ categoryId: fixture.categoryId });
    await publish({ categoryId: fixture.retiredCategoryId });

    await expect(idsFor({ categoryId: fixture.categoryId })).resolves.toEqual([wanted]);
  });

  it('filters by dateFrom', async () => {
    await publish({ startsAt: new Date('2026-08-18T14:00:00.000Z') });
    const wanted = await publish({ startsAt: new Date('2026-08-25T14:00:00.000Z') });

    await expect(idsFor({ dateFrom: new Date('2026-08-20T00:00:00.000Z') })).resolves.toEqual([
      wanted,
    ]);
  });

  it('filters by dateTo', async () => {
    const wanted = await publish({ startsAt: new Date('2026-08-18T14:00:00.000Z') });
    await publish({ startsAt: new Date('2026-08-25T14:00:00.000Z') });

    await expect(idsFor({ dateTo: new Date('2026-08-20T00:00:00.000Z') })).resolves.toEqual([
      wanted,
    ]);
  });

  /**
   * The bands are read in Tehran, not UTC. 14:00 UTC is 17:30 Tehran — an
   * evening — and 06:00 UTC is 09:30 Tehran, a morning. Computing the band from
   * the stored UTC hour would put both in the wrong bucket, and the half-hour
   * offset is exactly what makes that bug invisible until someone checks.
   */
  it('filters by time of day in Tehran, not UTC', async () => {
    const evening = await publish({ startsAt: new Date('2026-08-20T14:00:00.000Z') });
    const morning = await publish({ startsAt: new Date('2026-08-20T06:00:00.000Z') });

    await expect(idsFor({ timeOfDay: 'EVENING' })).resolves.toEqual([evening]);
    await expect(idsFor({ timeOfDay: 'MORNING' })).resolves.toEqual([morning]);
  });

  it('filters by remaining capacity', async () => {
    const wanted = await publish({ capacity: 6, acceptedCount: 5 });
    await publish({ capacity: 6, acceptedCount: 6 });

    await expect(idsFor({ hasCapacity: true })).resolves.toEqual([wanted]);
  });

  it('filters by cost type', async () => {
    const wanted = await publish({ costType: 'FIXED', costAmount: 150_000 });
    await publish({ costType: 'FREE' });

    await expect(idsFor({ costType: 'FIXED' })).resolves.toEqual([wanted]);
  });

  it('filters by budget, and a free event satisfies any budget', async () => {
    const affordable = await publish({ costType: 'FIXED', costAmount: 100_000 });
    const free = await publish({ costType: 'FREE' });
    await publish({ costType: 'FIXED', costAmount: 900_000 });

    const ids = await idsFor({ costMax: 200_000 });
    expect(new Set(ids)).toEqual(new Set([affordable, free]));
  });

  it('filters by gender preference', async () => {
    const wanted = await publish({ genderPreference: 'FEMALE_ONLY' });
    await publish({ genderPreference: null });

    await expect(idsFor({ genderPreference: 'FEMALE_ONLY' })).resolves.toEqual([wanted]);
  });
});

describe('ageFits is answered from the server’s copy of the profile', () => {
  it('keeps events whose age range the viewer fits, and drops the rest', async () => {
    // The viewer is born in 1995, so 31 in 2026 by the admitting-direction rule.
    const fits = await publish({ minAge: 25, maxAge: 40 });
    const open = await publish({ minAge: null, maxAge: null });
    await publish({ minAge: 18, maxAge: 25 });

    const ids = await idsFor({ ageFits: true });
    expect(new Set(ids)).toEqual(new Set([fits, open]));
  });

  /**
   * The age is never taken from the request, so there is no parameter to lie in.
   * This is invariant 9 for the one filter that looks like a policy decision:
   * claiming to be 19 must not reach an event with `min_age = 19`.
   */
  it('refuses ageFits for a viewer with no profile rather than silently returning everything', async () => {
    const anonymous = await createUser(prisma, 'TERMS_ACCEPTED');
    await publish({ minAge: 18 });

    await expect(discovery.search(anonymous, { ageFits: true })).rejects.toMatchObject({
      code: 'PROFILE_INCOMPLETE',
    });
  });
});

describe('Persian text search', () => {
  it('matches a query typed with Arabic yeh and kaf against a title typed with Persian ones', async () => {
    const wanted = await publish({ title: 'کلاس یوگا در پارک' });
    await publish({ title: 'شب شعر و موسیقی' });

    // ك U+0643 and ي U+064A — the Arabic forms, which a phone keyboard emits.
    await expect(idsFor({ q: 'كلاس يوگا' })).resolves.toEqual([wanted]);
  });

  it('matches across a half-space, which is a word boundary and not a letter', async () => {
    const wanted = await publish({ title: 'برنامهٔ کوه‌پیمایی آخر هفته' });
    await publish({ title: 'شب شعر و موسیقی' });

    await expect(idsFor({ q: 'کوه پیمایی' })).resolves.toEqual([wanted]);
  });

  it('matches a word from the description, not only the title', async () => {
    const wanted = await publish({ description: 'یک شب برای بازی شطرنج و گفتگو.' });
    await publish({ description: 'یک برنامهٔ پیاده‌روی صبحگاهی.' });

    await expect(idsFor({ q: 'شطرنج' })).resolves.toEqual([wanted]);
  });

  it('returns nothing for a query that matches nothing, rather than everything', async () => {
    await publish({ title: 'کلاس یوگا در پارک' });

    await expect(idsFor({ q: 'سفالگری' })).resolves.toEqual([]);
  });

  it('ignores a query that normalizes away to nothing', async () => {
    const wanted = await publish();

    // Punctuation and whitespace only: there is no term to search for, so this is
    // an unfiltered browse rather than a search that matches nothing.
    await expect(idsFor({ q: '  ‌  ' })).resolves.toEqual([wanted]);
  });
});

describe('keyset pagination', () => {
  /**
   * The property the plan singles out, and the reason this is keyset and not
   * OFFSET: with OFFSET, a row inserted between two pages shifts everything after
   * it, so page 2 repeats a row page 1 already showed and skips one it never
   * will.
   */
  it('has no duplicates and no gaps while rows are inserted mid-scan', async () => {
    const original: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      original.push(await publish({ startsAt: new Date(Date.UTC(2026, 7, 20 + index, 14, 0, 0)) }));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await discovery.search(viewerId, {
        sort: 'SOONEST',
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.events.map((event) => event.publicId));
      cursor = page.nextCursor;
      pages += 1;

      // A new event lands between every pair of pages, sorting into the middle of
      // the range being scanned — the case that breaks OFFSET.
      await publish({ startsAt: new Date(Date.UTC(2026, 7, 22, 12, pages, 0)) });
    } while (cursor !== undefined && pages < 10);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(original));
  });

  it('walks the whole set exactly once when nothing changes', async () => {
    const published: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      published.push(
        await publish({ startsAt: new Date(Date.UTC(2026, 7, 20 + index, 14, 0, 0)) }),
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const page = await discovery.search(viewerId, {
        sort: 'SOONEST',
        limit: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      seen.push(...page.events.map((event) => event.publicId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toEqual(published);
  });

  it('does not offer a cursor on the last page', async () => {
    await publish();
    const page = await discovery.search(viewerId, { limit: 20 });

    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it('refuses a cursor issued for a different sort order', async () => {
    await publish();
    await publish();

    const first = await discovery.search(viewerId, { sort: 'SOONEST', limit: 1 });
    expect(first.nextCursor).toBeDefined();

    await expect(
      discovery.search(viewerId, { sort: 'RELEVANCE', cursor: first.nextCursor as string }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('clamps an oversized limit rather than rejecting it', async () => {
    for (let index = 0; index < 3; index += 1) await publish();

    const page = await discovery.search(viewerId, { limit: 500 });
    expect(page.events).toHaveLength(3);
  });
});

describe('a brand-new host', () => {
  /**
   * Plan §11 puts new hosts in a neutral trust bucket rather than a low one. A
   * ranking that treated "no history" as "bad" would make the first event any
   * host writes unfindable, which is the cold-start failure the neutral bucket
   * exists to prevent.
   */
  it('still reaches page 1 for a matching query', async () => {
    const established = await createProfiledUser();
    for (let index = 0; index < 25; index += 1) {
      await publish({
        hostUserId: established,
        title: 'کلاس یوگا با میزبان قدیمی',
        startsAt: new Date(Date.UTC(2026, 7, 21 + (index % 5), 14, 0, 0)),
      });
    }

    const newcomer = await createProfiledUser();
    const theirs = await publish({
      hostUserId: newcomer,
      title: 'کلاس یوگا با میزبان تازه',
      startsAt: SOON,
    });

    const page = await discovery.search(viewerId, { q: 'کلاس یوگا', limit: 20 });
    expect(page.events.map((event) => event.publicId)).toContain(theirs);
  });

  it('scores the same on trust as everyone else, and explain-rank says so', async () => {
    const newcomer = await createProfiledUser();
    const theirs = await publish({ hostUserId: newcomer });
    const mine = await publish({ hostUserId: hostId });

    const [newHost, oldHost] = await Promise.all([
      discovery.explainRank(viewerId, theirs),
      discovery.explainRank(viewerId, mine),
    ]);

    expect(newHost.components.trust).toBe(oldHost.components.trust);
    expect(newHost.components.trust).toBeGreaterThan(0);
  });

  /**
   * The neutral bucket is the *configured starting score*, not an invented
   * constant.
   *
   * Two copies of that number would eventually disagree — a host ranking as
   * though they had 50 while their profile showed something else — which is the
   * bug `RankingWeights.neutralTrust` exists to make impossible.
   */
  it('ranks at the configured starting score, not at zero', async () => {
    await prisma.appSetting.create({ data: { key: 'trust.initial_score', value: 80 } });
    const newcomer = await createProfiledUser();
    const theirs = await publish({ hostUserId: newcomer });

    const explained = await discovery.explainRank(viewerId, theirs);
    expect(explained.components.trust).toBeCloseTo(0.8, 5);
  });
});

/**
 * M9 turned the trust term from a constant into a column read.
 *
 * Until this milestone every host scored 0.5 whatever they had done, so the term
 * was configurable and visible but carried no information. These are the tests
 * that would fail if it silently went back to being a constant — which is the
 * regression worth guarding, because a ranking that ignores reputation looks
 * exactly like one that uses it.
 */
describe('the trust term reads the score (plan §11)', () => {
  async function setScore(userId: string, score: number): Promise<void> {
    await prisma.trustScore.create({ data: { userId, score, algoVersion: 1 } });
  }

  it('reports the host’s own score, normalised to 0–1', async () => {
    await setScore(hostId, 90);
    const publicId = await publish({ hostUserId: hostId });

    const explained = await discovery.explainRank(viewerId, publicId);
    expect(explained.components.trust).toBeCloseTo(0.9, 5);
  });

  it('puts a trusted host above an untrusted one, all else equal', async () => {
    const trusted = await createProfiledUser();
    const untrusted = await createProfiledUser();
    await setScore(trusted, 100);
    await setScore(untrusted, 0);

    // Same title, same start, same district — so trust is the only term that
    // differs and the ordering is attributable to it alone.
    const theirs = await publish({ hostUserId: trusted, title: 'کارگاه سفالگری' });
    const others = await publish({ hostUserId: untrusted, title: 'کارگاه سفالگری' });

    const page = await discovery.search(viewerId, { q: 'کارگاه سفالگری', limit: 10 });
    const ids = page.events.map((event) => event.publicId);
    expect(ids.indexOf(theirs)).toBeLessThan(ids.indexOf(others));
  });

  /**
   * Trust is capped at a tenth of the signal (plan §12), so a spotless host does
   * not bury a better-matched event. The cap is the resolution of "reputation in
   * ranking" against "no unfair discrimination", and it only holds if the weight
   * is actually applied to the term rather than the term standing alone.
   */
  it('cannot outweigh a much sooner event', async () => {
    const trusted = await createProfiledUser();
    await setScore(trusted, 100);
    await setScore(hostId, 0);

    const soonest = await publish({
      hostUserId: hostId,
      title: 'کارگاه سفالگری',
      startsAt: new Date(NOW.getTime() + 6 * 3_600_000),
    });
    await publish({
      hostUserId: trusted,
      title: 'کارگاه سفالگری',
      startsAt: new Date(NOW.getTime() + 40 * 24 * 3_600_000),
    });

    const page = await discovery.search(viewerId, { q: 'کارگاه سفالگری', limit: 10 });
    expect(page.events[0]?.publicId).toBe(soonest);
  });
});

describe('the detail endpoint', () => {
  it('returns a published event by its public id', async () => {
    const publicId = await publish();
    const event = await discovery.findPublished(publicId);

    expect(event.publicId).toBe(publicId);
  });

  it('still returns an event that has already started, unlike the list', async () => {
    const publicId = await publish({ startsAt: new Date('2026-08-15T08:00:00.000Z') });

    await expect(idsFor()).resolves.toEqual([]);
    await expect(discovery.findPublished(publicId)).resolves.toMatchObject({ publicId });
  });

  it.each<EventStatus>(['PENDING_MODERATION', 'HIDDEN', 'REJECTED'])(
    'is a 404 for a %s event even to someone holding the id',
    async (status) => {
      const publicId = await publish({ status });

      await expect(discovery.findPublished(publicId)).rejects.toMatchObject({
        code: 'EVENT_NOT_FOUND',
      });
    },
  );

  it('gives the same error for an id that does not exist, so it is not an existence oracle', async () => {
    await expect(
      discovery.findPublished('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });
});

describe('the projection (plan §3.6, invariant 7)', () => {
  /**
   * An allowlist asserted as an exact set, not a "does not contain" check. The
   * difference matters: `not.toHaveProperty('hostUserId')` keeps passing when a
   * new column arrives, and the next leak is always a column nobody thought
   * about.
   */
  it('returns exactly the allowlisted fields and nothing else', async () => {
    await publish({ districtId: fixture.tehranDistrictId });
    const page = await discovery.search(viewerId, {});
    const event = page.events[0];

    expect(event).toBeDefined();
    expect(Object.keys(event as object).sort()).toEqual(
      [
        'acceptedCount',
        'boostedUntil',
        'capacity',
        'categoryId',
        'categoryNameFa',
        'categorySlug',
        'cityId',
        'cityNameFa',
        'citySlug',
        'costAmount',
        'costNote',
        'costType',
        // M21: the host's own words for a «سایر»-style tag. Public by
        // construction — it is the label a stranger reads on the card in place
        // of the category name.
        'customCategoryLabel',
        'description',
        'districtId',
        // v0.6.5: the neighbourhood a host typed, when the district catalogue —
        // which is empty in every deployment — had no row to pick. Public by
        // construction, exactly like `customCategoryLabel`: it is the place name
        // a stranger reads on the card.
        'districtLabel',
        'districtNameFa',
        'districtSlug',
        'endsAt',
        'externalLink',
        'genderPreference',
        'hostDisplayName',
        'hostPublicId',
        // M18: the host's reputation, nullable — never coalesced to the neutral
        // score the way the ranking term is (ADR-0014).
        'hostTrustScore',
        'isVip',
        'maxAge',
        'minAge',
        'publicId',
        'publishedAt',
        'sortKey',
        'startsAt',
        'title',
      ].sort(),
    );
  });

  it('never carries the host’s internal id, the event’s internal id, or the moderation status', async () => {
    await publish();
    const page = await discovery.search(viewerId, {});
    const serialized = JSON.stringify(page.events);

    expect(serialized).not.toContain(hostId);
    expect(page.events[0]).not.toHaveProperty('id');
    expect(page.events[0]).not.toHaveProperty('hostUserId');
    expect(page.events[0]).not.toHaveProperty('moderationStatus');
    expect(page.events[0]).not.toHaveProperty('titleNormalized');
  });
});
