---
name: integration-tests
description: Run the integration vitest project safely — exclusivity check, test-database isolation, and a build first. Use when running or debugging any *.int.test.ts, or when many unrelated suites fail at once.
---

# integration-tests

## Purpose

Run the `integration` project without destroying a developer's data, another
run's fixtures, or half a day. Background: `.memory/runtime/integration-tests.md`.

## When to invoke

Running or debugging an `*.int.test.ts`; before a tag; whenever a batch of
unrelated suites fails together.

## Preconditions — check all three, in order

1. **Nothing else is running it.**
   ```bash
   pgrep -f 'vitest[.]mjs run'
   ```
   Any hit ⇒ **stop and wait.** Two runs TRUNCATE each other's fixtures and the
   failures look like real regressions. Note the bracket — `pgrep -f "vitest.mjs
   run"` matches the checking shell itself and never clears.

2. **`TEST_DATABASE_URL` is set in `.env`.** If not, run `make db-test` once and
   add the line it prints. Without it the suite falls back to `DATABASE_URL` and
   TRUNCATEs it. **If the working directory's `.env` holds production
   credentials, stop — do not run here at all.**

3. **`dist/` is current.** `rtk proxy pnpm typecheck` (runs `tsc -b`). The suite
   loads built output, and `apps/api/src/telegram/webhook.int.test.ts:135`
   imports `../../dist/app.module.js` literally — stale `dist` means testing
   yesterday's code.

## Steps

```bash
make up                     # Postgres + Redis, if not already healthy
pnpm test:integration       # or: pnpm test --project integration
```

One file: `pnpm test --project integration <path>`. Budget ~30–35 min for the
whole project.

## Failure handling

- **Many unrelated failures** → suspect a concurrent run before believing any of
  it. Re-run alone and compare.
- **Hangs with zero tests executed** → host cannot reach the containers. Check
  `.memory/local/environment.md` if present.
- **A file fails at boot rather than on an assertion** → the five secrets
  (`CHAT_ENCRYPTION_KEY`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
  `PII_HASH_PEPPER`, `TELEGRAM_BOT_TOKEN`) are missing.
- **`response-leak.int.test.ts` fails on an unlisted route** → a new endpoint was
  added without registering it in the scan. That is the point of the test; add it.

## Safety

TRUNCATEs the test database — never the development one, provided precondition 2
holds. Never run against a production `.env`. Never start a second run.

## Expected output

Pass/fail counts, the isolation checks confirmed, and whether any suite was
re-run alone to rule out concurrency.

## Memory update

New isolation hazards go in `.memory/runtime/integration-tests.md`, merged into
the existing sections.
