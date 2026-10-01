import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { SuggestionService } from './suggestion.service';

/**
 * What a tap on a suggestion link should open, against a real database.
 *
 * The rule is "the first person hosts, the rest go with them" (plan, «اولی
 * میزبان، بقیه همراه»): two readers tapping the same screening should end up at
 * one event with two people, not at two events with one each. Every branch is a
 * query over real rows — status, start, seats, host — so each is asserted here
 * rather than against a mock that would agree with the code.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-10-01T09:00:00.000Z');
const clock = new FakeClock(NOW);
const suggestions = new SuggestionService(service, clock);

/** 19:30 in Tehran (UTC+03:30) on 9 October — a time the hour buttons cannot say. */
const STARTS_AT = new Date('2026-10-09T16:00:00.000Z');

let fixture: CatalogFixture;
let provinceId: string;
let readerId: string;

async function suggestion(overrides: { closedAt?: Date; startsAt?: Date } = {}) {
  return prisma.eventSuggestion.create({
    data: {
      cityId: fixture.tehranId,
      categoryId: fixture.categoryId,
      title: 'اکران فیلم در هویزه',
      description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
      venueLabel: 'سینما هویزه',
      startsAt: overrides.startsAt ?? STARTS_AT,
      durationHours: 2,
      capacity: 4,
      costType: 'APPROX',
      costAmount: 150_000,
      externalLink: 'https://cinematicket.org/',
      createdByAdminId: 'admin-1',
      closedAt: overrides.closedAt ?? null,
    },
  });
}

async function eventFrom(
  suggestionId: string,
  hostUserId: string,
  overrides: { acceptedCount?: number; status?: 'PUBLISHED' | 'CANCELLED_BY_HOST' } = {},
) {
  return prisma.event.create({
    data: {
      hostUserId,
      suggestionId,
      title: 'اکران فیلم در هویزه',
      description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
      titleNormalized: 'اکران فیلم در هویزه',
      descriptionNormalized: 'سانس هفت و نیم',
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: STARTS_AT,
      endsAt: new Date(STARTS_AT.getTime() + 2 * 3_600_000),
      capacity: 4,
      acceptedCount: overrides.acceptedCount ?? 0,
      costType: 'FREE',
      status: overrides.status ?? 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  const province = await prisma.province.create({ data: { slug: 'tehran-p', nameFa: 'تهران' } });
  provinceId = province.id;
  await prisma.city.update({ where: { id: fixture.tehranId }, data: { provinceId } });
  readerId = await createUser(prisma, 'PROFILE_COMPLETE');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SuggestionService.resolveLink', () => {
  it('offers to host when nobody has yet', async () => {
    const row = await suggestion();

    const link = await suggestions.resolveLink(row.publicId, readerId);

    expect(link.kind).toBe('host');
    if (link.kind === 'host') {
      expect(link.suggestion).toMatchObject({
        publicId: row.publicId,
        title: 'اکران فیلم در هویزه',
        venueLabel: 'سینما هویزه',
        cityNameFa: 'تهران',
      });
    }
  });

  it('sends the second reader to the first host’s event', async () => {
    const row = await suggestion();
    const firstHost = await createUser(prisma, 'PROFILE_COMPLETE');
    const event = await eventFrom(row.id, firstHost);

    const link = await suggestions.resolveLink(row.publicId, readerId);

    expect(link).toMatchObject({ kind: 'join', eventPublicId: event.publicId });
  });

  it('offers to host again once that event is full', async () => {
    const row = await suggestion();
    const firstHost = await createUser(prisma, 'PROFILE_COMPLETE');
    await eventFrom(row.id, firstHost, { acceptedCount: 4 });

    expect((await suggestions.resolveLink(row.publicId, readerId)).kind).toBe('host');
  });

  it('ignores an event that is no longer live', async () => {
    const row = await suggestion();
    const firstHost = await createUser(prisma, 'PROFILE_COMPLETE');
    await eventFrom(row.id, firstHost, { status: 'CANCELLED_BY_HOST' });

    expect((await suggestions.resolveLink(row.publicId, readerId)).kind).toBe('host');
  });

  it('shows a host their own event rather than a second copy of it', async () => {
    const row = await suggestion();
    const own = await eventFrom(row.id, readerId);

    expect(await suggestions.resolveLink(row.publicId, readerId)).toEqual({
      kind: 'own',
      eventPublicId: own.publicId,
    });
  });

  it('is gone when closed, started, or never existed', async () => {
    const closed = await suggestion({ closedAt: NOW });
    const started = await suggestion({ startsAt: new Date(NOW.getTime() - 60_000) });

    expect((await suggestions.resolveLink(closed.publicId, readerId)).kind).toBe('gone');
    expect((await suggestions.resolveLink(started.publicId, readerId)).kind).toBe('gone');
    expect(
      (await suggestions.resolveLink('11111111-1111-4111-8111-111111111111', readerId)).kind,
    ).toBe('gone');
  });
});

describe('SuggestionService.wizardForm', () => {
  /**
   * Everything the event wizard asks, answered — in Tehran's wall clock, since
   * that is what the day and hour buttons mean (ADR-0008).
   */
  it('answers every core question, at the minute', async () => {
    const row = await suggestion();

    expect(await suggestions.wizardForm(row.publicId)).toEqual({
      title: 'اکران فیلم در هویزه',
      description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
      categoryId: fixture.categoryId,
      provinceId,
      cityId: fixture.tehranId,
      districtLabel: 'سینما هویزه',
      day: '2026-10-09',
      hour: 19,
      startMinute: 30,
      durationHours: 2,
      capacity: 4,
      costType: 'APPROX',
      costAmount: 150_000,
      externalLink: 'https://cinematicket.org/',
      suggestionId: row.id,
    });
  });

  it('is null for a suggestion that is gone', async () => {
    const closed = await suggestion({ closedAt: NOW });

    expect(await suggestions.wizardForm(closed.publicId)).toBeNull();
  });
});
