---
name: verify
description: Run this repository's correctness gates in the right order and report honestly. Use before claiming work is done, before a commit, and before a tag. Works around the RTK filter, which reports a failing typecheck as green with exit 0.
---

# verify

## Purpose

Establish whether the working tree is actually green. The naive form of this
check lies here: see `.memory/runtime/verification.md`.

## When to invoke

Before saying work is complete; before a commit; before a tag; whenever asked
"is it passing?".

## Preconditions

- Dependencies installed (`pnpm install`, or `make setup` on a fresh clone).
- No integration run in flight — `pgrep -f 'vitest[.]mjs run'`. If one is,
  wait; do not start a second (`.memory/runtime/integration-tests.md`).

## Steps

1. **Typecheck — never the bare `rtk pnpm <script>` shorthand.**
   ```bash
   make typecheck
   ```
   `rtk pnpm typecheck` prints `TypeScript: No errors found` and **exits 0** on a
   failing tree. `make typecheck`, `rtk pnpm run typecheck` and
   `rtk proxy pnpm typecheck` all report correctly; a `PreToolUse` hook blocks
   the bad one. This step also emits `dist/` via `tsc -b`.

2. **Lint and format.**
   ```bash
   pnpm lint
   pnpm format:check
   ```

3. **Fast tests.**
   ```bash
   pnpm test --project unit --project miniapp --project admin
   ```

4. **Build**, when the change touches either frontend:
   ```bash
   pnpm build
   ```

5. **Integration** — required before a tag, optional otherwise. Delegate to the
   `integration-tests` skill; do not start it inline.

   Do **not** reach for `make check` as a shortcut: it runs `vitest run`, which
   is all four projects including the ~30-min integration suite.

6. **Wizard change?** `pnpm bot-walkthrough` — every screen, no DB, no network.

## Safety

Read-only. Starts no containers, writes no database, contacts no network
service. Never run with `PAYETAM_YES=1`.

## Validation

Report the actual exit status of each step. A step not run is reported as not
run — never inferred from another step passing.

## Expected output

Per gate: pass / fail / skipped, with the failing output quoted for any fail.
State plainly whether the integration suite was run.

## Memory update

If a gate's command or ordering changes, update
`.memory/runtime/verification.md` — one canonical entry, merged not appended.
