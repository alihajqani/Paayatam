#!/usr/bin/env bash
#
# Deploy a tagged release (M20).
#
#   scripts/deploy.sh v0.2.0          # deploy that tag
#   scripts/deploy.sh                 # deploy the current checkout, unchanged
#   scripts/deploy.sh v0.2.0 --no-pull
#
# ── The order, and why it is this order ──────────────────────────────────────
#
#   1. Check the environment          — a placeholder secret found here costs a
#                                       minute; found after the images are built
#                                       it costs a crash loop.
#   2. Record what is running now     — the rollback target. Written to disk
#                                       *before* anything changes, because after
#                                       a failure is exactly when it cannot be
#                                       derived.
#   3. Fetch and check out the tag
#   4. Build the images               — nothing is stopped yet. A build that
#                                       fails leaves the previous release
#                                       serving traffic, untouched.
#   5. Migrate                        — before the new API starts. New code on
#                                       an old schema produces 500s on exactly
#                                       the paths the release touched.
#   6. Start                          — Compose replaces containers whose image
#                                       changed and leaves the rest alone.
#   7. Verify                         — health, then smoke tests. A deploy that
#                                       is not verified is a deploy whose
#                                       failure is discovered by a user.
#
# Steps 1–4 are reversible by doing nothing. Step 5 is the point of no return —
# a migration is not undone by `rollback.sh`, which is why the backup in step 5
# is taken rather than suggested.
#
# **Short downtime is expected.** Containers are replaced rather than drained,
# and the API's 30-second grace period lets in-flight requests finish. Telegram
# redelivers webhook updates it could not deliver, and the outbox in Postgres
# means nothing queued is lost (ADR-0005).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TAG=''
PULL=1
SKIP_MIGRATE=0
SKIP_BACKUP=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-pull)     PULL=0; shift ;;
        --no-migrate)  SKIP_MIGRATE=1; shift ;;
        --no-backup)   SKIP_BACKUP=1; shift ;;
        -h|--help)     sed -n '2,40p' "$0"; exit 0 ;;
        -*)            die "unknown option: $1" ;;
        *)             TAG="$1"; shift ;;
    esac
done

require_docker
cd "$PAYETAM_ROOT"

started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

# ── 1. The environment ───────────────────────────────────────────────────────
log "Checking the environment"
"${PAYETAM_ROOT}/scripts/check-env.sh"

# ── 2. Where to go back to ───────────────────────────────────────────────────
#
# Read here, written after the checkout — see below. In a file rather than in a
# variable either way, because the thing that needs it is a *later invocation*
# of a different script after this one has exited badly.
mkdir -p "${PAYETAM_ROOT}/.deploy"
previous="$(git rev-parse --short HEAD)"
previous_ref="$(git describe --tags --exact-match 2> /dev/null || echo "$previous")"
log "Currently deployed: ${previous_ref}"

# ── 3. The code ──────────────────────────────────────────────────────────────
if [[ -n "$TAG" ]]; then
    if (( PULL )); then
        log "Fetching tags"
        git fetch --tags --prune origin
    fi

    git rev-parse -q --verify "refs/tags/${TAG}" > /dev/null \
        || die "tag ${TAG} does not exist. Available: $(git tag --sort=-creatordate | head -5 | tr '\n' ' ')"

    # Refused rather than stashed. A tracked file edited on the server is either
    # a hotfix somebody will lose or a mistake, and both deserve a human.
    if ! git diff --quiet || ! git diff --cached --quiet; then
        die "the working tree has uncommitted changes. Commit, stash or discard them first: git status"
    fi

    log "Checking out ${TAG}"
    git checkout --quiet --detach "$TAG"
    ok "At $(git rev-parse --short HEAD) (${TAG})"

    # ── The rollback target, recorded now that the tree has actually moved ────
    #
    # This used to be written in step 2, before the fetch. A deploy that died at
    # `git fetch` — no agent forwarded, no key on the server, which is exactly
    # how it fails — had by then overwritten the file with the release that was
    # still running. `previous-release` and `current-release` both said v0.4.5,
    # so `rollback.sh` was a no-op at the one moment somebody reaches for it,
    # and the real target it had been holding was gone.
    #
    # Nothing had been deployed, so there was nothing to go back *from*: the
    # file should not have moved. Written here, it moves only once there is a
    # checkout to undo — and a build that fails after this point still leaves a
    # correct target, which is the window the file exists for.
    #
    # Re-deploying the tag that is already out is the same argument: it would
    # make the rollback target the thing you are rolling back from.
    if [[ "$previous_ref" != "$TAG" ]]; then
        printf '%s\n' "$previous_ref" > "${PAYETAM_ROOT}/.deploy/previous-release"
    else
        warn "Re-deploying ${TAG}; leaving the rollback target where it is"
    fi
