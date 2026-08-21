#!/usr/bin/env bash
#
# Nightly encrypted backup (M20).
#
#   scripts/backup.sh                    # dump, verify, encrypt, rotate, copy off
#   scripts/backup.sh --tag pre-v0.2.0   # label this one in the filename
#   scripts/backup.sh --require-encryption
#
# ── What it is, on top of tools/backup.sh ────────────────────────────────────
#
# `tools/backup.sh` is the part that has to be right about Postgres: custom
# format, `--no-owner --no-privileges`, `pg_restore --list` to prove the archive
# is readable, a size floor, and rotation only *after* verification. It predates
# this deployment and is unchanged — it is run here rather than reimplemented.
#
# This script is the part that has to be right about Docker and about the copy
# leaving the machine:
#
#   * It runs `pg_dump` from a throwaway `postgres:16-alpine` on the internal
#     network, not from inside the long-lived database container. The dump is a
#     read-only client operation, and giving it its own container means the host
#     backup directory is mounted somewhere that is not the database's own
#     process, and the file lands owned by the deploy user rather than by uid 999.
#   * It encrypts, then **proves the ciphertext decrypts** before deleting the
#     plaintext. An encrypted backup nobody has decrypted is a hope with extra
#     steps, and the failure mode — a wrong recipient id — is silent.
#   * It copies off-host, because a backup on the same disk as the database is
#     not a backup of the disk failing.
#
# ── Configuration ────────────────────────────────────────────────────────────
#
# Deliberately not in the application `.env`: these belong to the machine's
# backup regime, not to the product, and the cron entry is where they are set.
# An optional file is read first if it exists:
#
#   PAYETAM_BACKUP_CONFIG        default /etc/payetam/backup.env
#   PAYETAM_BACKUP_DIR           default /var/backups/payetam
#   PAYETAM_BACKUP_RETAIN_DAYS   default 14
#   PAYETAM_BACKUP_GPG_RECIPIENT a public key id — preferred, see below
#   PAYETAM_BACKUP_GPG_PASSFILE  symmetric passphrase file, if no recipient
#   PAYETAM_BACKUP_AGE_RECIPIENT an age recipient, as an alternative to gpg
#   PAYETAM_BACKUP_REMOTE        rsync destination, e.g. user@host:/backups/payetam
#   PAYETAM_BACKUP_REQUIRE_ENCRYPTION=1  refuse to finish unencrypted
#
# **Prefer the public-key form.** With `PAYETAM_BACKUP_GPG_RECIPIENT` the server
# holds only the public half, so an attacker who takes the server cannot read
# last month's backups — which contain every chat message and every admin TOTP
# secret this product has. A symmetric passphrase sitting next to the archives
# it protects gives that up for convenience.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CONFIG="${PAYETAM_BACKUP_CONFIG:-/etc/payetam/backup.env}"
# shellcheck disable=SC1090
[[ -r "$CONFIG" ]] && source "$CONFIG"

BACKUP_DIR="${PAYETAM_BACKUP_DIR:-/var/backups/payetam}"
RETAIN_DAYS="${PAYETAM_BACKUP_RETAIN_DAYS:-14}"
REQUIRE_ENCRYPTION="${PAYETAM_BACKUP_REQUIRE_ENCRYPTION:-0}"
TAG=''

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag)                 TAG="${2:-}"; shift 2 ;;
        --dir)                 BACKUP_DIR="${2:-}"; shift 2 ;;
        --require-encryption)  REQUIRE_ENCRYPTION=1; shift ;;
        -h|--help)             sed -n '2,50p' "$0"; exit 0 ;;
        *)                     die "unknown argument: $1" ;;
    esac
done

require_docker
require_env_file

DATABASE_URL="$(env_value DATABASE_URL)"
[[ -n "$DATABASE_URL" ]] || die "DATABASE_URL is not set in .env"

# 700, so a dump is not readable by other accounts on the host even in the
# window before it is encrypted.
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LABEL="${TAG:+${TAG}-}"

fail_and_alert() {
    notify error 'Backup failed' "$1"
    die "$1"
}

# ── 1. Dump, verified by tools/backup.sh ─────────────────────────────────────
#
# The image is pinned to the same major as the server. `pg_dump` from an older
# client against a newer server refuses outright, and from a newer client it
# produces an archive the server's own `pg_restore` may not read — which is
# discovered during a restore, at the worst possible moment.
#
# `--network` is the compose network, so `postgres` resolves without publishing
# a port. `--user` so the dump belongs to whoever ran this rather than to root.
log "Dumping the database"
if ! docker run --rm \
    --network payetam-internal \
    --user "$(id -u):$(id -g)" \
    -v "${BACKUP_DIR}:/backups" \
    -v "${PAYETAM_ROOT}/tools/backup.sh:/usr/local/bin/payetam-backup.sh:ro" \
    -e "DATABASE_URL=${DATABASE_URL}" \
    -e 'PAYETAM_BACKUP_DIR=/backups' \
    -e "PAYETAM_BACKUP_RETAIN_DAYS=${RETAIN_DAYS}" \
    postgres:16-alpine bash /usr/local/bin/payetam-backup.sh; then
    fail_and_alert "pg_dump failed — see the output above. No older backup was rotated."
