# Integration tests — isolation and exclusivity

**Scope:** the `integration` vitest project. **Read when:** running, writing or
debugging an `*.int.test.ts`, or when a batch of unrelated suites fails at once.

## Three ways to lose a day

**1. Two runs at once destroy each other.** Every test TRUNCATEs the shared
database `[validated: test/integration/setup.ts]`, so a second
`vitest run --project integration` started while one is in flight wrecks both.
The symptom is a scatter of plausible failures across unrelated files — read as a
regression, is not one. Observed 2026-08-31: 525 failures in 15 files; re-run
alone, 1452 passed `[needs-verification: figures from session notes, not re-run]`.

`vitest.config.mts` documents `maxWorkers: 1` for workers **inside** one run
`[validated: vitest.config.mts]`. **The cross-process hazard is enforced by
nothing.** Never run `pnpm test` and an integration run concurrently.

**2. A waiter that matches itself.** `pgrep -f "vitest.mjs run"` finds the
waiting shell's own command line, so the loop never exits. Use the bracket trick:

```bash
until ! pgrep -f 'vitest[.]mjs run' > /dev/null; do sleep 30; done
```

**3. It runs `dist`, not your edits.** The `integration` project defines no
`@payetam/*` alias, so packages resolve through `node_modules` to their built
output `[validated: vitest.config.mts]`, and `apps/api/src/telegram/webhook.int.test.ts:135`
imports `../../dist/app.module.js` literally. **Build first** —
`rtk proxy pnpm typecheck` does it via `tsc -b`.

## Database isolation

`test/integration/setup.ts` falls back to `DATABASE_URL` when `TEST_DATABASE_URL`
is unset, warns, and proceeds to TRUNCATE it `[validated:
test/integration/setup.ts]`. Run `make db-test` once — it creates `payetam_test`,
migrates it, and prints the `TEST_DATABASE_URL` line to add to `.env`
`[validated: Makefile]`.

**Never run vitest from a directory whose `.env` holds production credentials.**
The fallback makes that a production TRUNCATE.

## Boot-time requirements

Two files boot the real Nest app — `apps/api/src/response-leak.int.test.ts` and
`apps/api/src/telegram/webhook.int.test.ts`. Without `CHAT_ENCRYPTION_KEY`,
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `PII_HASH_PEPPER` and
`TELEGRAM_BOT_TOKEN` they fail **at boot**, not on an assertion `[validated:
.github/workflows/ci.yml, "Integration tests" env block]`.

## Decorator syntax does not work in a `*.test.ts` file

A `@Module({...}) class X {}` written **inside a test file** fails to load with
`SyntaxError: Invalid or unexpected token`; the same decorator in a non-test `.ts`
file that the test imports works `[validated: cmd npx vitest run --project unit,
observed both ways]`. It is the test-file transform, not Nest and not the
tsconfig.

So a test that has to build a Nest module inline applies the decorator as the
call it compiles to:

```ts
class RootModule {}
Module({ imports: [...] })(RootModule);   // returns void — do not chain
Global()(RootModule);
```

`Module(...)` and `Global()` both return `void`, so
`Module(meta)(class {})` evaluates to `undefined` and Nest then throws on
`Reflect.defineMetadata`. Decorate a named class, then pass the class.
`[validated: apps/api/src/telegram/membership-probe.module.test.ts]`

## Cost

~42 min for the whole project on this machine `[validated: cmd npx vitest run
--project integration, 2505 s wall, 1498 tests]`. `webhook.int.test.ts` alone is
the long pole at roughly a third of it.

## Update when

`vitest.config.mts` gains an alias, `setup.ts` changes its fallback, or the
`dist` import in `webhook.int.test.ts` is replaced.
