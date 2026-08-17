/**
 * Seeds a starter blacklist and its version.
 *
 * This is a **starting point for moderators**, not a finished policy. It is small
 * on purpose: ADR-0012 is explicit that a false positive blocking a legitimate
 * host is the worse outcome, so the list ships with the terms whose reasoning can
 * be written down, and M12's admin panel is where it grows with real evidence.
 *
 * Two things to understand before adding a term:
 *
 *  - **EXACT matches a whole word; SUBSTRING matches anywhere.** Persian has the
 *    same trap English does — «بنگ» (a drug slang term) sits inside «بنگاه»
 *    (a firm or agency). As SUBSTRING it would flag every estate agent in Tehran.
 *    Use SUBSTRING only for terms that cannot appear inside an innocent word.
 *  - **FLAG publishes; BLOCK does not.** Reach for BLOCK only when the term has
 *    no innocent reading at all. Anything a real host might legitimately write
 *    is FLAG, which puts it in a queue rather than in their way.
 *
 * Idempotent by (normalized term, pattern type). Re-running updates severities in
 * place and bumps the version only when something actually changed, so a
 * repeated seed does not inflate the version counter and invalidate the
 * provenance of past decisions.
 */
import { openSeed } from './seed-guard';
import { normalize } from '@payetam/domain';

interface SeedTerm {
  termRaw: string;
  patternType: 'EXACT' | 'SUBSTRING' | 'REGEX';
  severity: 'BLOCK' | 'FLAG';
  category: string;
  /** Why this term, and why this severity. Read by the next person to edit the list. */
  rationale: string;
}

const TERMS: SeedTerm[] = [
  {
    termRaw: 'مواد مخدر',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'drugs',
    rationale: 'Narcotics, explicit. No innocent reading in an activity listing.',
  },
  {
    termRaw: 'شرط‌بندی',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'gambling',
    rationale: 'Betting. Unambiguous, and a common spam vector.',
  },
  {
    termRaw: 'قمار',
    patternType: 'EXACT',
    severity: 'BLOCK',
    category: 'gambling',
    rationale:
      'Gambling. EXACT rather than SUBSTRING so «قمارباز» in a novel-club description is judged on its own.',
  },
  {
    termRaw: 'مشروب',
    patternType: 'SUBSTRING',
    severity: 'BLOCK',
    category: 'alcohol',
    rationale: 'Alcohol, which is illegal to offer here. SUBSTRING covers «مشروبات».',
  },
  {
    termRaw: 'شیشه',
    patternType: 'EXACT',
    severity: 'FLAG',
    category: 'drugs',
    rationale:
      'Slang for methamphetamine — and the ordinary word for glass. «کافه شیشه‌ای» must not be blocked, so this goes to a human.',
  },
  {
    termRaw: 'بنگ',
    patternType: 'EXACT',
    severity: 'FLAG',
    category: 'drugs',
    rationale:
      'Drug slang, and a substring of «بنگاه». EXACT keeps estate agents out of the queue; FLAG keeps a false positive out of the host way.',
  },
  {
    termRaw: 'صیغه',
    patternType: 'EXACT',
    severity: 'FLAG',
    category: 'solicitation',
    rationale:
      'Routinely abused for solicitation, but a legitimate religious and legal term. Human judgement, not a block.',
  },
  {
    // Normalization has already turned Persian digits into Latin ones by the time
    // this runs, so the pattern only needs to know about 0-9.
    termRaw: '(\\+?98|0)9\\d{9}',
    patternType: 'REGEX',
    severity: 'FLAG',
    category: 'contact',
    rationale:
      "An Iranian mobile number in a public listing routes people around the anonymous chat, which is the product's whole safety model. Flagged, not blocked: a venue phone number is a plausible mistake, not an attack.",
  },
];

async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'seed.blacklist',
    'This writes moderation terms that decide whether real events publish.',
  );

  let changed = 0;

  for (const term of TERMS) {
    // REGEX patterns are matched against normalized text but are not themselves
    // Persian prose — normalizing `\d{9}` would mangle the pattern. Everything
    // else goes through the same pipeline the scanner uses, so a term and the
    // text it must match are in the same shape.
    const termNormalized = term.patternType === 'REGEX' ? term.termRaw : normalize(term.termRaw);

    const existing = await prisma.blacklistTerm.findUnique({
      where: {
        termNormalized_patternType: { termNormalized, patternType: term.patternType },
      },
    });

    if (existing) {
      if (existing.severity === term.severity && existing.isActive) {
        console.log(`term ${term.termRaw} (${term.patternType}) unchanged`);
        continue;
      }
      await prisma.blacklistTerm.update({
        where: { id: existing.id },
        data: { severity: term.severity, category: term.category, isActive: true },
      });
      console.log(`term ${term.termRaw} (${term.patternType}) updated → ${term.severity}`);
    } else {
      await prisma.blacklistTerm.create({
        data: {
          termRaw: term.termRaw,
          termNormalized,
          patternType: term.patternType,
          severity: term.severity,
          category: term.category,
          createdBy: 'seed',
        },
      });
      console.log(`term ${term.termRaw} (${term.patternType}) added → ${term.severity}`);
    }
    changed += 1;
  }

  const current = await prisma.blacklistVersion.findFirst({ orderBy: { version: 'desc' } });

  // Bumped only on a real change. Every moderation_case stores the version that
  // judged it; inflating the counter on a no-op seed would make those references
  // point at versions that changed nothing.
  if (changed > 0 || !current) {
    const version = (current?.version ?? 0) + 1;
    await prisma.blacklistVersion.create({
      data: {
        version,
        note: `seed: ${String(changed)} term(s) changed`,
        createdBy: 'seed',
      },
    });
    console.log(`blacklist version → ${version}`);
  } else {
    console.log(`blacklist version unchanged (${current.version})`);
  }

  await finish({ termsChanged: changed });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
