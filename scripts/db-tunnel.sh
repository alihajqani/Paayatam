#!/usr/bin/env bash
#
# An SSH tunnel from a local port to the **production** database.
#
#   scripts/db-tunnel.sh                      # deploy@$PAYETAM_SSH_HOST -> localhost:5555
#   scripts/db-tunnel.sh -H deploy@1.2.3.4    # host on the command line
#   scripts/db-tunnel.sh -p 6000              # a different local port
#
# ── Why this is not just `ssh -L 5555:localhost:5432` ────────────────────────
#
# The production Postgres publishes no host port (docker/docker-compose.prod.yml
# — only nginx has a `ports:` block). There is nothing listening on the server's
# own loopback to forward to. The container is reachable from the host over the
# `payetam-internal` bridge, though, so this asks the server for the container's
# current address and forwards to *that*.
#
# Resolved on every run rather than written down: Compose gives the container a
# fresh address from the pinned 172.28.1.0/24 subnet each time it is recreated,
# which is every deploy. A hardcoded address works right up until the first
# release after somebody wrote it down.
#
# ── This is the production database ──────────────────────────────────────────
#
# It holds real users' encrypted messages, the coin ledger and the moderation
# queue. A session opened here bypasses every application-level control —
# RBAC, the audit log, the immutable-ledger invariants — which is R3 in
# docs/threat-model.md, accepted rather than mitigated.
#
# Read-only inspection is what this is for. Prefer `\set QUIET on` + a
# `BEGIN; … ROLLBACK;` around anything exploratory, and use the migration
# pipeline (`scripts/migrate.sh`) for anything that should actually persist.
#
# Nothing is printed that a shoulder-surfer could use: the password stays on the
# server. Read it there when you need it —
#
#   ssh <host> "sed -n 's/^POSTGRES_PASSWORD=//p' /srv/payetam/.env"
#
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

LOCAL_PORT=5555
SSH_HOST="${PAYETAM_SSH_HOST:-}"
REMOTE_ROOT="${PAYETAM_REMOTE_ROOT:-/srv/payetam}"
SERVICE=postgres
REMOTE_PORT=5432

usage() {
    cat <<'EOF'
scripts/db-tunnel.sh — forward a local port to the production database.

  -H, --host <user@host>  The server. Defaults to $PAYETAM_SSH_HOST.
  -p, --port <n>          Local port to listen on. Default 5555.
  -r, --root <path>       Repository root on the server. Default /srv/payetam.
      --redis             Tunnel Redis (6379) instead of Postgres.
  -h, --help              This.

  scripts/db-tunnel.sh -H deploy@1.2.3.4
  psql "postgresql://payetam@127.0.0.1:5555/payetam"

The production Postgres publishes no host port, so this resolves the container's
address on the server first and forwards to that. Read the header of this file
before writing anything: the session bypasses every application-level control.
EOF
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -H | --host)  SSH_HOST="$2";    shift 2 ;;
        -p | --port)  LOCAL_PORT="$2";  shift 2 ;;
        -r | --root)  REMOTE_ROOT="$2"; shift 2 ;;
        --redis)      SERVICE=redis; REMOTE_PORT=6379; shift ;;
        -h | --help)  usage 0 ;;
        *)            err "unknown argument: $1"; usage 1 ;;
    esac
done

[[ -n "$SSH_HOST" ]] || die "no server. Pass -H deploy@host, or set PAYETAM_SSH_HOST."
[[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] || die "local port must be a number, got: ${LOCAL_PORT}"

# Checked here rather than left to ssh, which reports a busy local port as a
# warning on stderr and then sits there connected but not forwarding — a tunnel
# that looks up and refuses every query. `ExitOnForwardFailure` below turns that
# into an exit; this turns it into a sentence.
if command -v ss > /dev/null 2>&1 && ss -ltn "sport = :${LOCAL_PORT}" | grep -q LISTEN; then
    die "port ${LOCAL_PORT} is already in use locally. Close it, or pass -p <other>."
fi

log "Asking ${SSH_HOST} where the ${SERVICE} container is"

# One round trip, and the compose file is addressed absolutely for the same
# reason scripts/compose.sh does it: `env_file` and relative volumes resolve
# against the compose file's directory, not the caller's.
#
# `{{range …}}` because the service is attached to exactly one network today and
# this should not start returning an empty string if it is ever attached to two.
remote_ip="$(
    ssh -o BatchMode=yes "$SSH_HOST" \
        "set -e
         cid=\$(docker compose -f '${REMOTE_ROOT}/docker/docker-compose.prod.yml' ps -q '${SERVICE}')
         [ -n \"\$cid\" ] || { echo 'no ${SERVICE} container is running' >&2; exit 1; }
         docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' \"\$cid\"" \
        | tr ' ' '\n' | grep -m1 . || true
)"

[[ -n "$remote_ip" ]] || die "could not resolve the ${SERVICE} container's address on ${SSH_HOST}"
ok "${SERVICE} is at ${remote_ip}:${REMOTE_PORT} on the server's bridge network"

log "Forwarding localhost:${LOCAL_PORT} -> ${remote_ip}:${REMOTE_PORT}"
if [[ "$SERVICE" == 'postgres' ]]; then
    printf '\n    psql "postgresql://payetam@127.0.0.1:%s/payetam"\n\n' "$LOCAL_PORT"
    warn 'This is production data. See the header of this script before you write anything.'
fi
log 'Ctrl-C closes the tunnel.'

# -N: forward only, no remote shell. Nothing here needs a TTY, and a shell on a
#     forwarding session is one stray command away from being run as `deploy`.
# ExitOnForwardFailure: fail loudly instead of holding open a tunnel that
#     forwards nothing.
# ServerAlive*: a dropped tunnel that still looks connected is the failure mode
#     this avoids — the client notices in ~90s and exits. It is not paranoia:
#     the first run of this script ended exactly that way when the path to the
#     server degraded, and the exit is what made it obvious rather than leaving
#     a dead port that accepts connections and answers nothing.
# AddressFamily=inet: bind v4 only. Without it ssh resolves the listen address
#     to both 127.0.0.1 and ::1 and attempts both, so one busy family prints
#     `bind: Address already in use` while the tunnel comes up anyway on the
#     other — a real failure that reads like a warning, next to a working port.
exec ssh -N \
    -o ExitOnForwardFailure=yes \
    -o AddressFamily=inet \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -L "127.0.0.1:${LOCAL_PORT}:${remote_ip}:${REMOTE_PORT}" \
    "$SSH_HOST"
