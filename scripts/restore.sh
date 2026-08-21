#!/usr/bin/env bash
#
# Restore the production database from a backup (M20).
#
#   scripts/restore.sh /var/backups/payetam/payetam-20260821T030000Z.dump.gpg
#   scripts/restore.sh <dump> --into payetam_recovered   # somewhere else first
#
# ⛔ **This is the destructive one.** Without `--into` it replaces the live
# database. Everything written since the backup is gone — every event, join,
# message and coin movement. Read the whole of this header before running it.
#
# ── When to use this instead of scripts/rollback.sh ──────────────────────────
#
# `rollback.sh` puts old code back and leaves the data alone. That is the right
# move for almost every bad deploy. This script is for the two cases it cannot
# handle:
#
#   * A migration dropped or renamed something, so the old code cannot run
#     against the current schema.
#   * The data itself is wrong — a bad backfill, a destructive admin action, a
#     corrupted table.
#
# ── The order it does things in, which is the point ──────────────────────────
#
#   1. Stop the API and the worker. A half-restored database serving traffic is
#      worse than one that is down: the outbox would relay events that had
#      already been delivered, and every idempotency key would be wrong.
#   2. Take a safety dump of the current state, even though it is the state you
#      are discarding. Restoring the wrong backup is a thing that happens, and
#      it is only recoverable if this exists.
#   3. Restore into a *new* database, then swap names. A `pg_restore` that fails
#      halfway into the live database leaves neither the old data nor the new;
#      restoring beside it means a failure changes nothing at all.
#   4. Verify — table count, the append-only ledger triggers, and the ledger
#      reconciliation from docs/runbook-backup-restore.md.
#   5. Start the API and the worker again.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ARCHIVE="${1:-}"
shift 2> /dev/null || true
TARGET_DB=''
KEEP_STOPPED=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --into)         TARGET_DB="${2:-}"; shift 2 ;;
        --keep-stopped) KEEP_STOPPED=1; shift ;;
        -h|--help)      sed -n '2,40p' "$0"; exit 0 ;;
        *)              die "unknown argument: $1" ;;
    esac
done

[[ -n "$ARCHIVE" ]] || die "usage: scripts/restore.sh <dump[.gpg|.age]> [--into <database>]"
[[ -r "$ARCHIVE" ]] || die "cannot read ${ARCHIVE}"

require_docker
require_env_file

LIVE_DB='payetam'
IN_PLACE=0
if [[ -z "$TARGET_DB" ]]; then
    IN_PLACE=1
    TARGET_DB="$LIVE_DB"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Everything runs through psql/pg_restore in a throwaway container on the
# compose network, so the host needs no Postgres client and the database needs
# no published port.
pg() {
    docker run --rm -i \
        --network payetam-internal \
        --user "$(id -u):$(id -g)" \
        -v "${WORK}:/work" \
        -e "PGPASSWORD=$(env_value POSTGRES_PASSWORD)" \
        postgres:16-alpine "$@"
}

# ── 1. Decrypt, if it is encrypted ───────────────────────────────────────────
DUMP="$ARCHIVE"
case "$ARCHIVE" in
    *.gpg)
        command -v gpg > /dev/null || die "the archive is gpg-encrypted but gpg is not installed"
        log "Decrypting"
        DUMP="${WORK}/restore.dump"
        if [[ -n "${PAYETAM_BACKUP_GPG_PASSFILE:-}" ]]; then
            gpg --batch --quiet --decrypt --passphrase-file "$PAYETAM_BACKUP_GPG_PASSFILE" \
                --output "$DUMP" "$ARCHIVE" || die "decryption failed"
        else
            # No passphrase file: this is a public-key backup, so gpg looks for
            # the private key in the local keyring. If the key is deliberately
            # kept off this machine — which is the recommended setup — decrypt
            # the file wherever the key lives and pass the plaintext here.
            gpg --batch --quiet --decrypt --output "$DUMP" "$ARCHIVE" \
                || die "decryption failed. If the private key is intentionally not on this server, decrypt the archive where the key is and pass the resulting .dump to this script."
        fi
        ;;
    *.age)
        command -v age > /dev/null || die "the archive is age-encrypted but age is not installed"
        [[ -n "${PAYETAM_BACKUP_AGE_IDENTITY:-}" ]] || die "PAYETAM_BACKUP_AGE_IDENTITY must point at the identity file"
        DUMP="${WORK}/restore.dump"
        age --decrypt --identity "$PAYETAM_BACKUP_AGE_IDENTITY" --output "$DUMP" "$ARCHIVE" \
            || die "decryption failed"
        ;;
    *)
        cp "$ARCHIVE" "${WORK}/restore.dump"
        DUMP="${WORK}/restore.dump"
        ;;
