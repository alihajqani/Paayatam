#!/usr/bin/env bash
#
# Rehearse a restore, without touching anything live (M20).
#
#   scripts/restore-rehearsal.sh                     # the newest backup
#   scripts/restore-rehearsal.sh <path-to-archive>   # a specific one
#   scripts/restore-rehearsal.sh --keep              # leave the scratch database
#
# A backup script that has never been restored from is not a backup regime, it
# is a cron job. Every failure that matters here is invisible until somebody
# tries: an archive truncated by a full disk, a dump that lost the `citext`
# extension, a restore that dies on a GRANT, an encryption recipient nobody has
# the key for any more. All five-minute problems on a Tuesday and unbounded
# outages at 3 a.m.
#
# `tools/restore-rehearsal.sh` is the part that knows what to check — it restores
# into a scratch database, times it, counts tables, triggers and extensions, and
# asserts by name that the `coin_ledger` append-only trigger survived (ADR-0007).
# It is run here rather than reimplemented. This script is the Docker and
# decryption wrapper around it, and the thing that picks the right archive.
#
# The recorded duration is the number worth having: it is the answer to "how long
# would a restore take", and the only honest way to get it is to have done one.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

BACKUP_DIR="${PAYETAM_BACKUP_DIR:-/var/backups/payetam}"
CONFIG="${PAYETAM_BACKUP_CONFIG:-/etc/payetam/backup.env}"
# shellcheck disable=SC1090
[[ -r "$CONFIG" ]] && source "$CONFIG"
BACKUP_DIR="${PAYETAM_BACKUP_DIR:-$BACKUP_DIR}"

ARCHIVE=''
KEEP=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --keep)    KEEP=1; shift ;;
        -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
        -*)        die "unknown option: $1" ;;
        *)         ARCHIVE="$1"; shift ;;
    esac
done

require_docker
require_env_file

# Newest first across all three shapes, so a regime that switched from plaintext
# to gpg last week rehearses the gpg one.
if [[ -z "$ARCHIVE" ]]; then
    ARCHIVE="$(ls -t "${BACKUP_DIR}"/payetam-*.dump "${BACKUP_DIR}"/payetam-*.dump.gpg \
        "${BACKUP_DIR}"/payetam-*.dump.age 2> /dev/null | head -1 || true)"
    [[ -n "$ARCHIVE" ]] || die "no backup found in ${BACKUP_DIR}. Run scripts/backup.sh first."
fi
[[ -r "$ARCHIVE" ]] || die "cannot read ${ARCHIVE}"

log "Rehearsing ${ARCHIVE}"
log "Taken $(date -ur "$ARCHIVE" +'%Y-%m-%d %H:%M:%S UTC' 2> /dev/null || echo 'at an unknown time')"

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

DUMP="${WORK}/rehearsal.dump"
case "$ARCHIVE" in
    *.gpg)
        command -v gpg > /dev/null || die "the archive is gpg-encrypted but gpg is not installed"
        log "Decrypting"
        if [[ -n "${PAYETAM_BACKUP_GPG_PASSFILE:-}" ]]; then
            gpg --batch --quiet --decrypt --passphrase-file "$PAYETAM_BACKUP_GPG_PASSFILE" \
                --output "$DUMP" "$ARCHIVE" || die "decryption failed"
        else
            gpg --batch --quiet --decrypt --output "$DUMP" "$ARCHIVE" \
                || die "decryption failed. With a public-key backup the private half is deliberately not on this server — rehearse on the machine that holds it, which is the rehearsal that proves the whole chain anyway."
        fi
        ;;
    *.age)
        command -v age > /dev/null || die "the archive is age-encrypted but age is not installed"
        [[ -n "${PAYETAM_BACKUP_AGE_IDENTITY:-}" ]] || die "PAYETAM_BACKUP_AGE_IDENTITY must point at the identity file"
        age --decrypt --identity "$PAYETAM_BACKUP_AGE_IDENTITY" --output "$DUMP" "$ARCHIVE" || die "decryption failed"
        ;;
    *)
        cp "$ARCHIVE" "$DUMP"
        ;;
esac
chmod 600 "$DUMP"

# The connection string the rehearsal tool uses. It rewrites the database part
# itself — and refuses outright unless the target name contains 'rehearsal' or
# 'scratch', which is the guard that stops this ever restoring over production.
DATABASE_URL="$(env_value DATABASE_URL)"
[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set in .env"

log "Restoring into a scratch database"
output="$(docker run --rm \
    --network payetam-internal \
    --user "$(id -u):$(id -g)" \
    -v "${WORK}:/work" \
    -v "${PAYETAM_ROOT}/tools/restore-rehearsal.sh:/usr/local/bin/rehearse.sh:ro" \
    -e "DATABASE_URL=${DATABASE_URL}" \
    -e "PAYETAM_RESTORE_TARGET=payetam_restore_rehearsal" \
    -e "PAYETAM_RESTORE_KEEP=${KEEP}" \
    postgres:16-alpine bash /usr/local/bin/rehearse.sh /work/rehearsal.dump 2>&1)" || {
    printf '%s\n' "$output"
    notify error 'Restore rehearsal failed' "archive: ${ARCHIVE}"
    die "The rehearsal failed. This backup is not usable — treat it as an incident, not as a test problem."
}

printf '%s\n' "$output" | sed 's/^/  /'

seconds="$(grep -o 'REHEARSAL_SECONDS=[0-9]*' <<< "$output" | tail -1 | cut -d= -f2)"
echo
ok "The backup restores. Recorded duration: ${seconds:-unknown}s"

if (( KEEP )); then
    warn "--keep: payetam_restore_rehearsal is still there. Drop it when you are done:"
    warn "  scripts/compose.sh exec postgres psql -U payetam -d postgres -c 'DROP DATABASE payetam_restore_rehearsal;'"
fi

cat <<NOTE

  Record this in docs/runbook-backup-restore.md: the date, the archive's size and
  the duration. A rehearsal nobody wrote down is a rehearsal nobody can quote
  when they are asked how long recovery takes.

NOTE
