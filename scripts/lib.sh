#!/usr/bin/env bash
#
# Shared helpers for the deployment scripts (M20).
#
# Sourced, never executed. Everything here is either a fact about where the
# repository is or a wrapper that exists because getting the raw form of it
# wrong is a known way to break a deployment.

# `-u` matters more than it looks: half of these functions read variables out of
# an operator-edited `.env`, and an unset one should stop the script rather than
# expand to nothing and be concatenated into a connection string.
set -euo pipefail

# The repository root, derived from this file rather than from the caller's
# working directory — so every script below works from anywhere, including from
# a cron entry whose CWD is `/`.
PAYETAM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PAYETAM_ROOT

readonly PAYETAM_COMPOSE_FILE="${PAYETAM_ROOT}/docker/docker-compose.prod.yml"
readonly PAYETAM_ENV_FILE="${PAYETAM_ROOT}/.env"

# ── Output ───────────────────────────────────────────────────────────────────
#
# Colour only when stdout is a terminal. These scripts run from cron and from CI
# as often as from a shell, and escape sequences in a log file are noise that
# makes `grep` miss the line you are looking for.
if [[ -t 1 ]]; then
    readonly C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_RED=$'\033[31m'
    readonly C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[34m'
else
    readonly C_RESET='' C_BOLD='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
fi

log()  { printf '%s==>%s %s\n' "${C_BLUE}${C_BOLD}" "$C_RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s  !%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s  ✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# A step the operator must confirm. Skipped entirely when PAYETAM_YES=1, which
# is how the CI deploy job runs — and which is why every *destructive* prompt
# below asks for a typed word instead of calling this.
confirm() {
    local prompt="$1"
    if [[ "${PAYETAM_YES:-0}" == '1' ]]; then
        warn "PAYETAM_YES=1 — assuming yes: ${prompt}"
        return 0
    fi
    local answer
    read -r -p "${prompt} [y/N] " answer
    [[ "$answer" == 'y' || "$answer" == 'Y' ]]
}

# ── Compose ──────────────────────────────────────────────────────────────────
#
# Every invocation goes through here, with an absolute `-f`. Compose resolves
# `env_file` and relative volume paths against the *compose file's* directory,
# so an absolute path makes the whole stack independent of where the script was
# called from — including from cron, whose working directory is `/`.
compose() {
    docker compose -f "$PAYETAM_COMPOSE_FILE" "$@"
}

# ── Reading the environment file ─────────────────────────────────────────────
#
# Deliberately *not* `set -a; source .env`. Sourcing an operator-edited file
# executes it: a stray backtick or `$(…)` in a password runs as a shell command
# with the deploy user's privileges. This reads one key, takes the last
# assignment (so a duplicated line behaves the way the file looks), and never
# evaluates anything.
env_value() {
    local key="$1"
    [[ -r "$PAYETAM_ENV_FILE" ]] || die "cannot read ${PAYETAM_ENV_FILE}"
    sed -n "s/^${key}=//p" "$PAYETAM_ENV_FILE" | tail -1
}

require_env_file() {
    [[ -f "$PAYETAM_ENV_FILE" ]] \
        || die ".env is missing. Copy .env.production.example to .env and fill it in."

    # 600, and checked rather than assumed. The file holds the bot token, both
    # JWT secrets and the key that every stored message is encrypted under.
    local mode
    mode="$(stat -c '%a' "$PAYETAM_ENV_FILE")"
    if [[ "$mode" != '600' ]]; then
        warn ".env is mode ${mode}; it should be 600. Fixing."
        chmod 600 "$PAYETAM_ENV_FILE"
    fi
}

require_docker() {
    command -v docker > /dev/null 2>&1 || die "docker is not installed"
    docker compose version > /dev/null 2>&1 \
        || die "the docker compose plugin is not installed (v2 is required)"
    docker info > /dev/null 2>&1 \
        || die "cannot talk to the Docker daemon — is it running, and are you in the docker group?"
}

# ── Alerting ─────────────────────────────────────────────────────────────────
#
# Never fatal, and never allowed to abort the caller: a deploy that succeeded
# and could not announce itself is a successful deploy. `|| true` at every call
# site would be easy to forget, so the guard is here instead.
notify() {
    "${PAYETAM_ROOT}/scripts/notify-telegram.sh" "$@" || true
}
