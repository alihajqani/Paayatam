# Repository memory — index

Operational knowledge that has no home in the source tree. **Architecture lives
elsewhere**: `CLAUDE.md` (always loaded), `PROJECT_MEMORY.md` (orientation cache,
§7 traps / §8 frozen positions / §9 abstracted patterns), `docs/adr/` (18 ADRs).
Nothing here restates them — this is the *running and releasing* layer.

## Routing — read only what the task touches

| Working on | Read |
|---|---|
| Any verification / "is this done?" step | [runtime/verification.md](runtime/verification.md) |
| `*.int.test.ts`, `test/`, `vitest.config.mts` | [runtime/integration-tests.md](runtime/integration-tests.md) |
| `scripts/`, `docker/`, tags, `CHANGELOG.md` | [workflows/release.md](workflows/release.md) |
| `packages/db/prisma/**` | `CLAUDE.md` §Architecture Rules → ADR-0002, 0006, 0007 |
| `apps/api/src/telegram/**`, `packages/telegram/**` | `PROJECT_MEMORY.md` §10, ADR-0017 |
| `apps/{miniapp,admin}/**` | `docs/admin-panel.md` §13, ADR-0003 |
| Anything security-shaped | `SECURITY.md`, `docs/threat-model.md`, `CLAUDE.md` §Security Rules |

Skills: `/verify`, `/integration-tests`, `/release`, `/memory-sync`, `/session-end`
(`.claude/skills/`). Closing a session runs `/session-end`, not a stop.

Guards: `.claude/hooks/` + `.claude/settings.json` — a `PreToolUse(Bash)` hook
blocks the one RTK form that reports a failing typecheck as green; a
`UserPromptSubmit` hook nudges a close request toward `/session-end`.

## Verification policy

Every fact here carries a tag. No tag ⇒ not a fact yet.

- `[validated: path:line]` — read in the source tree
- `[validated: cmd …]` — a command was run and its output observed
- `[needs-verification: reason]` — believed, not proven; do not act on it alone

Re-verify a `path:line` tag before relying on it — line numbers drift.

## Update policy

Merge into the canonical entry; never append a duplicate. One fact, one home.
Delete what the code has invalidated. Keep this index under ~50 lines. Do not
record secrets, hostnames, IPs, credentials, or one-off debugging detail.
Machine-specific facts go in `local/` (gitignored), never in a committed entry.

## Concurrency

Several sessions may share this tree. Re-read a file immediately before editing
it, edit the one section you own, and never rewrite a whole entry to change a
line. `.memory/local/` is per-machine and never merged.
