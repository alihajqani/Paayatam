import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@payetam/db';

/**
 * The integration-test database harness.
 *
 * Nothing transactional is ever mocked (README, ADR-0006, ADR-0007). Capacity
 * locking, ledger immutability and the exactly-once reward are properties of
 * Postgres, so a test that stubs Postgres proves nothing about them. These tests
 * therefore talk to a real database — `make up` locally, a service container in
 * CI — and this file is the only place that knows how to reach it.
 */

/**
 * `TEST_DATABASE_URL` first, so a developer's seeded database is not the one
 * being truncated. `setup.ts` explains the fallback and warns about it.
 */
export function createTestPrisma(): PrismaClient {
  const connectionString = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('No test database URL is set; see test/integration/setup.ts');
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: TEST_POOL_SIZE }),
  });
}

/**
 * Connections per test client, capped well below Postgres's default 100.
 *
 * Every integration file builds its own client, and the driver's default pool is
 * `cpus * 2 + 1` — thirty-three on a sixteen-core machine. Vitest keeps finished
 * workers alive, so three or four live clients exhaust the server, and the failure
 * does not look like exhaustion: `TRUNCATE` in a `beforeEach` fails, the fixture
 * is left stale, and the tests that follow fall over on foreign keys pointing at
 * rows the reset never removed. Two hours of that reads as a logic bug in
 * whatever milestone happened to add the file that tipped it over.
 *
 * Ten is comfortably above what any single file needs. The concurrency suites
 * (twenty simultaneous joins, ten simultaneous referral settlements) queue at the
 * pool instead of at Postgres, which changes nothing they assert: they contend on
 * row locks, and the lock is the thing under test.
 */
const TEST_POOL_SIZE = 10;

/**
 * Empties every table, in one statement.
 *
 * TRUNCATE rather than DELETE, and not only for speed: `coin_ledger`, `consent`
 * and `audit_log` carry BEFORE DELETE triggers that raise. Those triggers are
 * row-level, and TRUNCATE does not fire row-level triggers — so the append-only
 * guarantee stays fully armed for the tests that assert it, while cleanup still
 * works.
 *
 * A tagged template with nothing interpolated, not `$executeRawUnsafe`. Building
 * the list at runtime would read identically to the injection pattern CI grep
 * hunts for, and "it was only a constant" is exactly what the next person to
 * copy it will also believe.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`
    TRUNCATE TABLE
      "outbox_event", "moderation_case", "chat_action", "chat_message",
      "chat_participant", "chat_unseal_grant", "anonymous_chat",
      "review_pair", "review", "report", "role_change_request",
      "admin_user_role", "role_permission", "permission", "role", "admin_user",
      "event_participant", "event", "blacklist_term",
      "blacklist_version", "user_interest", "user_profile", "referral",
      "trust_score_ledger", "trust_score", "coin_ledger",
      "coin_account", "consent", "telegram_account", "audit_log", "user",
      "policy_version", "interest", "category", "district", "city",
      "app_setting", "feature_flag"
    RESTART IDENTITY CASCADE
  `;
}

/**
 * A throwaway 32-byte key for the tests that need `MessageCipher`.
 *
 * Fixed rather than random so a failure is reproducible, and shared from here
 * rather than copied into each suite so nobody invents a 16-byte one and spends
 * an afternoon on the resulting AES error. It is not a secret and never leaves
 * the test process — real keys come from `CHAT_ENCRYPTION_KEY` (ADR-0009).
 */
export const TEST_CHAT_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

export interface CatalogFixture {
  tehranId: string;
  tehranDistrictId: string;
  /** Inactive: the city that must be refused. */
  karajId: string;
  /** Active city, but its district must not be pairable with Tehran. */
  karajDistrictId: string;
  categoryId: string;
  /** Exists but is deactivated, so it must not be selectable for an event. */
  retiredCategoryId: string;
  boardGamesId: string;
  hikingId: string;
  /** Exists but is deactivated — offered by nobody, accepted by nothing. */
  retiredInterestId: string;
}

/**
 * The smallest catalog that can exercise every rejection path: an active city
 * with a district, an inactive city, a district belonging to the wrong city, two
 * usable interests and one retired one.
 */
export async function seedCatalog(prisma: PrismaClient): Promise<CatalogFixture> {
  const tehran = await prisma.city.create({
    data: {
      slug: 'tehran',
      nameFa: 'تهران',
      isActive: true,
      districts: { create: [{ slug: 'district-1', nameFa: 'منطقه ۱' }] },
    },
    include: { districts: true },
  });

  const karaj = await prisma.city.create({
    data: {
      slug: 'karaj',
      nameFa: 'کرج',
      isActive: false,
      districts: { create: [{ slug: 'karaj-central', nameFa: 'مرکز' }] },
    },
    include: { districts: true },
  });

  const category = await prisma.category.create({
    data: { slug: 'cafe-boardgames', nameFa: 'کافه و بازی رومیزی', isActive: true },
  });

  const retiredCategory = await prisma.category.create({
    data: { slug: 'retired-category', nameFa: 'بازنشسته', isActive: false },
  });

  const [boardGames, hiking, retired] = await Promise.all([
    prisma.interest.create({
      data: { slug: 'board-games', nameFa: 'بازی رومیزی', categoryId: category.id },
    }),
    prisma.interest.create({ data: { slug: 'hiking', nameFa: 'کوه‌پیمایی' } }),
    prisma.interest.create({ data: { slug: 'retired', nameFa: 'بازنشسته', isActive: false } }),
  ]);

  const tehranDistrict = tehran.districts[0];
  const karajDistrict = karaj.districts[0];
  if (!tehranDistrict || !karajDistrict) {
    throw new Error('district fixture was not created');
  }

  return {
    tehranId: tehran.id,
    tehranDistrictId: tehranDistrict.id,
    karajId: karaj.id,
    karajDistrictId: karajDistrict.id,
    categoryId: category.id,
    retiredCategoryId: retiredCategory.id,
    boardGamesId: boardGames.id,
    hikingId: hiking.id,
    retiredInterestId: retired.id,
  };
}

let telegramIdSequence = 100_000n;

/**
 * A user at a chosen point in onboarding.
 *
 * Returns the internal id, because that is what domain services take. Nothing
 * outside a test may do this — the internal id never leaves the backend
 * (invariant 7) — which is precisely why it is worth having in one helper rather
 * than inlined in every test.
 */
export async function createUser(
  prisma: PrismaClient,
  onboardingState: 'NEW' | 'TERMS_ACCEPTED' | 'PROFILE_COMPLETE' = 'TERMS_ACCEPTED',
): Promise<string> {
  telegramIdSequence += 1n;
  const user = await prisma.user.create({
    data: {
      onboardingState,
      telegramAccount: { create: { telegramUserId: telegramIdSequence } },
    },
  });
  return user.id;
}
