/**
 * Seeds the catalog and the policy numbers M3 reads.
 *
 * The catalog is admin-managed data (plan §3.3). Since M21 the **activity tags**
 * really are manageable from the panel (پنل مدیریت → سیستم → تفریحات); interests
 * and districts still are not. Either way this script is how a developer gets a
 * database onboarding can run against, how CI gets one for the integration
 * tests, and what every environment starts from before anybody edits anything.
 *
 * The division of labour, stated once: **the seed is the floor and the panel is
 * the delta.** Which is why the "does not deactivate what it does not know
 * about" rule below matters — a tag somebody added in production must survive a
 * developer running this.
 *
 * Idempotent by slug: re-running updates names and ordering in place rather than
 * creating a second row. Ids are therefore stable across runs, which matters
 * because profiles and events reference them.
 *
 * **Cities and provinces are not here.** They moved to `pnpm seed:geography` in
 * M21, where 1,252 generated rows belong; what stays is the hand-authored part —
 * Tehran's districts, the activity categories and the interests.
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

/**
 * Districts, by the slug of the city they belong to.
 *
 * Cities themselves moved to `seed:geography` in M21 — 1,252 of them arrive from
 * a generated dataset and do not belong in a file a human hand-edits. Districts
 * stayed here because they are exactly that: hand-authored, Tehran-only, and the
 * thing somebody will want to edit next.
 */
