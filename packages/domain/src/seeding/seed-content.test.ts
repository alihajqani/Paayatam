import { describe, expect, it } from 'vitest';
import { pickSeedContent } from './seed-content';

describe('pickSeedContent', () => {
  it('is deterministic for a fixed random source', () => {
    const random = (): number => 0;
    const a = pickSeedContent({ categoryNameFa: 'کوهنوردی', cityNameFa: 'اصفهان', random });
    const b = pickSeedContent({ categoryNameFa: 'کوهنوردی', cityNameFa: 'اصفهان', random });
    expect(a).toEqual(b);
  });

  it('embeds the category and city names in the output', () => {
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
});
