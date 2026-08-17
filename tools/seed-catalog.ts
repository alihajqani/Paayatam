/**
 * Seeds the catalog and the policy numbers M3 reads.
 *
 * The catalog is admin-managed data (plan §3.3), and the admin panel that manages
 * it arrives in M12. Until then this script is how a developer gets a database
 * that onboarding can actually run against — and how CI gets one for the
 * integration tests.
 *
 * Idempotent by slug: re-running updates names and ordering in place rather than
 * creating a second Tehran. Ids are therefore stable across runs, which matters
 * because profiles reference them.
 *
 * Deliberately does NOT deactivate rows it does not know about. Someone who added
 * a city through the admin panel should not lose it because a developer ran a
 * seed.
 *
 * Refuses to run in production without the M17 rail, for the same reason
 * seed-policies does: placeholder data in front of real users is worse than a
 * failed script.
 */
import { openSeed } from './seed-guard';

/** Launch is Tehran only (plan §2). Other cities exist but stay inactive. */
const CITIES = [
  {
    slug: 'tehran',
    nameFa: 'تهران',
    isActive: true,
    sortOrder: 0,
    districts: [
      { slug: 'district-1', nameFa: 'منطقه ۱', sortOrder: 1 },
      { slug: 'district-2', nameFa: 'منطقه ۲', sortOrder: 2 },
      { slug: 'district-3', nameFa: 'منطقه ۳', sortOrder: 3 },
      { slug: 'district-4', nameFa: 'منطقه ۴', sortOrder: 4 },
      { slug: 'district-5', nameFa: 'منطقه ۵', sortOrder: 5 },
      { slug: 'district-6', nameFa: 'منطقه ۶', sortOrder: 6 },
      { slug: 'district-7', nameFa: 'منطقه ۷', sortOrder: 7 },
      { slug: 'district-8', nameFa: 'منطقه ۸', sortOrder: 8 },
      { slug: 'district-22', nameFa: 'منطقه ۲۲', sortOrder: 22 },
    ],
  },
  // Present so "an inactive city is rejected" is exercisable against real data,
  // and so expansion is a flag flip rather than a migration.
  { slug: 'karaj', nameFa: 'کرج', isActive: false, sortOrder: 10, districts: [] },
  { slug: 'isfahan', nameFa: 'اصفهان', isActive: false, sortOrder: 20, districts: [] },
];

/** Two categories at launch (plan §2); the rest wait behind `is_active`. */
const CATEGORIES = [
  {
    slug: 'cafe-boardgames',
    nameFa: 'کافه و بازی رومیزی',
    icon: '🎲',
    isActive: true,
    sortOrder: 1,
  },
  { slug: 'outdoor', nameFa: 'طبیعت‌گردی سبک', icon: '🥾', isActive: true, sortOrder: 2 },
  { slug: 'sports', nameFa: 'ورزش', icon: '⚽', isActive: false, sortOrder: 3 },
  { slug: 'learning', nameFa: 'یادگیری', icon: '📚', isActive: false, sortOrder: 4 },
];

const INTERESTS = [
  { slug: 'board-games', nameFa: 'بازی رومیزی', category: 'cafe-boardgames', sortOrder: 1 },
  { slug: 'coffee', nameFa: 'قهوه', category: 'cafe-boardgames', sortOrder: 2 },
  { slug: 'card-games', nameFa: 'بازی با ورق', category: 'cafe-boardgames', sortOrder: 3 },
  { slug: 'chess', nameFa: 'شطرنج', category: 'cafe-boardgames', sortOrder: 4 },
  { slug: 'hiking', nameFa: 'کوه‌پیمایی', category: 'outdoor', sortOrder: 5 },
  { slug: 'cycling', nameFa: 'دوچرخه‌سواری', category: 'outdoor', sortOrder: 6 },
  { slug: 'walking', nameFa: 'پیاده‌روی', category: 'outdoor', sortOrder: 7 },
  { slug: 'photography', nameFa: 'عکاسی', category: 'outdoor', sortOrder: 8 },
  { slug: 'football', nameFa: 'فوتبال', category: 'sports', sortOrder: 9 },
  { slug: 'volleyball', nameFa: 'والیبال', category: 'sports', sortOrder: 10 },
  { slug: 'running', nameFa: 'دویدن', category: 'sports', sortOrder: 11 },
  { slug: 'book-club', nameFa: 'باشگاه کتاب', category: 'learning', sortOrder: 12 },
  { slug: 'language-exchange', nameFa: 'تبادل زبان', category: 'learning', sortOrder: 13 },
  { slug: 'music', nameFa: 'موسیقی', category: null, sortOrder: 14 },
  { slug: 'cooking', nameFa: 'آشپزی', category: null, sortOrder: 15 },
];

/**
 * Policy numbers, mirroring plan §11. The application falls back to the same
 * values when a row is missing (`SETTING_DEFAULTS`), so seeding these does not
 * change behaviour — it makes them editable without a deploy, which is the whole
 * point of `app_setting` (ADR-0007).
 */
const SETTINGS: { key: string; value: number }[] = [
  { key: 'economy.onboarding_reward_coins', value: 50 },
  { key: 'profile.min_age_years', value: 18 },
];

async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'seed.catalog',
    'This writes cities, districts, categories and interests that users pick from.',
  );

  for (const city of CITIES) {
    const { districts, ...cityData } = city;
    const row = await prisma.city.upsert({
      where: { slug: city.slug },
      create: cityData,
      update: cityData,
    });

    for (const district of districts) {
      await prisma.district.upsert({
        where: { cityId_slug: { cityId: row.id, slug: district.slug } },
        create: { ...district, cityId: row.id, isActive: true },
        update: { ...district, isActive: true },
      });
    }

    console.log(
      `city ${city.slug} (${city.isActive ? 'active' : 'inactive'}) · ${districts.length} districts`,
    );
  }

  const categoryIdBySlug = new Map<string, string>();
  for (const category of CATEGORIES) {
    const row = await prisma.category.upsert({
      where: { slug: category.slug },
      create: category,
      update: category,
    });
    categoryIdBySlug.set(category.slug, row.id);
  }
  console.log(`${CATEGORIES.length} categories`);

  for (const interest of INTERESTS) {
    const { category, ...interestData } = interest;
    const categoryId = category === null ? null : (categoryIdBySlug.get(category) ?? null);
    await prisma.interest.upsert({
      where: { slug: interest.slug },
      create: { ...interestData, categoryId, isActive: true },
      update: { ...interestData, categoryId, isActive: true },
    });
  }
  console.log(`${INTERESTS.length} interests`);

  for (const setting of SETTINGS) {
    // `create` only: an operator who has tuned a number in production must not
    // have it silently reset by a developer running a seed.
    const existing = await prisma.appSetting.findUnique({ where: { key: setting.key } });
    if (existing) {
      console.log(`setting ${setting.key} already set (${JSON.stringify(existing.value)}) — kept`);
      continue;
    }
    await prisma.appSetting.create({ data: { key: setting.key, value: setting.value } });
    console.log(`setting ${setting.key} = ${setting.value}`);
  }

  await finish({
    cities: CITIES.length,
    categories: CATEGORIES.length,
    interests: INTERESTS.length,
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