const DISTRICTS: Record<string, { slug: string; nameFa: string; sortOrder: number }[]> = {
  tehran: [
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
};

/**
 * تفریحات — the activity categories a host files an event under.
 *
 * Two were active at launch and the rest waited behind `is_active` (plan §2).
 * M21 opens the list up, because gating activities made sense while the product
 * served one city and stops making sense the moment it serves 1,252: a host in
 * بندرعباس has no کافه و بازی رومیزی scene to file under, and telling them their
 * activity does not exist is how a marketplace fails to start in a new city.
 *
 * **`other` is the escape hatch, and it is deliberately last.** `allowsCustomLabel`
 * lets the host type what they are actually doing, which lands in
 * `event.custom_category_label` and is blacklist-scanned like the title. Its
 * `sortOrder` of 999 is not decoration — a catch-all offered first is a catch-all
 * everybody picks, and the categories below it would stop collecting anything.
 *
 * Ids are stable across runs because the upsert key is `slug`, and events
 * reference category ids — so renaming a `nameFa` here is safe and changing a
 * `slug` is not.
 */
const CATEGORIES = [
  // The two that shipped at launch. Slugs unchanged: live events point at them.
  {
    slug: 'cafe-boardgames',
    nameFa: 'کافه و بازی رومیزی',
    icon: '🎲',
    isActive: true,
    sortOrder: 10,
    allowsCustomLabel: false,
  },
  {
    slug: 'outdoor',
    nameFa: 'طبیعت‌گردی',
    icon: '🌿',
    isActive: true,
    sortOrder: 20,
    allowsCustomLabel: false,
  },
  // Declared since M3, activated in M21.
  {
    slug: 'sports',
    nameFa: 'ورزش',
    icon: '⚽',
    isActive: true,
    sortOrder: 30,
    allowsCustomLabel: false,
  },
  {
    slug: 'learning',
    nameFa: 'یادگیری',
    icon: '📚',
    isActive: true,
    sortOrder: 40,
    allowsCustomLabel: false,
  },
  // New in M21.
  {
    slug: 'cafe-hopping',
    nameFa: 'کافه‌گردی',
    icon: '☕',
    isActive: true,
    sortOrder: 50,
    allowsCustomLabel: false,
  },
  {
    slug: 'walking',
    nameFa: 'پیاده‌روی',
    icon: '🚶',
    isActive: true,
    sortOrder: 60,
    allowsCustomLabel: false,
  },
  {
    slug: 'museum',
    nameFa: 'موزه و گالری',
    icon: '🏛️',
    isActive: true,
    sortOrder: 70,
    allowsCustomLabel: false,
  },
  {
    slug: 'shopping',
    nameFa: 'خرید',
    icon: '🛍️',
    isActive: true,
    sortOrder: 80,
    allowsCustomLabel: false,
  },
  {
    slug: 'food-tour',
    nameFa: 'غذاگردی',
    icon: '🍽️',
    isActive: true,
    sortOrder: 90,
    allowsCustomLabel: false,
  },
  {
    slug: 'cinema-theatre',
    nameFa: 'سینما و تئاتر',
    icon: '🎬',
    isActive: true,
    sortOrder: 100,
    allowsCustomLabel: false,
  },
  {
    slug: 'music',
    nameFa: 'موسیقی و کنسرت',
    icon: '🎵',
    isActive: true,
    sortOrder: 110,
    allowsCustomLabel: false,
  },
  {
    slug: 'travel',
    nameFa: 'سفر و گردشگری',
    icon: '🧳',
    isActive: true,
    sortOrder: 120,
    allowsCustomLabel: false,
  },
  {
    slug: 'volunteering',
    nameFa: 'داوطلبانه و خیریه',
    icon: '🤝',
    isActive: true,
    sortOrder: 130,
    allowsCustomLabel: false,
  },
  {
    slug: 'other',
    nameFa: 'سایر',
    icon: '✨',
    isActive: true,
    sortOrder: 999,
    allowsCustomLabel: true,
  },
];

/** علاقه‌مندی‌ها — what a user says they like, grouped under a category. */
const INTERESTS = [
  { slug: 'board-games', nameFa: 'بازی رومیزی', category: 'cafe-boardgames', sortOrder: 1 },
  { slug: 'coffee', nameFa: 'قهوه', category: 'cafe-hopping', sortOrder: 2 },
  { slug: 'card-games', nameFa: 'بازی با ورق', category: 'cafe-boardgames', sortOrder: 3 },
  { slug: 'chess', nameFa: 'شطرنج', category: 'cafe-boardgames', sortOrder: 4 },
  { slug: 'hiking', nameFa: 'کوه‌پیمایی', category: 'outdoor', sortOrder: 5 },
  { slug: 'cycling', nameFa: 'دوچرخه‌سواری', category: 'outdoor', sortOrder: 6 },
  { slug: 'walking', nameFa: 'پیاده‌روی', category: 'walking', sortOrder: 7 },
  { slug: 'photography', nameFa: 'عکاسی', category: 'outdoor', sortOrder: 8 },
  { slug: 'football', nameFa: 'فوتبال', category: 'sports', sortOrder: 9 },
  { slug: 'volleyball', nameFa: 'والیبال', category: 'sports', sortOrder: 10 },
  { slug: 'running', nameFa: 'دویدن', category: 'sports', sortOrder: 11 },
  { slug: 'book-club', nameFa: 'باشگاه کتاب', category: 'learning', sortOrder: 12 },
  { slug: 'language-exchange', nameFa: 'تبادل زبان', category: 'learning', sortOrder: 13 },
  { slug: 'music', nameFa: 'موسیقی', category: 'music', sortOrder: 14 },
  { slug: 'cooking', nameFa: 'آشپزی', category: 'food-tour', sortOrder: 15 },
  // New in M21, alongside the categories above.
  { slug: 'museum-visit', nameFa: 'بازدید از موزه', category: 'museum', sortOrder: 16 },
  { slug: 'gallery', nameFa: 'گالری هنری', category: 'museum', sortOrder: 17 },
  { slug: 'cinema', nameFa: 'سینما', category: 'cinema-theatre', sortOrder: 18 },
  { slug: 'theatre', nameFa: 'تئاتر', category: 'cinema-theatre', sortOrder: 19 },
  { slug: 'city-walk', nameFa: 'شهرگردی', category: 'walking', sortOrder: 20 },
  { slug: 'street-food', nameFa: 'غذای خیابانی', category: 'food-tour', sortOrder: 21 },
  { slug: 'shopping', nameFa: 'خرید', category: 'shopping', sortOrder: 22 },
  { slug: 'road-trip', nameFa: 'سفر جاده‌ای', category: 'travel', sortOrder: 23 },
  { slug: 'charity', nameFa: 'کار داوطلبانه', category: 'volunteering', sortOrder: 24 },
  { slug: 'other', nameFa: 'سایر', category: 'other', sortOrder: 999 },
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
    'This writes districts, activity categories and interests that users pick from.',
  );

  let districtCount = 0;
  for (const [citySlug, districts] of Object.entries(DISTRICTS)) {
    const city = await prisma.city.findUnique({ where: { slug: citySlug }, select: { id: true } });
    if (city === null) {
      // Not fatal: a fresh database that has not been through `seed:geography`
      // yet is a normal state, and failing here would make the order of two
      // independent seeds load-bearing. Saying so is enough.
      console.warn(`city ${citySlug} not found — run \`pnpm seed:geography\` first. Skipped.`);
      continue;
    }

    for (const district of districts) {
      await prisma.district.upsert({
        where: { cityId_slug: { cityId: city.id, slug: district.slug } },
        create: { ...district, cityId: city.id, isActive: true },
        update: { ...district, isActive: true },
      });
    }
    districtCount += districts.length;
    console.log(`city ${citySlug} · ${String(districts.length)} districts`);
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
    districts: districtCount,
    categories: CATEGORIES.length,
    interests: INTERESTS.length,
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
