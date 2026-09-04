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
   or `--no-backup` `[validated: scripts/deploy.sh:48-50]`. **`--no-pull` is
   currently mandatory** — see §"`git fetch` exits 1".
6. **Bot commands** — only when `BOT_COMMANDS` changes, added *or* removed
   `[validated: packages/telegram/src/commands.ts:37, tools/set-bot-commands.ts]`.
7. **Verify** — `.deploy/current-release`, `GET /api/v1/version`
   `[validated: apps/api/src/version/version.controller.ts:33,44]`, and the
   release broadcast fired once. **Any failed check ⇒ `scripts/rollback.sh`.**

## `git fetch` exits 1, so `deploy.sh` aborts before it starts

`deploy.sh` sources `lib.sh`, which sets `set -euo pipefail`, and step 3 runs
`git fetch --tags --prune origin` `[validated: scripts/deploy.sh:80,
scripts/lib.sh:12]`. Three legacy tags — `v0.3.0`, `v0.6.5`, `v0.6.6` — differ
between the server's copy and GitHub, so the fetch reports
`! [rejected] … (would clobber existing tag)` and **exits 1**, which `set -e`
turns into an abort `[validated: cmd — `git fetch --tags --prune origin
--dry-run` on the server, exit 1, 2026-09-04]`.

**So every deploy needs `--no-pull` until those tags are reconciled.** That is
sanctioned; the forbidden flags are `--no-migrate` and `--no-backup`. It is only
safe once the tag is already on the server, so verify first:

```bash
ssh <host> 'cd /srv/payetam && git fetch --tags 2>/dev/null; git rev-parse v0.X.Y'
```

and check the hash against `git ls-remote --tags origin v0.X.Y` locally. A
partially-rejected fetch still fetches the *new* tags, which is why this works.

## A deploy that dies before the checkout changes nothing

Steps 1–4 are reversible by doing nothing, and the rollback target is written
**after** the checkout precisely so a failed fetch cannot overwrite it
`[validated: scripts/deploy.sh:97-108, and observed 2026-09-04 — a fetch failure
left `current-release` at the running version and every container untouched]`.

**Do not run `rollback.sh` after a failure at step 1–3.** Nothing was deployed,
so it would "roll back" to the release that is already serving.

## Deploying broadcasts to every user

`release.announce_enabled` defaults to **1** and `ReleaseAnnouncementService`
runs in `onModuleInit`, so a deploy messages the whole user base once per version
`[validated: packages/domain/src/catalog/settings.service.ts:442; observed
2026-09-04 — "Announced release v0.8.1 to 15 recipients"]`. Exactly-once is
`message_campaign.idempotency_key`, not the call site.

It is read **at boot**, so the only window to suppress it is *before* the deploy:
set the `app_setting` row to 0.

## Production state that changes what a release does

The channel-membership gate is **on**, with all five actions including
`APP_ACCESS`, `verify_via_telegram = t`, and one active required channel that has
both a chat identifier and a join link `[validated: cmd — `select … from
event_channel_config` / `required_channel`, 2026-09-04]`. The table is
`event_channel_config`, not `channel_config`.

That matters because `APP_ACCESS` is enforced on the bot's router for every
message, command and tap: a release touching the gate changes what every
non-member can do at all. Re-read the rows before shipping one — this is live
configuration and may have moved.

## Known production gaps, surfaced by `check-env.sh` and `deploy.sh`

Not blocking, reported on every deploy, and worth fixing before the product
carries real traffic:

- `MONITORING_CHAT_ID` is empty ⇒ `TelegramLoggerService` has nowhere to send
  alerts, so a post-deploy failure is silent.
- `PAYETAM_BACKUP_GPG_RECIPIENT` unset ⇒ pre-migration dumps are plaintext.
- `PAYETAM_BACKUP_REMOTE` unset ⇒ they exist only on that host.

`[validated: cmd — deploy.sh output, 2026-09-04]` `DEPLOYMENT.md` §10 has the
backup steps.

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
a new confirmation gate is added, the divergent legacy tags are reconciled (which
would retire the `--no-pull` requirement), or the membership gate's live
configuration moves.
