/**
 * A small, curated bank of believable Persian event text for marketing seed
 * events (see docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md),
 * filled in with a category and city name — deliberately generic rather than
 * keyed to a catalogue category slug, so it needs no catalogue data of its
 * own and cannot go stale when categories are renamed.
 *
 * `random` is injected (same shape as `Math.random`) so the picker is a
 * pure, deterministically-testable function — the caller supplies real
 * randomness.
 */

const TITLE_TEMPLATES: ReadonlyArray<(category: string) => string> = [
  (category) => `دورهمی ${category}`,
  (category) => `${category} دوستانه`,
  (category) => `یک عصر با ${category}`,
  (category) => `${category} برای آشنایی با آدم‌های جدید`,
];

const DESCRIPTION_TEMPLATES: ReadonlyArray<(category: string, city: string) => string> = [
  (category, city) =>
    `یک برنامه‌ی ${category} کوچک و دوستانه در ${city}. اگر تازه‌کار هم باشید مشکلی نیست، فضا صمیمی‌ست.`,
  (category, city) =>
    `دنبال بهانه‌ای برای بیرون اومدن از خونه در ${city} هستید؟ این یک ${category} ساده و بی‌تکلف است.`,
  (category, city) =>
    `جمع کوچیکی برای ${category} در ${city} — هدف آشنایی و گذروندن وقت خوبه، نه رقابت.`,
];

export function pickSeedContent(input: {
  categoryNameFa: string;
  cityNameFa: string;
  random: () => number;
}): { title: string; description: string } {
  const titleIndex = Math.floor(input.random() * TITLE_TEMPLATES.length) % TITLE_TEMPLATES.length;
  const descriptionIndex =
    Math.floor(input.random() * DESCRIPTION_TEMPLATES.length) % DESCRIPTION_TEMPLATES.length;

  return {
    title: TITLE_TEMPLATES[titleIndex]!(input.categoryNameFa),
    description: DESCRIPTION_TEMPLATES[descriptionIndex]!(input.categoryNameFa, input.cityNameFa),
  };
}
