#!/usr/bin/env node
/**
 * Regenerates `tools/data/iran-geography.json` — the 31 provinces and 1,252
 * cities `pnpm seed:geography` writes.
 *
 *   node tools/data/build-iran-geography.mjs
 *
 * The JSON is **committed**, and this script exists to say where it came from
 * and to make a correction reproducible rather than hand-edited. A dataset
 * pasted in by hand is one nobody can re-derive when a city is renamed.
 *
 * ── Source ───────────────────────────────────────────────────────────────────
 *
 * `@code-plate/iran-cities` (MIT, github.com/MJavadSF/Iran-Cities), pinned by
 * version below. It was chosen over the several alternatives for one reason:
 * it is the only one carrying **both** a Persian name and a Latin kebab-case
 * name per city. Everything else ships Persian only, and a transliterator
 * invented here would produce slugs that no future contributor could reproduce
 * or agree with — Persian omits short vowels, so «تهران» transliterates
 * mechanically to `thrn`.
 *
 * It also ships correct Persian orthography (ی and ک, not the Arabic ي and ك),
 * which the Statistical Centre extracts do not — those need normalising before
 * they can be displayed, and normalising a *display* name is how «آذربایجان»
 * becomes «اذربایجان».
 *
 * ── Slugs ────────────────────────────────────────────────────────────────────
 *
 * `city.slug` is UNIQUE across the whole table, and the source's Latin names are
 * only unique *within* a province — 26 names collide nationally (four separate
 * سردشت, two شهریار). So: the bare Latin name when it is nationally unique, and
 * `<province>-<city>` when it is not.
 *
 * That rule is not an aesthetic choice. It is what keeps `tehran`, `karaj` and
 * `isfahan` — the three rows `seed-catalog.ts` has been writing since M3 —
 * spelled exactly as they already are in production, so this seeds *into* the
 * existing rows instead of creating a second Tehran beside the one every
 * profile and event already references. Those three are asserted below; if the
 * upstream dataset ever adds a colliding سردشت-like duplicate for one of them,
 * this script fails rather than silently renaming a live row.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_PACKAGE = '@code-plate/iran-cities';
const SOURCE_VERSION = '1.0.2';
const SOURCE_LICENSE = 'MIT';
const SOURCE_REPO = 'https://github.com/MJavadSF/Iran-Cities';

/**
 * Latin names the source leaves in Persian or spells with characters a slug
 * cannot carry. Corrections rather than transliterations — each is one row.
 */
const SLUG_OVERRIDES = {
  // Upstream leaves the Latin field in Persian for this one row (kermanshah/حلاشی).
  هلشی: 'halashi',
};

/**
 * Arabic → Persian letters, for display names.
 *
 * The source is *mostly* correct Persian, which is why it was chosen — but 25 of
 * its 1,253 names still carry ي (U+064A) or ك (U+0643), which render almost
 * identically to ی and ک and are different code points. A name spelled with them
 * sorts wrong, misses a search for the Persian spelling, and looks subtly foreign
 * to a reader.
 *
 * **Deliberately only these three.** The project's own normalizer
 * (`packages/domain/src/moderation/persian-normalizer.ts`) also folds آ→ا, أ→ا
 * and ة→ه, which is right for a *matching* pipeline and wrong here: applying it
 * to a display name turns «آذربایجان» into «اذربایجان». Normalisation is lossy on
 * purpose, and a label is the one place that loss is not acceptable.
 *
 * Applied before de-duplication, so two rows differing only by ي vs ی collapse
 * into the one city they always were.
 */
const PERSIAN_LETTERS = { ي: 'ی', ى: 'ی', ك: 'ک' };

function toPersian(name) {
  return name.replace(/[يىك]/g, (char) => PERSIAN_LETTERS[char] ?? char).normalize('NFC');
}

/** The province capitals, so a city list can put the obvious answer first. */
const CAPITAL_OF = {
  alborz: 'karaj',
  ardabil: 'ardabil',
  bushehr: 'bushehr',
  'chaharmahal-and-bakhtiari': 'shahr-e-kord',
  'east-azerbaijan': 'tabriz',
  isfahan: 'isfahan',
  fars: 'shiraz',
  gilan: 'rasht',
  golestan: 'gorgan',
  hamadan: 'hamadan',
  hormozgan: 'bandar-abbas',
  ilam: 'ilam',
  kerman: 'kerman',
  kermanshah: 'kermanshah',
  khuzestan: 'ahvaz',
  'kohgiluyeh-and-boyer-ahmad': 'yasuj',
  kurdistan: 'sanandaj',
  lorestan: 'khorramabad',
  markazi: 'arak',
  mazandaran: 'sari',
  'north-khorasan': 'bojnord',
  qazvin: 'qazvin',
  qom: 'qom',
  'razavi-khorasan': 'mashhad',
  semnan: 'semnan',
  'sistan-and-baluchestan': 'zahedan',
  'south-khorasan': 'birjand',
  tehran: 'tehran',
  'west-azerbaijan': 'urmia',
  yazd: 'yazd',
  zanjan: 'zanjan',
};

