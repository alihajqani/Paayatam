import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Three projects, deliberately separated:
 *
 * - `unit` is fast and runs on every save. No database, no network.
 * - `miniapp` is the same speed but needs a DOM, because `telegram/webapp.ts`
 *   reads `window.Telegram` at module load — so anything importing a store
 *   transitively touches `window` before a single test runs. It also needs the
 *   two path aliases `vite.config.ts` sets up, since the code under test uses
 *   them.
 * - `integration` runs against a real Postgres and Redis via Testcontainers.
 *   Nothing transactional is ever mocked — capacity locking (ADR-0006) and the
 *   ledger invariants (ADR-0007) are *database* guarantees, so a mocked test of
 *   them would prove nothing. These are slower, hence the separate project and
 *   the longer timeout.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          // The Mini App has its own project below; without this exclusion its
          // files would run twice, once in an environment with no `window`.
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts', 'apps/miniapp/src/**'],
        },
      },
      {
        resolve: {
          alias: {
            '@': fileURLToPath(new URL('./apps/miniapp/src', import.meta.url)),
            // Source, not `dist`, exactly as vite.config.ts does it — so a test
            // cannot pass against yesterday's contracts.
            '@payetam/shared': fileURLToPath(
              new URL('./packages/shared/src/index.ts', import.meta.url),
            ),
          },
        },
        test: {
          name: 'miniapp',
          environment: 'jsdom',
          include: ['apps/miniapp/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['{apps,packages}/*/src/**/*.int.test.ts', 'test/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          setupFiles: ['./test/integration/setup.ts'],
          // Container startup dominates; the assertions themselves are fast.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          /**
           * Integration tests share one database, so they run one file at a time.
           *
           * **`maxWorkers: 1` is what actually enforces it, and
           * `fileParallelism` alone did not.** Run on its own the integration project was serial and
           * green; run alongside the unit project it was not, and the symptoms
           * were spectacular and misleading — first a `TRUNCATE` deadlock (two
           * resets racing), earlier a wave of foreign-key failures that read as a
           * logic bug in whichever milestone happened to add the file that tipped
           * it over. Both were one cause: files that were supposed to be
           * sequential were not, in the combined run only.
           *
           * `maxWorkers: 1` is what enforces it. `fileParallelism: false` alone is
           * advisory enough that it did not hold, and `poolOptions.forks.singleFork`
           * — the first attempt at a fix — was silently ignored: Vitest 4 removed
           * `poolOptions`, and an ignored option looks exactly like a working one
           * until the deprecation warning is read. One worker cannot run two files
           * at once, which is the guarantee stated as a constraint rather than as a
           * preference.
           *
           * The unit project keeps its parallelism — it touches nothing shared.
           */
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
});
