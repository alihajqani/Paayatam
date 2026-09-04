# Verification — what "green" actually means here

**Scope:** running the correctness gates. **Read when:** about to claim work is
done, before a commit, before a tag.

## One RTK form reports a red typecheck as green

`rtk pnpm typecheck` prints `TypeScript: No errors found` **and exits 0** while
`tsc` exits 2. The masked exit code is the dangerous half — a `&&` chain
proceeds on a broken tree.

Measured with rtk 0.45.0 against a one-line `TS2322` probe, 2026-09-03
`[validated: cmd, five forms compared]`:

| Form | Exit | Reports |
|---|---|---|
| `rtk pnpm typecheck` | **0** | `No errors found` ← **masks** |
| `rtk pnpm run typecheck` | 2 | `error TS2322` |
| `rtk make typecheck` | 2 | `error TS2322` |
| `rtk proxy pnpm typecheck` | 2 | `error TS2322` |
| `pnpm typecheck` | 2 | `error TS2322` |

**Only the bare `rtk pnpm <script>` shorthand is affected.** Adding `run`, going
through `make`, or `proxy` all report correctly — RTK stays useful everywhere else.

`rtk pnpm test --project unit` returned **exit 1** on a failing test and printed
it — **tests are not masked** `[validated: cmd, failing probe test]`.
`rtk pnpm lint` returned exit 1 on a `no-explicit-any` violation `[validated: cmd]`.

### The guard

`.claude/hooks/block-masked-typecheck.sh`, registered as a `PreToolUse(Bash)`
hook in `.claude/settings.json`, denies that one form and names the
alternatives. It strips heredoc bodies and requires a command boundary, so
*writing* about the bad form does not trip it, and it **fails open** on any
internal error. Repository-local — nothing under `~/.claude/` was changed.
`[validated: cmd, 12-case matrix incl. both false-positive shapes]`

## The gates, in order

```bash
make typecheck                  # tsc -b + vue-tsc; also emits dist/
pnpm lint && pnpm format:check
pnpm test --project unit --project miniapp --project admin
pnpm build
```

`make typecheck` runs `tsc -b`, so it also **produces the `dist/`** the
integration suite loads `[validated: package.json "typecheck"]`. Running it first
is what makes that suite honest — see [integration-tests.md](integration-tests.md).

**`make check` is not a fast gate.** It is `typecheck lint test`
`[validated: Makefile:168]`, and `test` is `vitest run` — *all four projects,
integration included* `[validated: package.json:19]`. It timed out past 10 min
when run as a "quick check" on 2026-09-03 `[validated: cmd]`.

Its comment claims "What CI runs on every commit". It is wrong in both
directions: CI runs `pnpm test --project unit` (fast, not integration) **and**
`format:check` plus four grep gates that `make check` omits
`[validated: .github/workflows/ci.yml]`. Use the explicit list above; treat
`make check` as "everything, slowly".

## Failure modes

- Green typecheck, broken code → the bare shorthand. The hook now prevents it;
  if it fires, use `make typecheck`.
- **Stale `dist/` after deleting a source file.** `tsc -b` leaves the old `.js`
  and `.d.ts` behind, and the integration suite loads `dist`. Delete by hand:
  `find packages/*/dist apps/*/dist -name '<gone>.*'`. Hit while cleaning up a
  probe file on 2026-09-03 `[validated: cmd]`.
- A totality test (`response-leak.int.test.ts`) only fails in the ~30-min
  integration suite, so it is the check that gets skipped. Run it before tagging
  `[validated: PROJECT_MEMORY.md §7 trap 20 + apps/api/src/response-leak.int.test.ts]`.

## Update when

RTK's version changes — re-run the five-form comparison. Or `package.json`
scripts change, or the hook's matcher needs widening.