else
    warn "No tag given — deploying the current checkout at ${previous_ref}"
fi

release="$(git describe --tags --always --dirty)"
export PAYETAM_VERSION="$release"

# ── 4. Images ────────────────────────────────────────────────────────────────
#
# Built before anything is stopped. This is the slow step on a small VPS, and it
# is also the one most likely to fail — which is exactly why the currently
# running release must still be serving traffic while it happens.
log "Validating the compose file"
compose config > /dev/null
ok "Compose file is valid"

log "Building images (this is the slow part)"
if ! compose build; then
    notify error 'Deploy failed: build' "release: ${release}\nnothing was stopped; the previous release is still serving"
    die "Build failed. Nothing was stopped — ${previous_ref} is still serving."
fi
ok "Images built"

# ── 5. Backup, then migrate ──────────────────────────────────────────────────
#
# The backup is taken here and not earlier, so it is as close as possible to the
# migration — the one step of a deploy that a rollback cannot undo.
if (( SKIP_MIGRATE )); then
    warn "Skipping migrations (--no-migrate)"
else
    if (( SKIP_BACKUP )); then
        warn "Skipping the pre-migration backup (--no-backup)"
    elif compose ps --status running --services 2> /dev/null | grep -qx postgres; then
        log "Taking a backup before migrating"
        "${PAYETAM_ROOT}/scripts/backup.sh" --tag "pre-${release}" \
            || die "the pre-migration backup failed. Refusing to migrate without one — a migration is the one part of a deploy that rollback.sh cannot undo."
    else
        warn "Postgres is not running yet — this looks like a first deploy, so there is nothing to back up"
    fi

    "${PAYETAM_ROOT}/scripts/migrate.sh"
fi

# ── 6. Start ─────────────────────────────────────────────────────────────────
log "Starting the stack"
compose up -d --remove-orphans

# nginx caches the API's address from when it started, so a replaced API
# container leaves it pointed at an address that no longer exists — 502 on every
# proxied route until something reloads it. Cheap, and skipping it is a class of
# outage that looks like the API failing to start.
log "Reloading nginx against the new API"
compose exec -T nginx nginx -s reload 2> /dev/null || compose restart nginx

# ── 7. Verify ────────────────────────────────────────────────────────────────
log "Waiting for the API to report healthy"
healthy=0
for _ in $(seq 1 60); do
    state="$(compose ps --format json api 2> /dev/null | grep -o '"Health":"[a-z]*"' | head -1 || true)"
    if [[ "$state" == '"Health":"healthy"' ]]; then
        healthy=1
        break
    fi
    if [[ "$state" == '"Health":"unhealthy"' ]]; then
        break
    fi
    sleep 3
done

if (( ! healthy )); then
    err "The API did not become healthy."
    compose logs --tail 60 api
    notify error 'Deploy failed: API unhealthy' \
        "release: ${release}\nprevious: ${previous_ref}\nroll back with: scripts/rollback.sh"
    die "Deploy failed. Roll back with: scripts/rollback.sh"
fi
ok "API is healthy"

log "Smoke tests"
if ! "${PAYETAM_ROOT}/scripts/smoke-tests.sh"; then
    notify error 'Deploy failed: smoke tests' \
        "release: ${release}\nprevious: ${previous_ref}\nroll back with: scripts/rollback.sh"
    die "Smoke tests failed. Roll back with: scripts/rollback.sh"
fi

printf '%s\n' "$release" > "${PAYETAM_ROOT}/.deploy/current-release"

echo
compose ps
echo
ok "Deployed ${release} (was ${previous_ref})"
notify info 'Deploy succeeded' "release: ${release}\nprevious: ${previous_ref}\nstarted: ${started_at}"

cat <<NEXT

  If the webhook path or the public hostname changed, re-register the webhook:

    scripts/set-webhook.sh

  Follow the logs with:

    scripts/compose.sh logs -f api worker

NEXT