esac
chmod 600 "$DUMP"

# ── 2. Is it a real archive? ─────────────────────────────────────────────────
#
# Before anything is stopped. Discovering that the file is truncated *after*
# taking the product down is the sequence this ordering exists to prevent.
log "Reading the archive's table of contents"
entries="$(pg pg_restore --list /work/"$(basename "$DUMP")" 2> /dev/null | grep -c ';' || true)"
(( entries > 10 )) || die "${ARCHIVE} does not look like a usable pg_dump custom-format archive"
ok "${entries} entries"

# ── 3. Confirmation ──────────────────────────────────────────────────────────
echo
if (( IN_PLACE )); then
    cat <<WARNING
  ${C_RED}${C_BOLD}This will REPLACE the live database.${C_RESET}

    archive : ${ARCHIVE}
    dated   : $(date -ur "$ARCHIVE" +'%Y-%m-%d %H:%M:%S UTC' 2> /dev/null || echo unknown)
    target  : ${LIVE_DB} (live)

  Everything written since that archive was taken will be gone: events, joins,
  chat messages, coin movements, admin actions.

  If you only need to undo a bad deploy, stop and use scripts/rollback.sh.

WARNING
    read -r -p "Type 'restore production' to continue: " answer
    [[ "$answer" == 'restore production' ]] || die "Aborted. Nothing was changed."
else
    log "Restoring into ${TARGET_DB}, beside the live database. Nothing live will be touched."
fi

# ── 4. Stop the writers ──────────────────────────────────────────────────────
if (( IN_PLACE )); then
    log "Stopping the API and the worker"
    compose stop api worker
    ok "Stopped. The site is down from here until step 8."
fi

# ── 5. A dump of what is about to be discarded ───────────────────────────────
if (( IN_PLACE )); then
    log "Taking a safety dump of the current state"
    safety="${PAYETAM_BACKUP_DIR:-/var/backups/payetam}/payetam-before-restore-${STAMP}.dump"
    mkdir -p "$(dirname "$safety")"
    chmod 700 "$(dirname "$safety")"
    if docker run --rm --network payetam-internal --user "$(id -u):$(id -g)" \
        -v "$(dirname "$safety"):/out" \
        -e "PGPASSWORD=$(env_value POSTGRES_PASSWORD)" \
        postgres:16-alpine pg_dump -h postgres -U payetam -d "$LIVE_DB" \
        --format=custom --compress=9 --no-owner --no-privileges \
        --file="/out/$(basename "$safety")"; then
        chmod 600 "$safety"
        ok "Current state saved to ${safety}"
    else
        warn "The safety dump failed."
        confirm "Continue without one?" || { compose start api worker; die "Aborted; the stack was restarted."; }
    fi
fi

# ── 6. Restore beside, then swap ─────────────────────────────────────────────
#
# `pg_restore` into the live database with `--clean` drops each object before
# recreating it, so a failure halfway leaves a database with neither the old
# data nor the new. Restoring into a fresh database and renaming is atomic
# enough: the rename is two catalogue updates, and a failure before it changes
# nothing.
SCRATCH="payetam_restore_${STAMP}"
log "Creating ${SCRATCH}"
pg psql -h postgres -U payetam -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${SCRATCH}\";" > /dev/null

log "Restoring (this is the slow step)"
if ! pg pg_restore -h postgres -U payetam -d "$SCRATCH" \
    --no-owner --no-privileges --jobs=4 --exit-on-error \
    "/work/$(basename "$DUMP")"; then
    pg psql -h postgres -U payetam -d postgres -c "DROP DATABASE IF EXISTS \"${SCRATCH}\";" > /dev/null
    (( IN_PLACE )) && compose start api worker
    notify error 'Restore failed' "archive: ${ARCHIVE}"
    die "pg_restore failed. The live database was NOT touched, and the stack has been restarted."
fi
ok "Restored into ${SCRATCH}"

