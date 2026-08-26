import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards on the generated geography dataset (M21).
 *
 * The file is produced by `tools/data/build-iran-geography.mjs` and committed, so
 * nothing here re-derives it. What these assert is the set of properties the rest
 * of the system *relies* on and would fail obscurely without — the point being to
 * catch a bad regeneration at `pnpm test` rather than at `pnpm seed:geography`
 * against production.
 *
 * The generator makes some of these claims itself and throws if they break. That
 * is not a reason to drop them here: the generator only runs when somebody
 * regenerates, and this runs on every commit — including the one that hand-edits
 * the JSON "just this once".
 */

interface Geography {
  source: { provinceCount: number; cityCount: number };
  provinces: {
    slug: string;
    nameFa: string;
    sortOrder: number;
    cities: { slug: string; nameFa: string; sortOrder: number }[];
  }[];
}

const geography = JSON.parse(
  readFileSync(join(__dirname, 'iran-geography.json'), 'utf8'),
) as Geography;

const cities = geography.provinces.flatMap((province) => province.cities);

describe('iran-geography.json', () => {
  it('has all 31 provinces', () => {
    expect(geography.provinces).toHaveLength(31);
    expect(geography.source.provinceCount).toBe(31);
  });

  it('agrees with its own recorded city count', () => {
    expect(cities).toHaveLength(geography.source.cityCount);
  });

  /**
   * The one that protects live data.
   *
   * `seed-catalog.ts` has written these three slugs since M3, and
   * `user_profile.city_id` and `event.city_id` in production point at the rows
   * they created. A regeneration that spelled Tehran `tehran-tehran` would not
   * fail — it would quietly create a *second* Tehran beside the live one, and
   * every existing profile would still reference the first.
   */
  it.each(['tehran', 'karaj', 'isfahan'])('keeps the pre-M21 slug %s', (slug) => {
    expect(cities.filter((city) => city.slug === slug)).toHaveLength(1);
  });

  it('has globally unique city slugs, because city.slug is UNIQUE', () => {
    const seen = new Map<string, number>();
    for (const city of cities) seen.set(city.slug, (seen.get(city.slug) ?? 0) + 1);
    expect([...seen.entries()].filter(([, count]) => count > 1)).toEqual([]);
  });

  it('has unique province slugs', () => {
    expect(new Set(geography.provinces.map((p) => p.slug)).size).toBe(geography.provinces.length);
  });

  it('emits slugs a URL and a seed file can carry verbatim', () => {
    const pattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const bad = [...geography.provinces.map((p) => p.slug), ...cities.map((c) => c.slug)].filter(
      (slug) => !pattern.test(slug),
    );
    expect(bad).toEqual([]);
  });

  /**
   * Persian orthography, not Arabic.
   *
   * ي (U+064A) and ك (U+0643) render almost identically to ی and ک and are
   * different code points. The Statistical Centre extracts are full of them; this
   * dataset was chosen partly because it is not. A display name is the one place
   * the ADR-0012 normalizer must **not** be applied — it folds آ to ا, which turns
   * «آذربایجان» into «اذربایجان».
   */
  it('spells Persian names with ی and ک', () => {
    const arabic = /[يك]/;
    const offenders = [
      ...geography.provinces.filter((p) => arabic.test(p.nameFa)).map((p) => p.slug),
      ...cities.filter((c) => arabic.test(c.nameFa)).map((c) => c.slug),
    ];
    expect(offenders).toEqual([]);
  });

  it('gives every province exactly one capital, at sortOrder 0', () => {
    for (const province of geography.provinces) {
      const capitals = province.cities.filter((city) => city.sortOrder === 0);
      expect(capitals, province.slug).toHaveLength(1);
    }
  });

  it('puts Tehran province first, because it is the launch market', () => {
    expect(geography.provinces[0]?.slug).toBe('tehran');
  });
});
