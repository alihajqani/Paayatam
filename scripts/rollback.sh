#!/usr/bin/env bash
#
# Go back to the previous release (M20).
#
#   scripts/rollback.sh            # back to what .deploy/previous-release names
#   scripts/rollback.sh v0.1.9     # back to a specific tag
#
# ── What this does and does not undo ─────────────────────────────────────────
#
# It undoes **code**: the API, the worker, and both frontend bundles, all of
# which live in images built from one tree. That is why the bundles are baked
# into the nginx image rather than bind-mounted from the host — a `git checkout`
# of the old tag would not rebuild a mounted `dist/`, and the rollback would
# leave yesterday's API serving today's Mini App.
#
# It does **not** undo the database. Prisma migrations have no down step in this
# repository, by design: an automatic down migration is how a bad afternoon turns
# into data loss. So:
#
#   * A release that only added columns or tables rolls back cleanly. The old
#     code ignores what it does not know about.
#   * A release that dropped or renamed something does not. The old code will
#     query a column that is gone. For that case the path is restore, not
#     rollback — `scripts/restore.sh` with the backup `deploy.sh` took just
#     before it migrated, and that backup is exactly why it takes one.
#
# The script says which of the two you are in, as far as it can tell, and makes
# you confirm before doing anything.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_docker
cd "$PAYETAM_ROOT"

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
    [[ -f "${PAYETAM_ROOT}/.deploy/previous-release" ]] \
        || die "no .deploy/previous-release recorded. Name the tag explicitly: scripts/rollback.sh <tag>"
    TARGET="$(cat "${PAYETAM_ROOT}/.deploy/previous-release")"
fi

current="$(git describe --tags --always --dirty)"

git rev-parse -q --verify "${TARGET}^{commit}" > /dev/null \
    || die "'${TARGET}' is not a commit or tag this checkout knows about. Try: git fetch --tags"

log "Rolling back from ${current} to ${TARGET}"

# ── Did anything migrate between the two? ────────────────────────────────────
#
# A cheap, honest check: count the migration directories that exist now and did
# not exist at the target. It cannot tell an additive migration from a
# destructive one — nothing can, without reading the SQL — so it reports the
# fact and leaves the judgement to a person.
migrations_added="$(git diff --name-only --diff-filter=A "${TARGET}" HEAD \
    -- 'packages/db/prisma/migrations/**/migration.sql' 2> /dev/null | wc -l)"

if (( migrations_added > 0 )); then
    echo
    warn "${migrations_added} migration(s) were applied since ${TARGET}. This rollback does NOT undo them."
    git diff --name-only --diff-filter=A "${TARGET}" HEAD \
        -- 'packages/db/prisma/migrations/**/migration.sql' 2> /dev/null \
        | sed 's|packages/db/prisma/migrations/||; s|/migration.sql||; s|^|      |'
    cat <<'WARNING'

  Read them before continuing.

    * Only ADD COLUMN / CREATE TABLE / CREATE INDEX — the old code ignores what
      it does not know about, and this rollback is safe.
    * Any DROP or RENAME — the old code will query something that is gone. Stop
      here and restore instead:

        scripts/restore.sh /var/backups/payetam/payetam-pre-<release>-<stamp>.dump.gpg

WARNING
    confirm "Continue with the code rollback anyway?" || die "Aborted. Nothing was changed."
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
    die "the working tree has uncommitted changes. Commit, stash or discard them first."
fi

log "Checking out ${TARGET}"
git checkout --quiet --detach "$TARGET"

release="$(git describe --tags --always --dirty)"
export PAYETAM_VERSION="$release"

log "Rebuilding images at ${release}"
compose build || die "Build failed at ${TARGET}. The stack is untouched and still running ${current}."

log "Restarting"
compose up -d --remove-orphans

log "Reloading nginx"
compose exec -T nginx nginx -s reload 2> /dev/null || compose restart nginx

log "Waiting for the API"
healthy=0
for _ in $(seq 1 60); do
    state="$(compose ps --format json api 2> /dev/null | grep -o '"Health":"[a-z]*"' | head -1 || true)"
    [[ "$state" == '"Health":"healthy"' ]] && { healthy=1; break; }
    sleep 3
done

if (( ! healthy )); then
    compose logs --tail 60 api
    notify error 'Rollback failed' "target: ${TARGET}\nthe API is not healthy after rolling back"
    die "The API is not healthy after rolling back to ${TARGET}. This usually means the database has moved past what this code understands — restore from the pre-migration backup."
fi

printf '%s\n' "$release" > "${PAYETAM_ROOT}/.deploy/current-release"

"${PAYETAM_ROOT}/scripts/smoke-tests.sh" || warn "Smoke tests failed after the rollback — investigate before declaring this recovered."

echo
ok "Rolled back to ${release} (was ${current})"
notify warn 'Rolled back' "now: ${release}\nwas: ${current}\nmigrations not undone: ${migrations_added}"
