import { defineConfig } from 'vitest/config';

/**
 * Two projects, deliberately separated:
 *
 * - `unit` is fast and runs on every save. No database, no network.
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
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.ts'],
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
          // Integration tests share a database. Running files in parallel would
          // make them fight over the same rows and produce flaky results that
          // look like concurrency bugs but are not.
          fileParallelism: false,
        },
      },
    ],
  },
});
