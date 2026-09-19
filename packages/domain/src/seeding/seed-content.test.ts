import { describe, expect, it } from 'vitest';
import { BlacklistService, type BlacklistRule } from '../moderation/blacklist.service';
import { decisionFor } from '../moderation/moderation.service';
import { normalize } from '../moderation/persian-normalizer';
import { STARTER_BLACKLIST } from '../moderation/starter-blacklist';
import { allSeedTopicTexts, pickSeedContent } from './seed-content';

const REAL_SLUGS = [
  'cafe-boardgames',
  'outdoor',
  'sports',
  'learning',
  'cafe-hopping',
  'walking',
  'museum',
  'shopping',
  'food-tour',
  'cinema-theatre',
  'music',
  'travel',
  'volunteering',
];

describe('pickSeedContent', () => {
  it('is deterministic for a fixed random source', () => {
    const random = (): number => 0;
    const a = pickSeedContent({ categoryNameFa: 'کوهنوردی', cityNameFa: 'اصفهان', random });
    const b = pickSeedContent({ categoryNameFa: 'کوهنوردی', cityNameFa: 'اصفهان', random });
    expect(a).toEqual(b);
  });

  it('embeds the category and city names for a category the bank does not know', () => {
    const result = pickSeedContent({
      categoryNameFa: 'بازی رومیزی',
      cityNameFa: 'شیراز',
      random: () => 0.5,
    });
    expect(result.title).toContain('بازی رومیزی');
    expect(result.description).toContain('شیراز');
  });

  it('varies with the random source', () => {
    const titles = new Set(
      [0, 0.2, 0.4, 0.6, 0.8].map(
        (r) =>
          pickSeedContent({ categoryNameFa: 'پیاده‌روی', cityNameFa: 'تبریز', random: () => r })
            .title,
      ),
    );
    expect(titles.size).toBeGreaterThan(1);
  });

  it('never produces an empty title or description', () => {
    for (const r of [0, 0.1, 0.33, 0.5, 0.75, 0.99]) {
      const result = pickSeedContent({
        categoryNameFa: 'یوگا',
        cityNameFa: 'مشهد',
        random: () => r,
      });
      expect(result.title.trim().length).toBeGreaterThan(0);
      expect(result.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses the category’s own topics when the slug is known', () => {
    const result = pickSeedContent({
      categorySlug: 'sports',
      categoryNameFa: 'ورزش',
      cityNameFa: 'تهران',
      random: () => 0,
    });
    expect(result.title).toBe('والیبال دوستانه');
    expect(result.description).toContain('تهران');
  });

  it('skips a topic the city already has and takes an unused one', () => {
    const seen = new Set<string>();
    const taken = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const { title } = pickSeedContent({
        categorySlug: 'sports',
        categoryNameFa: 'ورزش',
        cityNameFa: 'تهران',
        takenTitles: taken,
        random: () => 0,
      });
      expect(taken.has(title)).toBe(false);
      taken.add(title);
      seen.add(title);
    }
    expect(seen.size).toBe(4);
  });

  it('repeats a topic rather than failing once every one is taken', () => {
    const everySportsTitle = new Set([
      'والیبال دوستانه',
      'بدمینتون گروهی',
      'دویدن سبک صبحگاهی',
      'یوگای گروهی در فضای باز',
    ]);
    const result = pickSeedContent({
      categorySlug: 'sports',
      categoryNameFa: 'ورزش',
      cityNameFa: 'تهران',
      takenTitles: everySportsTitle,
      random: () => 0.5,
    });
    expect(everySportsTitle.has(result.title)).toBe(true);
  });

  it('carries the topic’s parts of the day, so a sunrise walk is never an evening', () => {
    const sunrise = pickSeedContent({
      categorySlug: 'outdoor',
      categoryNameFa: 'طبیعت‌گردی',
      cityNameFa: 'تهران',
      takenTitles: new Set(['کوهپیمایی سبک', 'پیک‌نیک در پارک', 'گشت عکاسی در طبیعت']),
      random: () => 0,
    });
    expect(sunrise.title).toBe('طلوع‌گردی و صبحانه بیرون');
    expect(sunrise.parts).toEqual(['MORNING']);
  });

  it('falls back to the generic templates for an unknown slug', () => {
    const result = pickSeedContent({
      categorySlug: 'a-category-added-later',
      categoryNameFa: 'شطرنج',
      cityNameFa: 'رشت',
      random: () => 0.3,
    });
    expect(result.title).toContain('شطرنج');
  });

  it('does not treat an inherited property name as a known slug', () => {
    const result = pickSeedContent({
      categorySlug: 'constructor',
      categoryNameFa: 'شطرنج',
      cityNameFa: 'رشت',
      random: () => 0,
    });
    expect(result.title).toContain('شطرنج');
  });
});

describe('the bank, taken as a whole', () => {
  it('produces a title and description inside the event contract for every topic and closing', () => {
    for (const slug of REAL_SLUGS) {
      for (let r = 0; r < 1; r += 0.05) {
        const { title, description } = pickSeedContent({
          categorySlug: slug,
          categoryNameFa: 'دسته',
          cityNameFa: 'تهران',
          random: () => r,
        });
        // `createEventRequest`: title 3..80, description 10..2000.
        expect(title.length).toBeGreaterThanOrEqual(3);
        expect(title.length).toBeLessThanOrEqual(80);
        expect(description.length).toBeGreaterThanOrEqual(10);
        expect(description.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it('has at least three distinct titles for the categories that matter most', () => {
    for (const slug of REAL_SLUGS.filter((s) => s !== 'volunteering')) {
      const titles = new Set<string>();
      for (let r = 0; r < 1; r += 0.05) {
        titles.add(
          pickSeedContent({
            categorySlug: slug,
            categoryNameFa: 'دسته',
            cityNameFa: 'تهران',
            random: () => r,
          }).title,
        );
      }
      expect(titles.size, slug).toBeGreaterThanOrEqual(3);
    }
  });

  it('never uses an Arabic letter form, an em dash or a Latin digit', () => {
    for (const text of allSeedTopicTexts()) {
      expect(text).not.toMatch(/[يك]/);
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/[0-9]/);
    }
  });

  it('names no day, date or relative time, because the event row carries the schedule', () => {
    for (const text of allSeedTopicTexts()) {
      expect(text).not.toMatch(/شنبه|جمعه|آخر هفته|فردا|امروز|دیشب|هفته‌ی/);
    }
  });

  /**
   * The point of a curated bank: nothing in it may be held for a moderator, or
   * blocked, by the very list `EventService.create` scans it with. Built from the
   * real `STARTER_BLACKLIST` the way `blacklist.match.test.ts` does, so a term
   * added there later fails here rather than in a worker log at 3am.
   */
  it('is CLEAN against the starter blacklist', () => {
    const service = new BlacklistService(null as never);
    const rules: BlacklistRule[] = STARTER_BLACKLIST.map((term, index) => ({
      id: `rule-${String(index)}`,
      termRaw: term.termRaw,
      termNormalized: term.patternType === 'REGEX' ? term.termRaw : normalize(term.termRaw),
      patternType: term.patternType,
      severity: term.severity,
      category: term.category,
    }));

    for (const text of allSeedTopicTexts()) {
      const matches = service.match(text, rules);
      expect(decisionFor(matches), text).toBe('CLEAN');
    }
  });
});
