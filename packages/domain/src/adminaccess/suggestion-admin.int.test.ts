import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock, type RedisService } from '@payetam/platform';
import type { CreateEventSuggestionRequest } from '@payetam/shared';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  TEST_CHAT_ENCRYPTION_KEY,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { AdminAccessService, permissionsFor, type AdminSession } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { ROLE_KEYS } from './permissions';
import { SuggestionAdminService } from './suggestion-admin.service';

/**
 * The operator's side of event suggestions (migration 0064), against a real
 * database: the permission is checked in the service (ADR-0010 rule 2), every
 * write leaves an audit row, and the panel is handed the exact `?start=host_`
 * link to paste — the one thing in a channel post a person cannot type right.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-10-01T09:00:00.000Z');
const clock = new FakeClock(NOW);
const audit = new AuditService(service, clock);
const credentials = new AdminCredentials({
  CHAT_ENCRYPTION_KEY: TEST_CHAT_ENCRYPTION_KEY,
} as never);
const redis = { client: {} } as unknown as RedisService;
const access = new AdminAccessService(service, clock, redis, credentials, audit);
const env = { TELEGRAM_BOT_USERNAME: 'payetam_bot' } as unknown as Env;
const suggestionAdmin = new SuggestionAdminService(service, clock, env, access, audit);

let fixture: CatalogFixture;
let SUPER: AdminSession;
let ANALYST: AdminSession;

async function sessionFor(role: 'SUPER_ADMIN' | 'ANALYST'): Promise<AdminSession> {
  const email = `${role.toLowerCase()}@payetam.test`;
  const row = await prisma.adminUser.create({
    data: {
      email,
      passwordHash: 'not-used-in-this-suite',
      totpSecretEnc: 'not-used-in-this-suite',
      displayName: role,
    },
    select: { id: true },
  });
  return {
    adminUserId: row.id,
    email,
    displayName: role,
    roles: [ROLE_KEYS[role]],
    permissions: permissionsFor([ROLE_KEYS[role]]),
  };
}

function request(
  overrides: Partial<CreateEventSuggestionRequest> = {},
): CreateEventSuggestionRequest {
  return {
    cityId: fixture.tehranId,
    categoryId: fixture.categoryId,
    title: 'اکران فیلم در هویزه',
    description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
    venueLabel: 'سینما هویزه',
    startsAt: '2026-10-09T16:00:00.000Z',
    durationHours: 2,
    capacity: 4,
    costType: 'FREE',
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  fixture = await seedCatalog(prisma);
  SUPER = await sessionFor('SUPER_ADMIN');
  ANALYST = await sessionFor('ANALYST');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('SuggestionAdminService.create', () => {
  it('stores the suggestion and hands back what the link is built from', async () => {
    const view = await suggestionAdmin.create(SUPER, request());

    expect(view).toMatchObject({
      title: 'اکران فیلم در هویزه',
      cityNameFa: 'تهران',
      isOpen: true,
      eventCount: 0,
      startsAt: '2026-10-09T16:00:00.000Z',
    });
    // The panel builds the `t.me` URL itself: an API response carries no
    // `t.me` link (response-leak scan), exactly as the catalog hands the Mini
    // App a bot username rather than a link.
    expect(view.startPayload).toBe(`host_${view.publicId}`);
    await expect(prisma.eventSuggestion.count()).resolves.toBe(1);
  });

  it('writes an audit row', async () => {
    const view = await suggestionAdmin.create(SUPER, request());

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'suggestion.created' } });
    expect(row.actorId).toBe(SUPER.adminUserId);
    expect(row.after).toMatchObject({ publicId: view.publicId });
  });

  it('refuses a session without suggestion.manage', async () => {
    await expect(suggestionAdmin.create(ANALYST, request())).rejects.toThrow();
    await expect(prisma.eventSuggestion.count()).resolves.toBe(0);
  });

  /** A link that opens on «شهر هنوز باز نیست» is a post nobody can act on. */
  it('refuses a city that is not open', async () => {
    await expect(
      suggestionAdmin.create(SUPER, request({ cityId: fixture.karajId })),
    ).rejects.toThrow();
  });

  it('refuses a category the wizard would not accept', async () => {
    await expect(
      suggestionAdmin.create(SUPER, request({ categoryId: fixture.retiredCategoryId })),
    ).rejects.toThrow();
  });

  it('refuses a programme that has already started', async () => {
    await expect(
      suggestionAdmin.create(SUPER, request({ startsAt: '2026-10-01T08:00:00.000Z' })),
    ).rejects.toThrow();
  });
});