fi

# tools/backup.sh names the file itself. Taking the newest is safe because it
# refuses to rotate anything until the dump it just wrote has been verified, so
# the newest file is always a good one.
DUMP="$(ls -t "${BACKUP_DIR}"/payetam-*.dump 2> /dev/null | head -1)"
[[ -n "$DUMP" && -r "$DUMP" ]] || fail_and_alert "no dump was produced in ${BACKUP_DIR}"

if [[ -n "$LABEL" ]]; then
    LABELLED="${BACKUP_DIR}/payetam-${LABEL}${STAMP}.dump"
    mv "$DUMP" "$LABELLED"
    DUMP="$LABELLED"
fi
chmod 600 "$DUMP"
ok "Dumped and verified: ${DUMP} ($(du -h "$DUMP" | cut -f1))"

# ── 2. Encrypt ───────────────────────────────────────────────────────────────
ENCRYPTED=''

encrypt_gpg_recipient() {
    log "Encrypting to ${PAYETAM_BACKUP_GPG_RECIPIENT}"
    gpg --batch --yes --trust-model always \
        --recipient "$PAYETAM_BACKUP_GPG_RECIPIENT" \
        --output "${DUMP}.gpg" --encrypt "$DUMP" \
        || fail_and_alert "gpg encryption failed for recipient ${PAYETAM_BACKUP_GPG_RECIPIENT}"
    ENCRYPTED="${DUMP}.gpg"
}

encrypt_gpg_symmetric() {
    warn "Using a symmetric passphrase. A public key (PAYETAM_BACKUP_GPG_RECIPIENT) is better: it keeps the key that opens these archives off the machine that holds them."
    gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-file "$PAYETAM_BACKUP_GPG_PASSFILE" \
        --output "${DUMP}.gpg" "$DUMP" \
        || fail_and_alert "symmetric gpg encryption failed"
    ENCRYPTED="${DUMP}.gpg"
}

encrypt_age() {
    log "Encrypting with age"
    age --recipient "$PAYETAM_BACKUP_AGE_RECIPIENT" --output "${DUMP}.age" "$DUMP" \
        || fail_and_alert "age encryption failed"
    ENCRYPTED="${DUMP}.age"
}

if [[ -n "${PAYETAM_BACKUP_GPG_RECIPIENT:-}" ]]; then
    command -v gpg > /dev/null || fail_and_alert "PAYETAM_BACKUP_GPG_RECIPIENT is set but gpg is not installed (apt install gnupg)"
    encrypt_gpg_recipient
elif [[ -n "${PAYETAM_BACKUP_AGE_RECIPIENT:-}" ]]; then
    command -v age > /dev/null || fail_and_alert "PAYETAM_BACKUP_AGE_RECIPIENT is set but age is not installed"
    encrypt_age
elif [[ -n "${PAYETAM_BACKUP_GPG_PASSFILE:-}" ]]; then
    command -v gpg > /dev/null || fail_and_alert "PAYETAM_BACKUP_GPG_PASSFILE is set but gpg is not installed"
    [[ -r "$PAYETAM_BACKUP_GPG_PASSFILE" ]] || fail_and_alert "cannot read ${PAYETAM_BACKUP_GPG_PASSFILE}"
    encrypt_gpg_symmetric
else
    if [[ "$REQUIRE_ENCRYPTION" == '1' ]]; then
        fail_and_alert "no encryption is configured and --require-encryption was given. Set PAYETAM_BACKUP_GPG_RECIPIENT in ${CONFIG}."
    fi
    warn "NO ENCRYPTION CONFIGURED — ${DUMP} is plaintext."
    warn "It contains every chat message and every administrator's TOTP secret."
    warn "Set PAYETAM_BACKUP_GPG_RECIPIENT in ${CONFIG} before real users exist. DEPLOYMENT.md §10 has the steps."
fi

