#!/usr/bin/env bash
#
# Schema migrations and the RBAC seed (M20).
#
#   scripts/migrate.sh          # migrate, then seed:rbac
#   scripts/migrate.sh --status # show what would run, change nothing
#
# Run **before** the API is started, not after: an API on the new code against
# the old schema is the failure that produces 500s on the paths a deploy is most
# likely to have touched. `scripts/deploy.sh` calls this in the right order.
#
# ── What runs, and what deliberately does not ────────────────────────────────
#
# `prisma migrate deploy` applies pending migrations and nothing else. It never
# generates, never resets, and never prompts — it is the production half of the
# CLI, and the one that refuses to do anything creative.
#
# `seed:rbac` runs after it, every time, because it is idempotent by
# construction: it upserts the permission catalogue and the role→permission
# mapping, which is a *fixed list that the code depends on*. A new permission
# added by a migration exists in the schema and does nothing until this has run.
#
# **Every other seed is excluded, and none of them is safe to add here.**
# `seed:catalog`, `seed:policies`, `seed:blacklist` and `seed:settings` write
# content someone may have edited in the admin panel since. `seed:events` writes
# fake events. `seed:gift-codes-dev` writes coins and refuses outright unless
# NODE_ENV is development or test. DEPLOYMENT.md §8 lists the ones worth running
# once by hand on a brand-new database, with what each of them overwrites.
#
# ── Why through a container ──────────────────────────────────────────────────
#
# The `tools` image carries the Prisma CLI, the migration files and `tsx` — all
# devDependencies the runtime images do not have. Running migrations from it
# rather than from the host is what keeps the server's only requirement to
# Docker: no Node, no pnpm, and no chance of the migration running under a
# different Prisma version from the one the image was built with.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

STATUS_ONLY=0
[[ "${1:-}" == '--status' ]] && STATUS_ONLY=1

require_docker
require_env_file

log "Making sure Postgres is up"
compose up -d postgres

# `depends_on: service_healthy` on the tools service covers this too, but the
# message when it times out there is about a dependency rather than about the
# database — and this is the step people actually wait on after a reboot.
for _ in $(seq 1 60); do
    if compose exec -T postgres pg_isready -U payetam -d payetam > /dev/null 2>&1; then
        ok "Postgres is accepting connections"
        break
    fi
    sleep 2
done
compose exec -T postgres pg_isready -U payetam -d payetam > /dev/null 2>&1 \
    || die "Postgres did not become ready. Check: scripts/compose.sh logs postgres"

if (( STATUS_ONLY )); then
    log "Migration status"
    compose --profile tools run --rm tools pnpm --filter @payetam/db db:status
    exit 0
fi

log "Applying migrations"
if ! compose --profile tools run --rm tools pnpm db:migrate:deploy; then
    notify error 'Migration failed' 'prisma migrate deploy exited non-zero; the API was not started'
    die "Migrations failed. The API has not been started. Nothing was rolled back — Prisma applies one migration per transaction, so the schema is at the last one that succeeded. Check: scripts/migrate.sh --status"
fi
ok "Schema is up to date"

log "Seeding RBAC (idempotent)"
compose --profile tools run --rm tools pnpm seed:rbac \
    || die "seed:rbac failed. Permissions may be incomplete — the admin panel will 403 on screens whose permission is missing."
ok "Roles and permissions are current"