describe('SuggestionAdminService.list', () => {
  it('counts the events each suggestion produced', async () => {
    const view = await suggestionAdmin.create(SUPER, request());
    const row = await prisma.eventSuggestion.findUniqueOrThrow({
      where: { publicId: view.publicId },
    });
    const host = await createUser(prisma, 'PROFILE_COMPLETE');
    await prisma.event.create({
      data: {
        hostUserId: host,
        suggestionId: row.id,
        title: 'اکران فیلم در هویزه',
        description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
        titleNormalized: 'اکران',
        descriptionNormalized: 'سانس',
        categoryId: fixture.categoryId,
        cityId: fixture.tehranId,
        startsAt: row.startsAt,
        endsAt: new Date(row.startsAt.getTime() + 7_200_000),
        capacity: 4,
        costType: 'FREE',
        status: 'PUBLISHED',
        moderationStatus: 'APPROVED',
        publishedAt: NOW,
      },
    });

    const listed = await suggestionAdmin.list(SUPER);

    expect(listed.botUsername).toBe('payetam_bot');
    expect(listed.suggestions).toHaveLength(1);
    expect(listed.suggestions[0]).toMatchObject({ publicId: view.publicId, eventCount: 1 });
  });

  /**
   * The form's two pickers offer exactly what `create` accepts — open cities and
   * categories a host could pick — so the panel needs no second endpoint and
   * cannot offer a choice the service then refuses.
   */
  it('offers the cities and categories the form may use', async () => {
    const listed = await suggestionAdmin.list(SUPER);

    expect(listed.cities.map((city) => city.id)).toContain(fixture.tehranId);
    expect(listed.cities.map((city) => city.id)).not.toContain(fixture.karajId);
    expect(listed.categories.map((category) => category.id)).toContain(fixture.categoryId);
    expect(listed.categories.map((category) => category.id)).not.toContain(
      fixture.retiredCategoryId,
    );
  });

  it('refuses a session without suggestion.manage', async () => {
    await expect(suggestionAdmin.list(ANALYST)).rejects.toThrow();
  });
});

describe('SuggestionAdminService.close', () => {
  it('closes it, so the link stops opening the wizard', async () => {
    const view = await suggestionAdmin.create(SUPER, request());

    const closed = await suggestionAdmin.close(SUPER, view.publicId);

    expect(closed.isOpen).toBe(false);
    expect(closed.closedAt).toBe(NOW.toISOString());
    await expect(prisma.auditLog.count({ where: { action: 'suggestion.closed' } })).resolves.toBe(
      1,
    );
  });

  it('is a no-op the second time, with no second audit row', async () => {
    const view = await suggestionAdmin.create(SUPER, request());
    await suggestionAdmin.close(SUPER, view.publicId);

    await suggestionAdmin.close(SUPER, view.publicId);

    await expect(prisma.auditLog.count({ where: { action: 'suggestion.closed' } })).resolves.toBe(
      1,
    );
  });

  it('refuses a session without suggestion.manage', async () => {
    const view = await suggestionAdmin.create(SUPER, request());

    await expect(suggestionAdmin.close(ANALYST, view.publicId)).rejects.toThrow();
  });
});