# ── 7. Verify before letting anything near it ────────────────────────────────
verify() {
    local db="$1" tables triggers ledger mismatched
    tables="$(pg psql -h postgres -U payetam -d "$db" -tAc \
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
    triggers="$(pg psql -h postgres -U payetam -d "$db" -tAc \
        "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal")"
    log "${db}: ${tables} tables, ${triggers} triggers"
    (( tables > 10 )) || { err "only ${tables} tables — this is not a complete restore"; return 1; }

    # The append-only guards are the product's hardest guarantee (ADR-0007),
    # they are created by migration rather than by the schema, and a restore
    # that silently dropped them leaves a database that works perfectly and has
    # lost its integrity.
    ledger="$(pg psql -h postgres -U payetam -d "$db" -tAc \
        "SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         WHERE c.relname = 'coin_ledger' AND NOT t.tgisinternal")"
    (( ledger >= 1 )) || { err "coin_ledger has no append-only trigger — the backup is not usable"; return 1; }
    ok "the coin_ledger append-only trigger survived"

    # docs/runbook-backup-restore.md's reconciliation: a cached balance that
    # disagrees with the sum of its ledger rows means the recovery point split a
    # transaction that should not have been split.
    mismatched="$(pg psql -h postgres -U payetam -d "$db" -tAc \
        'SELECT count(*) FROM "user" u
         JOIN (SELECT user_id, SUM(amount) s FROM coin_ledger GROUP BY user_id) l
           ON l.user_id = u.id
         WHERE u.coin_balance <> l.s' 2> /dev/null || echo 'ERR')"
    if [[ "$mismatched" == '0' ]]; then
        ok "every cached coin balance agrees with its ledger"
    elif [[ "$mismatched" == 'ERR' ]]; then
        warn "could not run the ledger reconciliation (the schema may predate it)"
    else
        err "${mismatched} user(s) have a coin_balance that disagrees with the ledger"
        return 1
    fi
}

if ! verify "$SCRATCH"; then
    err "Verification failed. ${SCRATCH} has been kept for inspection."
    (( IN_PLACE )) && compose start api worker
    notify error 'Restore verification failed' "scratch database kept: ${SCRATCH}"
    die "The live database was not touched."
fi

if (( ! IN_PLACE )); then
    pg psql -h postgres -U payetam -d postgres -v ON_ERROR_STOP=1 \
        -c "ALTER DATABASE \"${SCRATCH}\" RENAME TO \"${TARGET_DB}\";" > /dev/null
    ok "Restored to ${TARGET_DB}. The live database was not touched."
    exit 0
fi

log "Swapping ${SCRATCH} into place as ${LIVE_DB}"
retired="payetam_retired_${STAMP}"
# Sessions have to be gone before a rename. The API and the worker are already
# stopped; this catches a psql somebody left open.
pg psql -h postgres -U payetam -d postgres -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname IN ('${LIVE_DB}', '${SCRATCH}') AND pid <> pg_backend_pid();" > /dev/null
pg psql -h postgres -U payetam -d postgres -v ON_ERROR_STOP=1 \
    -c "ALTER DATABASE \"${LIVE_DB}\" RENAME TO \"${retired}\";" \
    -c "ALTER DATABASE \"${SCRATCH}\" RENAME TO \"${LIVE_DB}\";" > /dev/null
ok "Swapped. The previous database is kept as ${retired}."

# ── 8. Back up ───────────────────────────────────────────────────────────────
if (( KEEP_STOPPED )); then
    warn "--keep-stopped: the API and the worker are still down. Start them with: scripts/compose.sh start api worker"
else
    log "Starting the API and the worker"
    compose start api worker
    for _ in $(seq 1 40); do
        state="$(compose ps --format json api 2> /dev/null | grep -o '"Health":"[a-z]*"' | head -1 || true)"
        [[ "$state" == '"Health":"healthy"' ]] && break
        sleep 3
    done
    compose ps
fi

echo
ok "Restored ${LIVE_DB} from ${ARCHIVE}"
notify warn 'Database restored' "archive: ${ARCHIVE}\nprevious database kept as: ${retired}"

cat <<NEXT

  Two things are worth doing now, in this order:

    1. Check the product by hand — sign in, open an event, send a message.
    2. Once you are satisfied, drop the retired copy. It is a full second copy
       of the database and it does not expire:

         scripts/compose.sh exec postgres psql -U payetam -d postgres \\
           -c 'DROP DATABASE "${retired}";'

  Telegram will redeliver webhook updates from the last 24 hours, and the outbox
  relay will resend anything the restored state still has as undelivered. Both
  are idempotent (ADR-0005), so duplicates are absorbed rather than doubled.

NEXT
