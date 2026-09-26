/**
 * Seeds the TERMS, PRIVACY and COMMUNITY documents from `docs/legal/`.
 *
 * Development convenience. Real policy text is authored in the admin panel (M12);
 * this exists so onboarding is exercisable before that panel is built.
 *
 * Idempotent: re-running updates the current version in place rather than
 * publishing a second one, so `pnpm seed:policies` is safe to repeat.
 *
 * Refuses to run against production — publishing placeholder legal text to real
 * users would be considerably worse than a failed script (M17 rail).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSeed } from './seed-guard';

/**
 * The documents themselves live in `docs/legal/`, which is where they are
 * written and reviewed; the operator publishes the same text from the panel.
 * `__dirname`, not `import.meta.url`: the workspace compiles to CommonJS (see
 * `seed-geography.ts`).
 */
function legal(name: string): string {
  return readFileSync(join(__dirname, '..', 'docs', 'legal', `${name}-fa.md`), 'utf8');
}

async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'seed.policies',
    'This publishes the TERMS, PRIVACY and COMMUNITY text that real users would then be asked to accept.',
  );

  let published = 0;

  const documents = [
    {
      type: 'TERMS' as const,
      contentMd: legal('terms'),
      titleFa: 'قوانین و شرایط استفاده',
      summaryFa: 'قوانین استفاده از ربات پایتم',
    },
    {
      type: 'PRIVACY' as const,
      contentMd: legal('privacy'),
      titleFa: 'سیاست حریم خصوصی',
      summaryFa: 'سیاست حریم خصوصی',
    },
    {
      type: 'COMMUNITY' as const,
      contentMd: legal('community'),
      titleFa: 'آیین‌نامهٔ رفتار',
      summaryFa: 'آیین‌نامهٔ رفتار کاربران',
    },
  ];

  for (const doc of documents) {
    const existing = await prisma.policyVersion.findFirst({
      where: { type: doc.type, isCurrent: true },
    });

    if (existing) {
      await prisma.policyVersion.update({
        where: { id: existing.id },
        data: { contentMd: doc.contentMd, titleFa: doc.titleFa, summaryFa: doc.summaryFa },
      });
      console.log(`updated ${doc.type} v${existing.version}`);
    } else {
      const created = await prisma.policyVersion.create({
        data: { ...doc, version: 1, isCurrent: true },
      });
      console.log(`published ${doc.type} v${created.version}`);
      published += 1;
    }
  }

  await finish({ policiesPublished: published, policiesUpdated: documents.length - published });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