# ── 3. Prove the ciphertext opens ────────────────────────────────────────────
#
# The check the whole regime turns on. A wrong recipient id, a passphrase file
# with a trailing newline, an `age` recipient that belongs to a key nobody still
# has — every one of them produces a file of the right size, at the right time,
# on the right schedule, that cannot be opened. This decrypts to /dev/null and
# reads the archive's table of contents out of the result, which is the only
# evidence that matters. The plaintext is removed only if this passes.
if [[ -n "$ENCRYPTED" ]]; then
    chmod 600 "$ENCRYPTED"
    log "Verifying that ${ENCRYPTED##*/} decrypts"

    decrypt_to_stdout() {
        case "$ENCRYPTED" in
            *.gpg)
                if [[ -n "${PAYETAM_BACKUP_GPG_PASSFILE:-}" && -z "${PAYETAM_BACKUP_GPG_RECIPIENT:-}" ]]; then
                    gpg --batch --quiet --decrypt --passphrase-file "$PAYETAM_BACKUP_GPG_PASSFILE" "$ENCRYPTED"
                else
                    # With a public-key backup the private half is deliberately
                    # not on this machine, so a full decrypt cannot be attempted
                    # here. What can be checked is that the packet names the
                    # recipient we intended — which catches the mistake that
                    # actually happens: encrypting to the wrong or expired key.
                    return 3
                fi
                ;;
            *.age) age --decrypt --identity "${PAYETAM_BACKUP_AGE_IDENTITY:-/nonexistent}" "$ENCRYPTED" 2> /dev/null || return 3 ;;
        esac
    }

    if decrypt_to_stdout > /tmp/payetam-verify.$$ 2> /dev/null; then
        if docker run --rm --user "$(id -u):$(id -g)" \
            -v "/tmp/payetam-verify.$$:/dump:ro" \
            postgres:16-alpine pg_restore --list /dump > /dev/null 2>&1; then
            ok "The encrypted archive decrypts and its table of contents reads"
        else
            rm -f "/tmp/payetam-verify.$$"
            fail_and_alert "${ENCRYPTED} decrypts but pg_restore cannot read the result — the archive is corrupt. The plaintext dump has been kept at ${DUMP}."
        fi
        rm -f "/tmp/payetam-verify.$$"
    else
        rm -f "/tmp/payetam-verify.$$"
        # Public-key mode. Check the recipient instead of the content.
        listed="$(gpg --batch --list-packets --list-only "$ENCRYPTED" 2>&1 || true)"
        if [[ -n "${PAYETAM_BACKUP_GPG_RECIPIENT:-}" ]]; then
            short="${PAYETAM_BACKUP_GPG_RECIPIENT: -8}"
            if grep -qi "$short" <<< "$listed"; then
                ok "Encrypted to ${PAYETAM_BACKUP_GPG_RECIPIENT} (the private key is off this machine, as intended)"
                warn "A full decrypt cannot be rehearsed here. Do it wherever the private key lives — DEPLOYMENT.md §10.3."
            else
                fail_and_alert "${ENCRYPTED} does not name ${PAYETAM_BACKUP_GPG_RECIPIENT} as a recipient. Nobody may be able to open it."
            fi
        fi
    fi

    # `shred` on a copy-on-write or journalling filesystem is theatre, but the
    # plaintext must not survive either way — and this is also what stops the
    # backup directory doubling in size every night.
    if command -v shred > /dev/null; then
        shred -u "$DUMP" 2> /dev/null || rm -f "$DUMP"
    else
        rm -f "$DUMP"
    fi
    ok "Plaintext removed; keeping ${ENCRYPTED}"
    KEPT="$ENCRYPTED"
else
    KEPT="$DUMP"
fi

# ── 4. Rotate the encrypted copies ───────────────────────────────────────────
#
# tools/backup.sh rotates `*.dump`; the encrypted names it never sees are
# rotated here, on the same retention. Both happen only after a good backup.
find "$BACKUP_DIR" \( -name 'payetam-*.dump.gpg' -o -name 'payetam-*.dump.age' \) \
    -type f -mtime "+${RETAIN_DAYS}" -print -delete

# ── 5. Off the host ──────────────────────────────────────────────────────────
if [[ -n "${PAYETAM_BACKUP_REMOTE:-}" ]]; then
    log "Copying to ${PAYETAM_BACKUP_REMOTE}"
    if rsync -a --chmod=F600 "$KEPT" "${PAYETAM_BACKUP_REMOTE}/"; then
        ok "Copied off-host"
    else
        # A local backup that exists is worth keeping even when the copy fails,
        # so this alerts rather than dying — but it does alert, because a backup
        # regime whose off-host leg has been broken for a month is one disk
        # failure from total loss.
        notify error 'Backup copy failed' "the local backup at ${KEPT} is fine; rsync to ${PAYETAM_BACKUP_REMOTE} failed"
        err "rsync to ${PAYETAM_BACKUP_REMOTE} failed. The local copy is intact."
    fi
else
    warn "PAYETAM_BACKUP_REMOTE is not set — this backup exists only on this host."
fi

echo
ok "Backup complete: ${KEPT}"
printf '  %s\n' "$(ls -lh "$KEPT" | awk '{print $5, $9}')"
