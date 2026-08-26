/**
 * Seeds the 31 provinces of Iran and their 1,252 cities.
 *
 *   pnpm seed:geography                    # every city selectable
 *   pnpm seed:geography --activate=capitals # only the 31 provincial capitals
 *   pnpm seed:geography --activate=none     # rows exist, nothing becomes selectable
 *
 * Separate from `seed:catalog` because it is a different kind of data. The
 * catalog seed writes a handful of rows a human wrote down and will edit again;
 * this writes a generated dataset with a provenance (see
 * `tools/data/build-iran-geography.mjs`) that is re-derived rather than edited.
 *
 * ── The two safety properties ────────────────────────────────────────────────
 *
 * **1. Existing city ids are never disturbed.** The upsert key is `slug`, and
 * the generator asserts that `tehran`, `karaj` and `isfahan` keep the exact
 * spellings `seed-catalog.ts` has written since M3. So this seeds *into* the
 * live Tehran row — the one every `user_profile.city_id` and `event.city_id` in
 * production already points at — rather than creating a second one beside it.
 * Nothing needs fixing up by hand afterwards, which is the whole design goal.
 *
 * **2. It can only ever widen availability, never narrow it.** A city that is
 * active stays active whatever `--activate` says. A seed that could switch a
 * served city off is a seed that can take a city's users offline by being run at
 * the wrong moment, and the operator running it would have no reason to expect
 * that. Deactivation is an admin-panel act, deliberately and audibly, one city
 * at a time.
 *
 * Districts are NOT touched here — the dataset has none, Tehran's are
 * hand-authored, and they stay with `seed:catalog` which is where a human edits
 * them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSeed } from './seed-guard';

interface GeographyFile {
  source: { package: string; version: string; provinceCount: number; cityCount: number };
  provinces: {
    slug: string;
    nameFa: string;
    sortOrder: number;
    cities: { slug: string; nameFa: string; sortOrder: number }[];
  }[];
}

/** Which of the seeded cities become selectable. */
type ActivationMode = 'all' | 'capitals' | 'none';

const ACTIVATION_MODES: ActivationMode[] = ['all', 'capitals', 'none'];

function parseActivation(argv: string[]): ActivationMode {
  const flag = argv.find((argument) => argument.startsWith('--activate='));
  if (flag === undefined) return 'all';

  const value = flag.slice('--activate='.length);
  if (!ACTIVATION_MODES.includes(value as ActivationMode)) {
    console.error(`Unknown --activate=${value}. Expected one of: ${ACTIVATION_MODES.join(', ')}.`);
    process.exit(1);
  }
  return value as ActivationMode;
}

function loadGeography(): GeographyFile {
  // `__dirname`, not `import.meta.url`: the workspace compiles to CommonJS
  // (`tsconfig.base.json`), and `import.meta` is a type error under that setting
  // even though `tsx` would happily run it.
  const path = join(__dirname, 'data', 'iran-geography.json');
  return JSON.parse(readFileSync(path, 'utf8')) as GeographyFile;
}

async function main(): Promise<void> {
  const activation = parseActivation(process.argv.slice(2));
  const geography = loadGeography();

  const { prisma, finish } = await openSeed(
    'seed.geography',
    `This writes ${String(geography.source.provinceCount)} provinces and ` +
      `${String(geography.source.cityCount)} cities that users pick from ` +
      `(--activate=${activation}).`,
  );

  let created = 0;
  let updated = 0;
  let activated = 0;

  try {
    for (const province of geography.provinces) {
      const provinceData = {
        slug: province.slug,
        nameFa: province.nameFa,
        sortOrder: province.sortOrder,
        isActive: true,
      };
      const provinceRow = await prisma.province.upsert({
        where: { slug: province.slug },
        create: provinceData,
        update: provinceData,
      });

      for (const city of province.cities) {
        // `sortOrder === 0` marks the provincial capital in the generated file.
        const wantActive =
          activation === 'all' || (activation === 'capitals' && city.sortOrder === 0);

        const existing = await prisma.city.findUnique({
          where: { slug: city.slug },
          select: { id: true, isActive: true },
        });

        if (existing === null) {
          await prisma.city.create({
            data: {
              slug: city.slug,
              nameFa: city.nameFa,
              provinceId: provinceRow.id,
              sortOrder: city.sortOrder,
              isActive: wantActive,
            },
          });
          created += 1;
          if (wantActive) activated += 1;
          continue;
        }

        // Safety property 2: `existing.isActive || wantActive` — never the bare
        // `wantActive`, which would let `--activate=capitals` switch off a
        // non-capital somebody is already hosting events in.
        //
        // `sortOrder` is deliberately absent from the update: it is an admin's
        // ordering choice once a row exists, and a seed is not entitled to
        // rearrange the picker somebody arranged.
        const nextActive = existing.isActive || wantActive;
        await prisma.city.update({
          where: { id: existing.id },
          data: { nameFa: city.nameFa, provinceId: provinceRow.id, isActive: nextActive },
        });
        updated += 1;
        if (nextActive && !existing.isActive) activated += 1;
      }

      console.log(
        `province ${province.slug.padEnd(26)} · ${String(province.cities.length).padStart(4)} cities`,
      );
    }

    const totalActive = await prisma.city.count({ where: { isActive: true } });
    console.log(
      `\n${String(geography.provinces.length)} provinces · ` +
        `${String(created)} cities created, ${String(updated)} updated · ` +
        `${String(activated)} newly activated · ${String(totalActive)} selectable in total`,
    );

    await finish({
      source: `${geography.source.package}@${geography.source.version}`,
      activation,
      provinces: geography.provinces.length,
      citiesCreated: created,
      citiesUpdated: updated,
      citiesActivated: activated,
      citiesSelectable: totalActive,
    });
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
