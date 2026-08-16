/**
 * Integration-test bootstrap.
 *
 * Loads `.env` so a developer can run `pnpm test:integration` against the local
 * `make up` stack without exporting anything by hand. CI sets the variables in
 * the workflow instead, and has no `.env` — hence the tolerated failure.
 */
try {
  process.loadEnvFile();
} catch {
  // No .env file. Expected in CI, where the workflow supplies the environment.
}

/**
 * These tests TRUNCATE every table before each one. That is the right behaviour
 * for a test database and a genuinely destructive one for a development
 * database, so `TEST_DATABASE_URL` exists to keep them apart: set it (see
 * `make db-test`) and your seeded dev data survives.
 *
 * The fallback to `DATABASE_URL` is what CI uses, where the database is a
 * throwaway service container. It is announced rather than silent, because a
 * developer who has not set the variable is about to lose their seed data and
 * should find out from a warning rather than from an empty catalog.
 */
const testUrl = process.env['TEST_DATABASE_URL'];
if (!testUrl) {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL is set. Integration tests run ' +
        'against a real Postgres — start one with `make up`, then `make db-test`.',
    );
  }
  if (!process.env['CI']) {
    console.warn(
      '\n  TEST_DATABASE_URL is not set, so integration tests will run against ' +
        'DATABASE_URL\n  and TRUNCATE it. Run `make db-test` to get a separate ' +
        'test database.\n',
    );
  }
} else {
  /**
   * Point `DATABASE_URL` at the test database too.
   *
   * `createTestPrisma` already prefers `TEST_DATABASE_URL`, but the leak scan
   * boots the real Nest application, and the application builds its client from
   * `DATABASE_URL` like any other process would. Without this line that one test
   * would quietly truncate and re-seed a developer's development database while
   * every other test used the test one.
   */
  process.env['DATABASE_URL'] = testUrl;
}