/** Must keep the slugs `seed-catalog.ts` already wrote. Asserted, not hoped for. */
const MUST_KEEP_SLUG = ['tehran', 'karaj', 'isfahan'];

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'iran-geo-'));

function sanitize(latin) {
  return (SLUG_OVERRIDES[latin] ?? latin)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

try {
  console.log(`Fetching ${SOURCE_PACKAGE}@${SOURCE_VERSION} …`);
  execFileSync('npm', ['pack', `${SOURCE_PACKAGE}@${SOURCE_VERSION}`, '--silent'], {
    cwd: work,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const tarball = execFileSync('sh', ['-c', 'ls *.tgz'], { cwd: work, encoding: 'utf8' }).trim();
  execFileSync('tar', ['xzf', tarball], { cwd: work });

  const source = await import(join(work, 'package', 'dist', 'index.mjs'));
  const provinces = source.getProvinces();

  // How many provinces carry each Latin city name, so the collision rule below
  // is a lookup rather than a nested scan.
  const nationalUses = new Map();
  for (const province of provinces) {
    for (const city of province.cities) {
      const key = sanitize(city.en);
      nationalUses.set(key, (nationalUses.get(key) ?? 0) + 1);
    }
  }

  const seen = new Set();
  const out = { source: {}, provinces: [] };

  for (const province of provinces) {
    const provinceSlug = sanitize(province.en);
    const capital = CAPITAL_OF[provinceSlug];
    if (capital === undefined) throw new Error(`no capital recorded for ${provinceSlug}`);

    const cities = [];
    // The source carries one exact duplicate row (mazandaran/گلوگاه, twice).
    // De-duplicating on the Persian name is what a human would call the same
    // city; de-duplicating on the slug would hide a genuine collision instead.
    const seenInProvince = new Set();

    for (const city of province.cities) {
      const nameFa = toPersian(city.fa);
      if (seenInProvince.has(nameFa)) continue;
      seenInProvince.add(nameFa);

      const latin = sanitize(city.en);
      let slug = nationalUses.get(latin) === 1 ? latin : `${provinceSlug}-${latin}`;
      // Belt and braces: two identically-named cities inside one province would
      // survive the rule above. None exist today; a rename upstream could make one.
      let attempt = 2;
      while (seen.has(slug)) slug = `${provinceSlug}-${latin}-${attempt++}`;
      seen.add(slug);

      cities.push({
        slug,
        nameFa,
        // 0 sorts the capital to the top of its province; everything else falls
        // back to the alphabetical tie-break the catalog query already applies.
        sortOrder: latin === capital ? 0 : 100,
      });
    }

    cities.sort((a, b) => a.sortOrder - b.sortOrder || a.nameFa.localeCompare(b.nameFa, 'fa'));
    out.provinces.push({ slug: provinceSlug, nameFa: toPersian(province.fa), cities });
  }

  // Tehran province first — it is the market the product launched in and the one
  // most pickers will want at the top. The rest alphabetically, in Persian.
  out.provinces.sort(
    (a, b) =>
      (a.slug === 'tehran' ? -1 : b.slug === 'tehran' ? 1 : 0) ||
      a.nameFa.localeCompare(b.nameFa, 'fa'),
  );
  out.provinces.forEach((province, index) => {
    province.sortOrder = index * 10;
  });

  // Every province must have found its capital. A `CAPITAL_OF` spelling that has
  // drifted from the source's produces a province whose list opens on an
  // arbitrary town — a silent wrong rather than a failure.
  for (const province of out.provinces) {
    if (!province.cities.some((city) => city.sortOrder === 0)) {
      throw new Error(
        `no city in ${province.slug} matched CAPITAL_OF["${province.slug}"] — check the spelling ` +
          `against the source's Latin names.`,
      );
    }
  }

  for (const slug of MUST_KEEP_SLUG) {
    if (!seen.has(slug)) {
      throw new Error(
        `slug "${slug}" is not in the generated set. seed-catalog.ts has written it since M3; ` +
          `emitting a different spelling would create a second row beside the live one.`,
      );
    }
  }

  const cityCount = out.provinces.reduce((n, p) => n + p.cities.length, 0);
  out.source = {
    package: SOURCE_PACKAGE,
    version: SOURCE_VERSION,
    license: SOURCE_LICENSE,
    repository: SOURCE_REPO,
    generatedBy: 'tools/data/build-iran-geography.mjs',
    provinceCount: out.provinces.length,
    cityCount,
  };
  // `source` last would put the counts below 1,252 cities of diff. It goes first.
  const target = join(here, 'iran-geography.json');
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${target}: ${out.provinces.length} provinces, ${cityCount} cities.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
