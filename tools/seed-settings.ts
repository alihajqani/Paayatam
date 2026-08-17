/**
 * Writes every policy number from plan §11 into `app_setting` (M17).
 *
 * §11's heading is *"all in `app_setting`, runtime-changeable"*, and until M17 that
 * was only half true: `SETTING_DEFAULTS` carried all fifty values in code and the
 * catalog seed wrote exactly two rows. Every other number worked correctly and was
 * **invisible** — an operator opening the settings table saw two entries and had no
 * way to discover, let alone tune, the other forty-eight. A default that cannot be
 * found is not runtime-changeable.
 *
 * Seeding these changes no behaviour, which is the point: `SettingsService` falls
 * back to the same constant when a row is absent, so this run is a no-op
 * functionally and the difference is entirely in what an admin can see and edit.
 *
 * **Create-only, never update.** An operator who tuned the report threshold in
 * production must not have it silently reset because somebody ran a seed. That makes
 * this safe to re-run and safe to run after a change, and it means the script cannot
 * be used to *revert* a setting — which is correct: reverting is an admin action with
 * an audit trail, not a shell command.
 */
import { SETTING_DEFAULTS } from '@payetam/domain';
import { openSeed } from './seed-guard';

async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'seed.settings',
    'This writes the plan §11 policy defaults for any key that has no row yet.',
  );

  let created = 0;
  let kept = 0;

  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    const existing = await prisma.appSetting.findUnique({ where: { key } });
    if (existing) {
      kept += 1;
      // Reported, not silently skipped: a stored value that differs from the code
      // default is the interesting case, and an operator running this wants to see
      // which numbers have been tuned away from the plan.
      if (JSON.stringify(existing.value) !== JSON.stringify(value)) {
        console.log(
          `  ${key}: ${JSON.stringify(existing.value)} (default ${JSON.stringify(value)})`,
        );
      }
      continue;
    }

    await prisma.appSetting.create({ data: { key, value } });
    created += 1;
  }

  console.log(
    `${String(created)} settings created, ${String(kept)} already present ` +
      `(${String(Object.keys(SETTING_DEFAULTS).length)} in §11)`,
  );

  await finish({ settingsCreated: created, settingsKept: kept });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
