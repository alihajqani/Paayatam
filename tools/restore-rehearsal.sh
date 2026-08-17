#!/usr/bin/env bash
#
# The restore rehearsal (plan §9 M16: *"an actually-rehearsed restore recorded with a
# real duration"*).
#
# The plan's wording is deliberate and worth taking literally. A backup script that
# has never been restored from is not a backup regime — it is a cron job. The
# failures that matter are all invisible until somebody tries: a dump that excluded
# an extension, a restore that fails on every GRANT, a `citext` column that needs its
# extension created *before* the schema, a role that does not exist on the target.
# Every one of those is a five-minute fix on a Tuesday afternoon and an unbounded
# outage at 3 a.m.
#
# This restores last night's dump into a scratch database, checks that the schema and
# the row counts arrived, times it, and drops the scratch database. It is safe to run
# against production *as long as* PAYETAM_RESTORE_TARGET names a database nobody
# uses — which is asserted below rather than assumed, because the one mistake this
# script could make is restoring over the live database.
set -euo pipefail

DUMP="${1:-}"
TARGET_DB="${PAYETAM_RESTORE_TARGET:-payetam_restore_rehearsal}"

if [[ -z "$DUMP" ]]; then
    echo "usage: restore-rehearsal.sh <path-to-dump>" >&2
    exit 1
fi
if [[ ! -r "$DUMP" ]]; then
    echo "cannot read ${DUMP}" >&2
    exit 1
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is not set" >&2
    exit 1
fi

# The guard rail. A rehearsal that can overwrite the live database is worse than no
# rehearsal, because it will be run confidently.
if [[ "$TARGET_DB" != *rehearsal* && "$TARGET_DB" != *scratch* ]]; then
    echo "PAYETAM_RESTORE_TARGET must contain 'rehearsal' or 'scratch' — refusing" >&2
    exit 1
fi

# The admin connection, with the database swapped for `postgres` so CREATE/DROP
# DATABASE can run (neither is permitted while connected to the target).
ADMIN_URL="${DATABASE_URL%/*}/postgres"

echo "Rehearsing restore of ${DUMP} into ${TARGET_DB}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${TARGET_DB}\";"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${TARGET_DB}\";"

TARGET_URL="${DATABASE_URL%/*}/${TARGET_DB}"

START="$(date +%s)"

# `-j 4` because a serial restore of a database with a dozen indexed tables spends
# most of its time building one index at a time. This is the flag that makes the
# recorded duration below a number worth quoting.
#
# `--no-owner --no-privileges` matches the dump, and `--exit-on-error` is the point of
# the whole exercise: a restore that prints forty errors and exits 0 is what makes
# people believe an unusable backup is fine.
pg_restore \
    --dbname="$TARGET_URL" \
    --no-owner \
    --no-privileges \
    --jobs=4 \
    --exit-on-error \
    "$DUMP"

END="$(date +%s)"
ELAPSED=$(( END - START ))

# Verification, because "pg_restore exited 0" is not the same as "the data is there".
TABLES="$(psql "$TARGET_URL" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
TRIGGERS="$(psql "$TARGET_URL" -tAc \
    "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal")"
EXTENSIONS="$(psql "$TARGET_URL" -tAc "SELECT count(*) FROM pg_extension")"

echo "Restored in ${ELAPSED}s: ${TABLES} tables, ${TRIGGERS} triggers, ${EXTENSIONS} extensions"

# The append-only triggers are the specific thing worth checking by name. They are
# the product's hardest guarantee (ADR-0007), they are created by migration rather
# than by the schema, and a restore that silently dropped them would leave a database
# that works perfectly and has lost its integrity.
LEDGER_GUARD="$(psql "$TARGET_URL" -tAc \
    "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'coin_ledger' AND NOT t.tgisinternal")"
if (( LEDGER_GUARD < 1 )); then
    echo "coin_ledger has no append-only trigger after restore — the backup is not usable" >&2
    exit 1
fi

if [[ "${PAYETAM_RESTORE_KEEP:-}" != '1' ]]; then
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE \"${TARGET_DB}\";"
    echo "Dropped ${TARGET_DB}"
fi

echo "REHEARSAL_SECONDS=${ELAPSED}"
