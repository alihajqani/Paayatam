#!/usr/bin/env bash
#
# Nightly logical backup (plan §9 M16).
#
# Two mechanisms, because they fail differently and a product needs both:
#
#   * This script — `pg_dump`, once a night. Restores to *last night*, takes minutes,
#     and survives things WAL archiving does not: a corrupted data directory, a
#     dropped table, a bad migration. It is also the only backup you can restore into
#     a *different* Postgres version.
#   * WAL archiving (see `docs/runbook-backup-restore.md`) — continuous. Restores to
#     any second, which is what turns "we lost a day" into "we lost ninety seconds".
#
# Neither replaces the other. A dump alone means the product's worst day loses up to
# twenty-four hours of events, joins and messages; WAL alone means a corrupt base
# backup takes the whole archive with it.
#
# Exits non-zero on any failure, and `set -o pipefail` matters more here than
# usual: `pg_dump | gzip` succeeds as far as the shell is concerned when pg_dump
# fails and gzip cheerfully compresses an empty stream. That is precisely how a
# backup regime ends up with a year of 20-byte files nobody looked inside.
set -euo pipefail

BACKUP_DIR="${PAYETAM_BACKUP_DIR:-/var/backups/payetam}"
RETAIN_DAYS="${PAYETAM_BACKUP_RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/payetam-${STAMP}.dump"

if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is not set" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"

# Custom format (-Fc), not plain SQL: it is compressed, it can be restored
# selectively with `pg_restore -t`, and it can be restored in parallel with `-j`.
# The last one is the difference between a forty-minute outage and a ten-minute one.
#
# `--no-owner --no-privileges` so a restore into a fresh cluster with a different
# role name does not fail on every GRANT. The roles are created by the deploy, not
# by the backup.
echo "Dumping to ${TARGET}"
pg_dump "$DATABASE_URL" \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-privileges \
    --file="$TARGET"

# Verify the dump can be *read* before declaring success. `pg_restore --list` parses
# the archive's table of contents, which catches a truncated or corrupt file for the
# price of a second. A backup nobody has opened is a hope, not a backup.
if ! pg_restore --list "$TARGET" > /dev/null; then
    echo "Dump at ${TARGET} is not readable — refusing to rotate older backups" >&2
    exit 1
fi

SIZE="$(stat -c %s "$TARGET")"
# A dump smaller than this is not a small database, it is a failed dump. The schema
# alone is well over 100 kB.
if (( SIZE < 51200 )); then
    echo "Dump is only ${SIZE} bytes — refusing to rotate older backups" >&2
    exit 1
fi

echo "Wrote ${TARGET} (${SIZE} bytes), verified readable"

# Rotation happens *after* verification, and only then. Deleting last week's backups
# before confirming tonight's is valid is how a single bad night becomes a total loss.
find "$BACKUP_DIR" -name 'payetam-*.dump' -type f -mtime "+${RETAIN_DAYS}" -print -delete

# The dump is useless on the same disk as the database. Off-host copy is deliberately
# a separate command rather than baked in: the destination is deployment-specific,
# and a script that silently skipped it when unset would look like it was working.
if [[ -n "${PAYETAM_BACKUP_REMOTE:-}" ]]; then
    echo "Copying to ${PAYETAM_BACKUP_REMOTE}"
    rsync -a --chmod=F600 "$TARGET" "${PAYETAM_BACKUP_REMOTE}/"
else
    echo "PAYETAM_BACKUP_REMOTE is not set — backup exists only on this host" >&2
fi
