/**
 * Sample gift codes, for development and tests only (M19).
 *
 * The production seeds — policies, catalog, blacklist, RBAC, settings, founding
 * events — all write content the product needs in order to work at all. This one
 * writes **money**, and that is why it is a separate script with a stricter gate
 * rather than another entry in `make seed`.
 *
 * The failure being designed against is specific and has happened to other
 * people: a valuable code lands in a repository, somebody runs the seed against
 * production because the deploy runbook says "run the seeds", and a code with no
 * expiry and no cap is live and known to everybody who has ever cloned the repo.
 *
 * Three things stop that here, and they are deliberately not the same three
 * `seed-guard` uses:
 *
 *  1. **`NODE_ENV=production` is refused outright**, with no escape hatch.
 *     `ALLOW_PROD_SEED=1` is what the other scripts honour, and it does not apply
 *     here — the whole point is that there is no correct way to run this in
 *     production, so an override would be a way to do the wrong thing carefully.
 *  2. **Every code begins with `DEV`**, so an operator who finds one in a
 *     database is told what it is by the code itself. Codes are addressed by
 *     `public_id` everywhere in the admin surface, so this prefix is for the
 *     human reading a row, not for anything in the product.
 *  3. **Nothing is minted with an unbounded value.** Every fixture is capped, and
 *     the fixed ones expire or are already disabled, so even a leaked
 *     development database cannot be drained.
 *
 * The fixed codes are **idempotent**: re-running skips whatever already exists,
 * so a developer can run this after every reset without collecting duplicates.
 * The random batch is new every time, which is the point of it — it is what
 * `apps/admin`'s batch screens and the analytics roll-up are exercised against.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@payetam/db';
import { generateCode } from '@payetam/domain';
import { DEV_GIFT_CODE_PREFIX, fixtures, maySeedGiftCodes } from './gift-code-fixtures';
import { openSeed } from './seed-guard';

/** How many random single-use codes the batch fixture mints. */
const BATCH_SIZE = 25;

async function main(): Promise<void> {
  const nodeEnv = process.env['NODE_ENV'];
  if (!maySeedGiftCodes(nodeEnv)) {
    console.error(
      'Refusing to seed gift codes.\n' +
        `  NODE_ENV is ${nodeEnv ?? '(unset)'}; this script runs only under ` +
        "'development' or 'test'.\n" +
        '  These codes grant coins and are committed to the repository, so there is no\n' +
        '  correct way to run this against production — ALLOW_PROD_SEED does not apply.',
    );
    process.exit(1);
  }

  const { prisma, finish } = await openSeed(
    'seed.gift_codes_dev',
    'This writes sample gift codes for local development. Never for production.',
  );

  try {
    const now = new Date();
    let created = 0;
    let kept = 0;

    for (const fixture of fixtures(now)) {
      const existing = await prisma.giftCode.findUnique({ where: { code: fixture.code } });
      if (existing) {
        kept += 1;
        continue;
      }

      await prisma.giftCode.create({
        data: {
          code: fixture.code,
          coins: fixture.coins,
          maxRedemptions: fixture.maxRedemptions,
          perUserLimit: 1,
          isActive: fixture.isActive ?? true,
          startsAt: fixture.startsAt ?? null,
          expiresAt: fixture.expiresAt ?? null,
          campaign: 'dev-fixtures',
          note: fixture.note,
        },
      });
      created += 1;
    }

    const batch = await mintBatch(prisma, now);

    console.log(
      `Gift-code fixtures: ${String(created)} created, ${String(kept)} already present.\n` +
        `Batch ${batch.batchId}: ${String(batch.codes.length)} single-use codes.\n\n` +
        `  ${batch.codes.slice(0, 5).join('  ')}  …\n\n` +
        'Fixed codes, one per outcome:\n' +
        fixtures(now)
          .map((fixture) => `  ${fixture.code.padEnd(12)} ${fixture.note}`)
          .join('\n'),
    );

    await finish({
      fixtures: created,
      kept,
      batchId: batch.batchId,
      batchSize: batch.codes.length,
    });
  } catch (error) {
    await prisma.$disconnect();
    throw error;
  }
}

/**
 * A fresh batch on every run, so two runs never collide.
 *
 * The fixed codes above are idempotent because they are *named*; these are not
 * named and must not be, or the analytics roll-up would be tested against one
 * campaign that grows a duplicate-key error every second run. `randomUUID` for
 * the batch id and `generateCode` for the codes — the same CSPRNG draw the admin
 * service uses, because a development fixture that is generated differently from
 * the real thing is a fixture that tests something else.
 */
async function mintBatch(
  prisma: PrismaClient,
  now: Date,
): Promise<{ batchId: string; codes: string[] }> {
  const batchId = randomUUID();
  const codes = new Set<string>();
  while (codes.size < BATCH_SIZE) codes.add(`${DEV_GIFT_CODE_PREFIX}${generateCode(10)}`);

  await prisma.giftCode.createMany({
    data: [...codes].map((code) => ({
      code,
      coins: 20,
      maxRedemptions: 1,
      perUserLimit: 1,
      campaign: 'dev-batch',
      batchId,
      note: 'Development fixture: bulk batch.',
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    })),
    skipDuplicates: true,
  });

  return { batchId, codes: [...codes] };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
