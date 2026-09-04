---
name: release
description: Cut and ship a tagged release — validate, version, changelog, tag, deploy, verify, roll back on failure. Use when asked to tag, release, deploy, or roll back.
---

# release

## Purpose

Run the release end to end, in an order where a failure is recoverable.
Reference: `.memory/workflows/release.md`.

## When to invoke

"tag this", "release", "deploy", «دپلوی کن», or a rollback request.

## Authorisation

The operator has a standing instruction that "deploy" means run the whole
sequence and report afterwards, rather than confirming each step. **That
instruction covers the steps below and nothing else.** It is not permission to
skip the backup, skip the migration, force-push, or restore a database.

If it has *not* been given in this session and the request is ambiguous, ask once
before the first irreversible act (push, tag, deploy) — then proceed.

## Preconditions

1. `/verify` is green, **including the integration suite**. The response-leak
   totality test only fails there, so a skipped run means an unverified release.
2. Working tree clean; `git status` read, not assumed.
3. Changes are on a branch, not `master`.

## Steps

1. **Version** — next tag by convention from existing tags and `CHANGELOG.md`.
2. **Changelog** — summarise `git log <last-tag>..HEAD` into Keep-a-Changelog
   sections at the top of `CHANGELOG.md`. **No tag without an entry.**
3. **Commit and tag** — `chore: add CHANGELOG for v<X>`; tag at that commit.
4. **Deploy** — `./scripts/deploy.sh <tag>` on the server. It checks the
   environment, records the rollback target, builds, migrates, starts, verifies.
   **Never pass `--no-migrate` or `--no-backup`.** `--no-pull` is correct only
   where the host cannot fetch.
5. **Bot commands** — only if `BOT_COMMANDS` changed, added *or* removed:
   ```bash
   PAYETAM_VERSION=v0.X.Y ./scripts/compose.sh --profile tools run --rm tools pnpm set-bot-commands
   ```
   Omitting `PAYETAM_VERSION` silently runs a stale `:local` image and fails as
   though the image were broken.
6. **Verify** — `.deploy/current-release`, `GET /api/v1/version` matches the tag,
   `scripts/smoke-tests.sh` (also needs `PAYETAM_VERSION` when run by hand), and
   the release broadcast fired exactly once.

## Failure handling

**Any failed verification ⇒ `scripts/rollback.sh`, then report the failure.** Do
not attempt a fix-forward on a live deployment without saying so first.

## Safety

- Never set `PAYETAM_YES=1` in an interactive session — it turns every `confirm`
  into an automatic yes.
- `scripts/restore.sh` is **not** part of this workflow. It types
  `restore production` for a reason and is never run to fix a bad deploy.
- Migrations are additive-only, which is what makes rollback safe;
  `rollback.sh` does not undo them.

## Expected output

One summary: version, main changes, healthy or rolled back. Flag material
consequences — a price change, a broadcast reaching every user — in that summary.

## Memory update

Changes to flags, ordering or image tagging go in `.memory/workflows/release.md`.
