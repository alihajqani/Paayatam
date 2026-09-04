# Release — tag to verified deploy

**Scope:** cutting and shipping a release. **Read when:** asked to tag, release,
deploy, or roll back. **Operator preference:** «دپلوی کن» / "deploy" is a
standing instruction to run the whole sequence and decide on the way — report
afterwards, do not ask step by step.

## Order

1. **Validate first.** [../runtime/verification.md](../runtime/verification.md),
   then the integration suite — the response-leak totality test only fails there.
2. **Version.** Next tag by convention (`v0.7.0` → `v0.8.0`), from existing tags
   and `CHANGELOG.md`.
3. **Changelog.** Summarise `git log <last-tag>..HEAD` into Keep-a-Changelog
   sections at the top of `CHANGELOG.md`. **No tag ships without an entry** — the
   tag is the unit `deploy.sh` and `rollback.sh` work in `[validated:
   CHANGELOG.md header; scripts/deploy.sh:202; scripts/rollback.sh:36-38]`.
   The file starts at v0.6.5 on purpose; earlier tags were not reconstructed.
4. **Commit and tag.** `chore: add CHANGELOG for v<X>`, tag at that commit.
5. **Deploy** — `./scripts/deploy.sh <tag>` on the server. Never `--no-migrate`
   or `--no-backup` `[validated: scripts/deploy.sh:48-50]`.
6. **Bot commands** — only when `BOT_COMMANDS` changes, added *or* removed
   `[validated: packages/telegram/src/commands.ts:37, tools/set-bot-commands.ts]`.
7. **Verify** — `.deploy/current-release`, `GET /api/v1/version`
   `[validated: apps/api/src/version/version.controller.ts:33,44]`, and the
   release broadcast fired once. **Any failed check ⇒ `scripts/rollback.sh`.**

## The `PAYETAM_VERSION` trap

`tools` and every service image are tagged `${PAYETAM_VERSION:-local}`
`[validated: docker/docker-compose.prod.yml:455]`. Omit the variable and Compose
silently runs a stale `:local` image; `set-bot-commands` then fails with
«Command not found» as though the image were broken.

```bash
PAYETAM_VERSION=v0.X.Y ./scripts/compose.sh --profile tools run --rm tools pnpm set-bot-commands
```

`scripts/smoke-tests.sh` needs it too — it asserts `/api/v1/version` equals
`${PAYETAM_VERSION:-local}` `[validated: scripts/smoke-tests.sh:100]`.
`deploy.sh` exports it itself; only hand-run commands need it on the line.

## Confirmation policy — as the scripts actually enforce it

| Action | Gate |
|---|---|
| `deploy.sh` | **none** — no `confirm` call in the script |
| `rollback.sh` | `confirm` on the degraded path only `[:75]` |
| `set-webhook.sh --delete` | `confirm` `[:107]` |
| `restore.sh` | types `restore production` `[:141]` |
| `make reset` | types `reset` `[validated: Makefile]` |

`confirm()` returns true unconditionally when `PAYETAM_YES=1` `[validated:
scripts/lib.sh:44-49]` — CI sets it; a human session should not.

**An agent still asks before pushing, tagging or deploying** unless the operator
has said to run the release — the scripts' lack of a prompt is not permission.

## Update when

`scripts/deploy.sh` changes its flags or order, the image tagging scheme changes,
or a new confirmation gate is added.
