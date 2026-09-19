#!/usr/bin/env bash
#
# Deploy a tagged release to the production server, from your own machine.
#
#   scripts/deploy-remote.sh v0.18.1              # check, confirm, deploy that tag
#   scripts/deploy-remote.sh --latest             # the newest v* tag
#   scripts/deploy-remote.sh v0.18.1 --dry-run    # every check, no change on the server
#   scripts/deploy-remote.sh --status             # what the server is running now
#   scripts/deploy-remote.sh --rollback [tag]     # back to .deploy/previous-release
#   scripts/deploy-remote.sh --attach <key>       # follow a deploy that is still running
#   scripts/deploy-remote.sh --diagnose           # the server does not answer: why?
#
#   --yes                    do not ask for confirmation (not for destructive migrations)
#   --bot-commands           republish the Telegram command menu even if it did not change
#   --skip-remote-check      do not ask GitHub whether the tag is pushed (offline only)
#
# Setup, once: copy `scripts/deploy-remote.env.example` to `~/.config/payatam/remote.env`
# (or `.deploy/remote.env` in the checkout) and fill in the SSH target. Both places
# are outside version control, so nothing about your server ever reaches the
# repository. See README.md, "Deploying with one script".
#
# ── What it is ───────────────────────────────────────────────────────────────
#
# The whole documented release procedure as one command, for the day nobody is
# around to type it:
#
#   1. Checks the tag: it exists, CHANGELOG.md has its entry, it is pushed to
#      GitHub and is the same commit there.
#   2. Reads the server (read-only): what runs now, whether the checkout has
#      changes it does not understand, whether a deploy is already running.
#   3. Shows what will change — migrations (flagging DROP/RENAME), whether the bot
#      command menu changed, settings defaults touched, the release broadcast —
#      and asks.
#   4. Sends the tag to the server as a git bundle. The server has no route to
#      GitHub, and `git fetch --tags` there aborts on legacy tags anyway, so
#      nothing is ever pulled.
#   5. Starts `deploy-remote-runner.sh` on the server, DETACHED, and follows its
#      log. It runs the repository's own `scripts/deploy.sh <tag> --no-pull`:
#      environment check, backup, migrate, build, start, health, smoke tests.
#      Losing your connection does not stop it (`--attach` re-joins).
#   6. If the new release fails its checks after it started, the runner rolls back
#      by itself when the migrations were additive-only; if they were not, it
#      stops and says so.
#
# It never passes `--no-migrate` or `--no-backup`, and has no flag to. It does not
# touch the database except through `deploy.sh`, and never runs `restore.sh`.
#
# Exit status: 0 done; 1 a check failed and nothing was changed; 10-14 the
# runner's own codes (see deploy-remote-runner.sh); 20 the connection was lost
# while following — the deploy may still be running.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE='deploy'
TAG=''
KEY=''
DRY_RUN=0
ASSUME_YES=0
FORCE_BOT=0
SKIP_REMOTE_CHECK=0
ROLLBACK_TARGET=''

usage() { sed -n '2,/^# ── What it is/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --latest)              TAG='latest'; shift ;;
        --dry-run)             DRY_RUN=1; shift ;;
        --yes | -y)            ASSUME_YES=1; shift ;;
        --bot-commands)        FORCE_BOT=1; shift ;;
        --skip-remote-check)   SKIP_REMOTE_CHECK=1; shift ;;
        --status)              MODE='status'; shift ;;
        --diagnose)            MODE='diagnose'; shift ;;
        --rollback)            MODE='rollback'; shift
                               if [[ $# -gt 0 && "$1" != -* ]]; then ROLLBACK_TARGET="$1"; shift; fi ;;
        --attach)              MODE='attach'; shift
                               [[ $# -gt 0 ]] || die "--attach needs the key of the deploy (a tag, or rollback-<tag>)"
                               KEY="$1"; shift ;;
        -h | --help)           usage; exit 0 ;;
        -*)                    die "unknown option: $1  (see --help)" ;;
        *)                     [[ -z "$TAG" ]] || die "only one tag at a time"; TAG="$1"; shift ;;
    esac
done

# ── Configuration ────────────────────────────────────────────────────────────
#
# Environment wins over the file. The file is parsed, never sourced: sourcing
# executes it, and a value with a stray `$(…)` in it would run on your machine
# (the same reason lib.sh reads `.env` with sed).
# The first of these that exists is used (they are not merged): an explicit
# DEPLOY_REMOTE_CONFIG, then this checkout's `.deploy/`, then a per-user file that
# works from any checkout or worktree.
CONFIG_FILE=''
for _candidate in "${DEPLOY_REMOTE_CONFIG:-}" \
    "${PAYETAM_ROOT}/.deploy/remote.env" \
    "${XDG_CONFIG_HOME:-${HOME:-/nonexistent}/.config}/payatam/remote.env"; do
    if [[ -n "$_candidate" && -r "$_candidate" ]]; then CONFIG_FILE="$_candidate"; break; fi
done

load_config() {
    local line key value
    [[ -n "$CONFIG_FILE" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
        if [[ "$line" =~ ^[[:space:]]*(DEPLOY_[A-Z_]+)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            value="${value%"${value##*[![:space:]]}"}"
            if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
            case "$key" in
                DEPLOY_SSH_TARGET | DEPLOY_REMOTE_DIR | DEPLOY_TRANSFER_DIR | DEPLOY_SSH_OPTS | \
                    DEPLOY_OOB_FILES | DEPLOY_SSH_CMD | DEPLOY_SCP_CMD | DEPLOY_PUBLIC_URL)
                    if [[ -z "${!key+x}" ]]; then printf -v "$key" '%s' "$value"; fi
                    ;;
                *) warn "${CONFIG_FILE}: ignoring unknown key ${key}" ;;
            esac
        fi
    done < "$CONFIG_FILE"
}
load_config

# How often to look at the runner's log while following it. Environment only.
POLL_SECONDS="${DEPLOY_POLL_SECONDS:-3}"

DEPLOY_SSH_TARGET="${DEPLOY_SSH_TARGET:-}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/srv/payetam}"
DEPLOY_TRANSFER_DIR="${DEPLOY_TRANSFER_DIR:-/root/deploy-transfer}"
DEPLOY_SSH_OPTS="${DEPLOY_SSH_OPTS:-}"
DEPLOY_SSH_CMD="${DEPLOY_SSH_CMD:-ssh}"
DEPLOY_SCP_CMD="${DEPLOY_SCP_CMD:-scp}"
# Optional: a public URL of the product, used only by --diagnose to tell "the server is
# down" from "my machine cannot reach it".
DEPLOY_PUBLIC_URL="${DEPLOY_PUBLIC_URL:-}"
# Tracked files that are edited on the server by hand and must survive a deploy.
# `-` not `:-`, so an explicitly empty value really means "none".
DEPLOY_OOB_FILES="${DEPLOY_OOB_FILES-docker/sites-available/app.paayatam.online.conf}"

# Everything below ends up inside a command run on the server, so it is validated
# against a strict pattern here rather than quoted and hoped about.
[[ -n "$DEPLOY_SSH_TARGET" ]] \
    || die "DEPLOY_SSH_TARGET is not set. Copy scripts/deploy-remote.env.example to ~/.config/payatam/remote.env and fill it in."
[[ "$DEPLOY_SSH_TARGET" =~ ^[A-Za-z0-9_][A-Za-z0-9._@:-]*$ ]] || die "DEPLOY_SSH_TARGET '${DEPLOY_SSH_TARGET}' is not a plain host alias or user@host"
[[ "$DEPLOY_REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "DEPLOY_REMOTE_DIR must be an absolute path without spaces"
[[ "$DEPLOY_TRANSFER_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "DEPLOY_TRANSFER_DIR must be an absolute path without spaces"
[[ -z "$DEPLOY_PUBLIC_URL" || "$DEPLOY_PUBLIC_URL" =~ ^https?://[A-Za-z0-9._:/?=\&%-]+$ ]] || die "DEPLOY_PUBLIC_URL is not a plain http(s) URL"
for _oob in $DEPLOY_OOB_FILES; do
    [[ "$_oob" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ && "$_oob" != *..* ]] || die "DEPLOY_OOB_FILES entry '${_oob}' is not a plain relative path"
done

# ── Talking to the server ────────────────────────────────────────────────────
#
# ServerAliveInterval, because a plain ssh waiter dies with exit 255 part way
# through a long command. BatchMode, because a password prompt in a script that is
# being followed by a person who is not looking is a hang, not a login.
SSH_OPTS_EXTRA=()
if [[ -n "$DEPLOY_SSH_OPTS" ]]; then read -r -a SSH_OPTS_EXTRA <<< "$DEPLOY_SSH_OPTS"; fi
# ClearAllForwardings, because an alias in ~/.ssh/config often carries a LocalForward
# (a database tunnel, say). This script makes dozens of short connections; each would try
# to open that port, fail with "Address already in use" whenever another session holds it,
# and print the error into the deploy log every few seconds. It never needs a forward.
SSH_COMMON=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 -o ServerAliveCountMax=6
    -o ClearAllForwardings=yes)

# The script goes in on stdin to `bash -s`, so there is no second layer of shell
# quoting to get wrong and it does not matter what root's login shell is. It also
# means nothing here may read stdin itself; nothing does.
remote() {
    printf '%s\n' "$1" | "$DEPLOY_SSH_CMD" "${SSH_COMMON[@]}" ${SSH_OPTS_EXTRA[@]+"${SSH_OPTS_EXTRA[@]}"} \
        "$DEPLOY_SSH_TARGET" bash -s
}

remote_copy() { # <local file> <remote path>
    "$DEPLOY_SCP_CMD" -q "${SSH_COMMON[@]}" ${SSH_OPTS_EXTRA[@]+"${SSH_OPTS_EXTRA[@]}"} \
        "$1" "${DEPLOY_SSH_TARGET}:$2"
}

q() { printf '%q' "$1"; }

ask() { # <prompt>; a yes only from a person
    if ((ASSUME_YES)); then
        warn "--yes: assuming yes — $1"
        return 0
    fi
    [[ -t 0 ]] || die "this needs a yes and there is no terminal. Run it from a terminal, or pass --yes."
    local answer
    read -r -p "$1 [y/N] " answer
    [[ "$answer" == 'y' || "$answer" == 'Y' ]]
}

history_line() { # <result>
    mkdir -p "${PAYETAM_ROOT}/.deploy"
    printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MODE" "${KEY:-$TAG}" "$1" \
        >> "${PAYETAM_ROOT}/.deploy/remote-deploy-history.log"
}

require_tools() {
    command -v git > /dev/null || die "git is not installed"
    command -v "$DEPLOY_SSH_CMD" > /dev/null || die "${DEPLOY_SSH_CMD} is not installed"
    command -v "$DEPLOY_SCP_CMD" > /dev/null || die "${DEPLOY_SCP_CMD} is not installed"
    command -v sha256sum > /dev/null || die "sha256sum is not installed"
    git -C "$PAYETAM_ROOT" rev-parse --git-dir > /dev/null 2>&1 || die "${PAYETAM_ROOT} is not a git checkout"
}

# ── When the server does not answer ──────────────────────────────────────────
#
# "Cannot reach the server" has three causes that call for three different
# actions, and guessing wrong costs an evening: the server (or its network) is
# down; the path from THIS machine to it is broken (a VPN or tunnel, a firewall);
# or sshd answers and refuses you. This tells them apart. It is local, read-only,
# and sends nothing to anybody.
#
# One clue misleads, and is worth knowing: through a tunnel device the operating
# system's own tunnel accepts every TCP connection and answers ping in a fraction
# of a millisecond, whether or not anything is at the other end. "Connected" and a
# fast ping are therefore evidence of nothing; only the SSH banner is.
diagnose_connection() {
    local cfg addr port route dev banner rtt via_tunnel=0 http
    log "Diagnosing the connection to ${DEPLOY_SSH_TARGET}"

    cfg="$("$DEPLOY_SSH_CMD" -G "$DEPLOY_SSH_TARGET" 2> /dev/null || true)"
    addr="$(awk '$1 == "hostname" {print $2}' <<< "$cfg" | head -1 || true)"
    port="$(awk '$1 == "port" {print $2}' <<< "$cfg" | head -1 || true)"
    addr="${addr:-$DEPLOY_SSH_TARGET}"
    port="${port:-22}"
    if [[ ! "$addr" =~ ^[A-Za-z0-9._:-]+$ || ! "$port" =~ ^[0-9]+$ ]]; then
        warn "cannot work out an address for ${DEPLOY_SSH_TARGET} from your ssh config"
        return 0
    fi

    if command -v ip > /dev/null 2>&1; then
        route="$(ip route get "$addr" 2> /dev/null | head -1 || true)"
        dev="$(sed -n 's/.* dev \([^ ]*\).*/\1/p' <<< "$route")"
        [[ -z "$route" ]] || printf '  Route        %s\n' "$route"
        case "$dev" in tun* | utun* | wg* | singbox* | ppp* | tailscale* | zt*) via_tunnel=1 ;; esac
        if ((via_tunnel)); then printf '               traffic to this address goes through a tunnel (%s)\n' "$dev"; fi
    fi

    if command -v ping > /dev/null 2>&1; then
        rtt="$(ping -c 2 -W 3 "$addr" 2> /dev/null | awk -F/ '/^(rtt|round-trip)/ {print $5}' | head -1 || true)"
        if [[ -n "$rtt" ]]; then
            printf '  Ping         %s ms\n' "$rtt"
            if ((via_tunnel)) && awk -v r="$rtt" 'BEGIN {exit !(r < 1)}'; then
                printf '               under 1 ms through a tunnel: the tunnel answered, not the server\n'
            fi
        else
            printf '  Ping         no answer\n'
        fi
    fi

    banner="$(timeout 10 bash -c "exec 3<>/dev/tcp/${addr}/${port} && read -r -t 6 line <&3 && printf '%s' \"\$line\"" 2> /dev/null || true)"
    if [[ "$banner" == SSH-* ]]; then
        printf '  SSH banner   %s\n' "${banner%$'\r'}"
    else
        printf '  SSH banner   none within 6 s\n'
    fi

    if [[ -n "$DEPLOY_PUBLIC_URL" ]] && command -v curl > /dev/null 2>&1; then
        http="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$DEPLOY_PUBLIC_URL" 2> /dev/null || true)"
        if [[ -n "$http" && "$http" != 000 ]]; then
            printf '  Public URL   HTTP %s\n' "$http"
        else
            printf '  Public URL   no answer\n'
        fi
    fi

    echo
    if [[ "$banner" == SSH-* ]]; then
        ok "sshd answers, so the server is up. If ssh still fails it is authentication or permissions: ssh -v ${DEPLOY_SSH_TARGET}"
    else
        err "no SSH banner: the server, or the path from this machine to it, is down."
        cat >&2 << HINT

  Tell the two apart by looking from somewhere else:

    1. Ask an outside checker, e.g. https://check-host.net (HTTP check on your site's URL${DEPLOY_PUBLIC_URL:+: ${DEPLOY_PUBLIC_URL}}),
       or try the same address from another network (a phone hotspot).

    2. It answers from elsewhere but not from here -> the path from this machine is broken:
       a VPN/tunnel or firewall. Route this address directly, or switch the tunnel off, and retry.

    3. It does not answer from anywhere -> the server or its network is down. This is a
       production outage, not a deploy problem: use the hosting provider's panel (power,
       console, network, billing or suspension). Nothing here can fix it.

HINT
    fi
}

# ── What the server says about itself ────────────────────────────────────────
#
# One read-only round trip. KEY=VALUE lines, so nothing here depends on the
# server's locale or on parsing prose.
R_MISSING=0 R_HEAD='' R_DESCRIBE='' R_CURRENT='' R_PREVIOUS='' R_TAG_COMMIT=''
R_RUNNING=0 R_DISK_MB='' R_DIRTY=()

read_server() { # <tag or empty>
    local tag="${1:-}" out line k v
    out="$(remote "
        cd $(q "$DEPLOY_REMOTE_DIR") 2>/dev/null || { echo MISSING=1; exit 0; }
        echo HEAD=\$(git rev-parse HEAD 2>/dev/null)
        echo DESCRIBE=\$(git describe --tags --always 2>/dev/null)
        echo CURRENT=\$(cat .deploy/current-release 2>/dev/null)
        echo PREVIOUS=\$(cat .deploy/previous-release 2>/dev/null)
        echo DISK_MB=\$(df -Pm . | awk 'NR==2 {print \$4}')
        if [ -f .deploy/remote-deploy.pid ] && kill -0 \$(cat .deploy/remote-deploy.pid) 2>/dev/null; then echo RUNNING=1; fi
        if [ -n $(q "$tag") ]; then echo TAG_COMMIT=\$(git rev-parse -q --verify refs/tags/$(q "$tag")^{commit} 2>/dev/null); fi
        git status --porcelain --untracked-files=no | sed 's/^...//' | while read -r f; do echo DIRTY=\$f; done
    ")" || {
        diagnose_connection
        die "cannot reach the server (${DEPLOY_SSH_TARGET}) over SSH. Nothing was changed. The diagnosis above says which side is down."
    }

    R_DIRTY=()
    while IFS= read -r line; do
        k="${line%%=*}"
        v="${line#*=}"
        case "$k" in
            MISSING)    R_MISSING=1 ;;
            HEAD)       R_HEAD="$v" ;;
            DESCRIBE)   R_DESCRIBE="$v" ;;
            CURRENT)    R_CURRENT="$v" ;;
            PREVIOUS)   R_PREVIOUS="$v" ;;
            DISK_MB)    R_DISK_MB="$v" ;;
            RUNNING)    R_RUNNING=1 ;;
            TAG_COMMIT) R_TAG_COMMIT="$v" ;;
            DIRTY)      R_DIRTY+=("$v") ;;
        esac
    done <<< "$out"

    ((R_MISSING == 0)) || die "${DEPLOY_REMOTE_DIR} does not exist on the server. Set DEPLOY_REMOTE_DIR, or do the first deploy by hand (DEPLOYMENT.md §7)."
}

# Files the server has changed that this script has been told to expect. Anything
# else is somebody's hotfix or a mistake, and deploy.sh refuses it for the same reason.
check_dirty() {
    local f oob unknown=()
    for f in ${R_DIRTY[@]+"${R_DIRTY[@]}"}; do
        for oob in $DEPLOY_OOB_FILES; do
            [[ "$f" == "$oob" ]] && continue 2
        done
        unknown+=("$f")
    done
    if ((${#unknown[@]} > 0)); then
        err "the server's checkout has uncommitted changes this script does not know about:"
        printf '      %s\n' "${unknown[@]}" >&2
        die "Look at them (${DEPLOY_SSH_CMD} ${DEPLOY_SSH_TARGET} 'cd ${DEPLOY_REMOTE_DIR} && git diff'), then commit, stash or add them to DEPLOY_OOB_FILES."
    fi
}

# A local commit for something the server calls by name, or nothing.
local_commit() { git -C "$PAYETAM_ROOT" rev-parse -q --verify "$1^{commit}" 2> /dev/null || true; }

# ── What a release changes: migrations, bot commands, settings ───────────────
#
# Reads the two trees, not the server. Sets DESTRUCTIVE (a person must judge),
# SAFE_ROLLBACK (the runner may roll back by itself) and BOT_CHANGED.
DESTRUCTIVE=0 SAFE_ROLLBACK=1 BOT_CHANGED=0 MIGRATION_COUNT=0 KNOWN_PREV=0

migration_report() { # <from commit> <to commit>
    local from="$1" to="$2" files f sql flagged=()
    files="$(git -C "$PAYETAM_ROOT" diff --name-only --diff-filter=A "$from" "$to" \
        -- 'packages/db/prisma/migrations/*/migration.sql')"
    MIGRATION_COUNT=0
    [[ -z "$files" ]] && return 0
    MIGRATION_COUNT="$(printf '%s\n' "$files" | wc -l)"
    echo "  Migrations  ${MIGRATION_COUNT} new (a rollback does NOT undo these):"
    while IFS= read -r f; do
        printf '                %s\n' "$(basename "$(dirname "$f")")"
        # Comments stripped first: the migrations in this repo explain themselves at
        # length, and "we do not DROP anything" must not read as a DROP.
        # Into a variable, then grep the variable: see the note at the CHANGELOG
        # check. Here a SIGPIPE would not fail loudly, it would make a DROP look
        # like "nothing found" and let a destructive migration through unflagged.
        sql="$(git -C "$PAYETAM_ROOT" show "${to}:${f}" | sed 's/--.*$//')"
        if grep -q -i -E '\b(DROP|RENAME|TRUNCATE)\b|ALTER +COLUMN +[^ ]+ +(TYPE|SET +NOT +NULL)|DELETE +FROM' <<< "$sql"; then
            flagged+=("$(basename "$(dirname "$f")")")
        fi
    done <<< "$files"
    if ((${#flagged[@]} > 0)); then
        DESTRUCTIVE=1
        SAFE_ROLLBACK=0
        warn "these contain DROP / RENAME / TRUNCATE / DELETE / a type or NOT NULL change: ${flagged[*]}"
        warn "This repository's rule is additive-only migrations. Read the SQL before going on."
    fi
}

release_report() { # <from commit or empty> <to commit>
    local from="$1" to="$2" keys
    if [[ -z "$from" ]]; then
        warn "the server's current release is not a commit this checkout knows, so migrations and"
        warn "bot commands cannot be compared. Automatic rollback is off; pass --bot-commands if the menu changed."
        SAFE_ROLLBACK=0
        return 0
    fi
    KNOWN_PREV=1
    migration_report "$from" "$to"
    ((MIGRATION_COUNT > 0)) || echo "  Migrations  none"

    # `BOT_COMMANDS` changed, added or removed: Telegram only learns of it if the
    # menu is republished (release.md, "Bot commands").
    if ! git -C "$PAYETAM_ROOT" diff --quiet "$from" "$to" -- packages/telegram/src/commands.ts; then
        BOT_CHANGED=1
    fi
    if ((BOT_CHANGED || FORCE_BOT)); then
        echo "  Bot menu    will be republished after the deploy"
    else
        echo "  Bot menu    unchanged"
    fi

    # A changed *default* only applies where production has no row for the key; a
    # key that already has one keeps its value and the release notes then describe
    # an economy that is not running (release skill, precondition 4).
    keys="$(git -C "$PAYETAM_ROOT" diff "$from" "$to" -- packages/domain/src/catalog/settings.service.ts \
        | grep -E "^[+-][[:space:]]+'[a-z][a-z0-9_.]*':" | sed -E "s/^[+-][[:space:]]+'([^']+)'.*/\1/" | sort -u | tr '\n' ' ' || true)"
    if [[ -n "$keys" ]]; then
        warn "settings defaults changed: ${keys}"
        warn "A default only applies where production has NO row for that key. Read the rows first."
    fi
}

# ── Follow the runner on the server ──────────────────────────────────────────
follow() { # <key>
    local key="$1" log exitf offset=0 chunk fails=0 code got
    log="${DEPLOY_REMOTE_DIR}/.deploy/remote-deploy-${key}.log"
    exitf="${DEPLOY_REMOTE_DIR}/.deploy/remote-deploy-${key}.exit"
    chunk="$(mktemp)"

    while true; do
        if remote "tail -c +$((offset + 1)) $(q "$log") 2>/dev/null || true" > "$chunk"; then
            fails=0
            if [[ -s "$chunk" ]]; then
                cat "$chunk"
                offset=$((offset + $(wc -c < "$chunk")))
            fi
            if got="$(remote "cat $(q "$exitf") 2>/dev/null")" && [[ -n "$got" ]]; then
                # One last read, so nothing written between the two calls is lost.
                remote "tail -c +$((offset + 1)) $(q "$log") 2>/dev/null || true" > "$chunk" || true
                [[ -s "$chunk" ]] && cat "$chunk"
                rm -f "$chunk"
                FOLLOW_CODE="$got"
                return 0
            fi
        else
            fails=$((fails + 1))
            if ((fails >= 40)); then
                rm -f "$chunk"
                err "lost the connection to the server. The deploy is NOT stopped; it keeps running there."
                err "Re-join it with: scripts/deploy-remote.sh --attach ${key}"
                history_line 'connection-lost'
                exit 20
            fi
        fi
        sleep "$POLL_SECONDS"
    done
}

report_code() { # <code> <what>
    code="$1"
    case "$code" in
        0)  ok "$2 finished cleanly" ;;
        10) err "Failed before the running stack was touched. The previous release is still serving."
            err "Read the log above; fix; run it again." ;;
        11) err "The new release failed its checks after it started, and was ROLLED BACK."
            err "The previous release is serving again. Read the log above before retrying." ;;
        12) err "Failed and the server needs a person. The new release may be serving without passing its checks."
            err "Status: scripts/deploy-remote.sh --status     Roll back: scripts/deploy-remote.sh --rollback" ;;
        13) warn "Deployed, but the Telegram command menu was not published."
            warn "Publish it: ${DEPLOY_SSH_CMD} ${DEPLOY_SSH_TARGET} 'cd ${DEPLOY_REMOTE_DIR} && PAYETAM_VERSION=<tag> ./scripts/compose.sh --profile tools run --rm tools pnpm set-bot-commands'" ;;
        14) warn "Deployed, but a hand-edited file was not restored or nginx did not reload (see [runner] ATTENTION above)."
            warn "Copies of the file are in root's home on the server (oob-*)." ;;
        *)  err "The runner reported an unknown code: ${code}" ;;
    esac
}

# ── Modes ────────────────────────────────────────────────────────────────────
require_tools

if [[ "$MODE" == 'diagnose' ]]; then
    diagnose_connection
    exit 0
fi

if [[ "$MODE" == 'status' ]]; then
    log "Server ${DEPLOY_SSH_TARGET}"
    read_server ''
    printf '  Serving        %s\n' "${R_CURRENT:-unknown}"
    printf '  Rolls back to  %s\n' "${R_PREVIOUS:-unknown}"
    printf '  Checkout       %s (%s)\n' "$R_DESCRIBE" "${R_HEAD:0:9}"
    printf '  Disk free      %s MB\n' "$R_DISK_MB"
    printf '  Hand edits     %s\n' "${R_DIRTY[*]:-none}"
    if ((R_RUNNING)); then warn "a deploy is running on the server right now"; fi
    echo
    remote "cd $(q "$DEPLOY_REMOTE_DIR") && ./scripts/compose.sh ps" || warn "could not list containers"
    exit 0
fi

if [[ "$MODE" == 'attach' ]]; then
    [[ "$KEY" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid key"
    follow "$KEY"
    report_code "$FOLLOW_CODE" "The run ${KEY}"
    exit "$FOLLOW_CODE"
fi

# ── Rollback ─────────────────────────────────────────────────────────────────
if [[ "$MODE" == 'rollback' ]]; then
    read_server ''
    ((R_RUNNING == 0)) || die "a deploy is running on the server. Follow it with --attach and wait."
    check_dirty
    target="${ROLLBACK_TARGET:-$R_PREVIOUS}"
    [[ -n "$target" ]] || die "the server records no previous release. Name one: --rollback <tag>"
    [[ "$target" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid rollback target '${target}'"

    log "Rolling back ${DEPLOY_SSH_TARGET}: ${R_CURRENT:-?} -> ${target}"
    from="$(local_commit "$target")"
    to="$(local_commit "${R_CURRENT:-HEAD}")"
    if [[ -n "$from" && -n "$to" ]]; then
        # Migrations that arrived *after* the target and are already applied.
        migration_report "$from" "$to"
        ((MIGRATION_COUNT > 0)) || echo "  Migrations  none since ${target}"
    else
        warn "cannot compare migrations: '${target}' or '${R_CURRENT:-current}' is not known in this checkout"
    fi
    if ((DESTRUCTIVE)); then
        warn "A rollback restores CODE only. If any migration above dropped or renamed something,"
        warn "the old code will fail against the new schema, and the way back is scripts/restore.sh."
        ASSUME_YES=0
    fi
    ((DRY_RUN)) && { ok "dry run: nothing changed"; exit 0; }
    ask "Roll back the server to ${target}?" || die "Aborted. Nothing was changed."

    KEY="rollback-${target}"
    remote_copy "${PAYETAM_ROOT}/scripts/deploy-remote-runner.sh" "${DEPLOY_TRANSFER_DIR}/runner-${KEY}.sh" \
        || die "cannot copy the runner to the server (does ${DEPLOY_TRANSFER_DIR} exist?)"
    remote "
        mkdir -p $(q "$DEPLOY_REMOTE_DIR")/.deploy $(q "$DEPLOY_TRANSFER_DIR")
        rm -f $(q "$DEPLOY_REMOTE_DIR")/.deploy/remote-deploy-$(q "$KEY").exit
        nohup setsid bash $(q "${DEPLOY_TRANSFER_DIR}/runner-${KEY}.sh") rollback $(q "$KEY") $(q "$target") \
            $(q "$DEPLOY_REMOTE_DIR") $(q "$DEPLOY_OOB_FILES") 0 0 \
            > $(q "$DEPLOY_REMOTE_DIR")/.deploy/remote-deploy-$(q "$KEY").log 2>&1 < /dev/null &
        echo started
    " > /dev/null || die "could not start the runner on the server"
    FOLLOW_CODE=''
    follow "$KEY"
    report_code "$FOLLOW_CODE" "The rollback"
    history_line "code=${FOLLOW_CODE}"
    exit "$FOLLOW_CODE"
fi

# ── Deploy ───────────────────────────────────────────────────────────────────
if [[ "$TAG" == 'latest' ]]; then
    TAG="$(git -C "$PAYETAM_ROOT" tag --list 'v[0-9]*' --sort=-v:refname | head -1 || true)"
    [[ -n "$TAG" ]] || die "no v* tag exists in this checkout"
    log "Latest tag: ${TAG}"
fi
[[ -n "$TAG" ]] || { usage; die "name a tag: scripts/deploy-remote.sh v0.18.1   (or --latest, --status, --rollback)"; }
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "'${TAG}' is not a release tag (expected vMAJOR.MINOR.PATCH)"
KEY="$TAG"

log "Checking ${TAG}"
TAG_COMMIT="$(local_commit "refs/tags/${TAG}")"
[[ -n "$TAG_COMMIT" ]] || die "tag ${TAG} does not exist in this checkout. Newest: $(git -C "$PAYETAM_ROOT" tag --sort=-creatordate | head -3 | tr '\n' ' ')"
ok "tag ${TAG} -> ${TAG_COMMIT:0:9}"

# The tag names the commit, so the entry must be in *that* tree, not in whatever is
# checked out now. "No tag without a changelog entry" is a project rule.
#
# Read into a variable first, then grep the variable. `git show | grep -q` looks
# equivalent and is not: grep -q exits at the first match, git show is then killed
# by SIGPIPE part way through a large file, and under `pipefail` the pipeline
# reports failure for a file that DOES contain the entry — at random, and more
# often the bigger and the newer-entry-first the changelog is (which is exactly
# what this repository's is).
changelog_at_tag="$(git -C "$PAYETAM_ROOT" show "${TAG}:CHANGELOG.md" 2> /dev/null || true)"
grep -q -F "## [${TAG}]" <<< "$changelog_at_tag" \
    || die "CHANGELOG.md at ${TAG} has no '## [${TAG}]' entry. Every release needs one."
ok "CHANGELOG.md has an entry for ${TAG}"

if ((SKIP_REMOTE_CHECK)); then
    warn "not checking GitHub (--skip-remote-check)"
else
    # An annotated tag is listed twice: the tag object, then, as `<tag>^{}`, the
    # commit it points at. The commit is what is compared, so that line wins; a
    # lightweight tag has only the plain line, which then is the commit. The star
    # and the exact match in awk, because a bare `^{}` pattern is not matched.
    remote_tags="$(git -C "$PAYETAM_ROOT" ls-remote origin "refs/tags/${TAG}*" 2> /dev/null)" \
        || die "cannot reach GitHub to check the tag. Offline? Use --skip-remote-check."
    pushed="$(printf '%s\n' "$remote_tags" | awk -v tag="refs/tags/${TAG}" \
        '$2 == tag "^{}" {peeled = $1} $2 == tag {plain = $1} END {print (peeled != "" ? peeled : plain)}')"
    [[ -n "$pushed" ]] || die "tag ${TAG} is not on origin. Push it first: git push origin ${TAG}"
    [[ "$pushed" == "$TAG_COMMIT" ]] || die "origin's ${TAG} is a different commit (${pushed:0:9}) from yours (${TAG_COMMIT:0:9})."
    ok "${TAG} is on origin, same commit"
fi

if git -C "$PAYETAM_ROOT" rev-parse -q --verify refs/remotes/origin/master > /dev/null \
    && ! git -C "$PAYETAM_ROOT" merge-base --is-ancestor "$TAG_COMMIT" refs/remotes/origin/master; then
    warn "${TAG} is not on origin/master. That is allowed, but it is unusual for a production release."
fi

log "Reading the server"
read_server "$TAG"
check_dirty
((R_RUNNING == 0)) || die "a deploy is already running on the server. Follow it with: scripts/deploy-remote.sh --attach <key>"
if [[ -n "$R_TAG_COMMIT" && "$R_TAG_COMMIT" != "$TAG_COMMIT" ]]; then
    die "the server already has a tag ${TAG} on a DIFFERENT commit (${R_TAG_COMMIT:0:9}, yours is ${TAG_COMMIT:0:9}). Someone re-tagged. Stop and find out why."
fi
if [[ -n "$R_DISK_MB" ]] && ((R_DISK_MB < 3000)); then
    warn "only ${R_DISK_MB} MB free on the server; building images needs room. Consider: docker image prune"
fi
ok "server reachable; ${DEPLOY_REMOTE_DIR} is clean"

# ── The plan ─────────────────────────────────────────────────────────────────
prev_commit=''
if [[ -n "$R_CURRENT" ]]; then prev_commit="$(local_commit "refs/tags/${R_CURRENT}")"; fi
if [[ -z "$prev_commit" && -n "$R_HEAD" ]]; then prev_commit="$(local_commit "$R_HEAD")"; fi

echo
printf '  Release     %s  (%s)\n' "$TAG" "${TAG_COMMIT:0:9}"
printf '  Server      %s  %s\n' "$DEPLOY_SSH_TARGET" "$DEPLOY_REMOTE_DIR"
printf '  Serving now %s\n' "${R_CURRENT:-unknown}"
if [[ "$R_CURRENT" == "$TAG" ]]; then warn "the server already reports ${TAG} as current; this is a redeploy"; fi
release_report "$prev_commit" "$TAG_COMMIT"
RUN_BOT=0
if ((BOT_CHANGED || FORCE_BOT)); then RUN_BOT=1; fi
[[ -z "$DEPLOY_OOB_FILES" ]] || printf '  Hand edits  kept across the deploy: %s\n' "$DEPLOY_OOB_FILES"
echo
warn "Every new version is announced ONCE to every user by the bot (release.announce_enabled)."
warn "To suppress it, set that setting to 0 in the admin panel BEFORE deploying; it is read at boot."
echo

if ((DRY_RUN)); then
    ok "dry run: every check passed, nothing was sent or changed"
    exit 0
fi

if ((DESTRUCTIVE)); then
    ASSUME_YES=0
    [[ -t 0 ]] || die "a migration may be destructive and there is no terminal to confirm on."
    read -r -p "Type 'deploy anyway' to accept a possibly destructive migration: " answer
    [[ "$answer" == 'deploy anyway' ]] || die "Aborted. Nothing was changed."
fi
ask "Deploy ${TAG} to ${DEPLOY_SSH_TARGET}?" || die "Aborted. Nothing was changed."

# ── Send the tag ─────────────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

remote "mkdir -p $(q "$DEPLOY_TRANSFER_DIR")" || die "cannot create ${DEPLOY_TRANSFER_DIR} on the server"

if [[ "$R_TAG_COMMIT" == "$TAG_COMMIT" ]]; then
    ok "the server already has ${TAG}; nothing to send"
else
    log "Bundling ${TAG}"
    bundle="${WORK}/payetam-${TAG}.bundle"
    refs=("refs/tags/${TAG}")
    # Only what the server lacks: everything up to its current commit is
    # already there, and a bundle names it as a prerequisite.
    if [[ -n "$R_HEAD" && -n "$(local_commit "$R_HEAD")" ]]; then refs+=("^${R_HEAD}"); fi
    if git -C "$PAYETAM_ROOT" bundle create "$bundle" "${refs[@]}" 2> "${WORK}/bundle.err"; then
        sum="$(sha256sum "$bundle" | awk '{print $1}')"
        ok "bundle $(du -h "$bundle" | cut -f1)"
        log "Sending it"
        remote_copy "$bundle" "${DEPLOY_TRANSFER_DIR}/payetam-${TAG}.bundle" || die "could not copy the bundle to the server"
        remote "
            set -e
            cd $(q "$DEPLOY_TRANSFER_DIR")
            echo '${sum}  payetam-${TAG}.bundle' | sha256sum -c - > /dev/null
            cd $(q "$DEPLOY_REMOTE_DIR")
            git bundle verify $(q "${DEPLOY_TRANSFER_DIR}/payetam-${TAG}.bundle") > /dev/null 2>&1
            git fetch -q $(q "${DEPLOY_TRANSFER_DIR}/payetam-${TAG}.bundle") 'refs/tags/${TAG}:refs/tags/${TAG}'
        " || die "the server rejected the bundle (checksum, missing history, or a clashing tag). Nothing was deployed."
    elif grep -q -i 'empty bundle' "${WORK}/bundle.err"; then
        # A lightweight tag on a commit the server already has: nothing to send but
        # the name.
        remote "cd $(q "$DEPLOY_REMOTE_DIR") && git tag $(q "$TAG") $(q "$TAG_COMMIT")" \
            || die "could not create the tag on the server"
        ok "the server has the commit; created the tag there"
    else
        cat "${WORK}/bundle.err" >&2
        die "could not create the bundle"
    fi

    got="$(remote "cd $(q "$DEPLOY_REMOTE_DIR") && git rev-parse $(q "${TAG}^{commit}")")" || die "the tag did not arrive on the server"
    [[ "$got" == "$TAG_COMMIT" ]] || die "the server has ${TAG} at ${got:0:9}, not ${TAG_COMMIT:0:9}. Stopping."
    ok "the server has ${TAG} at ${got:0:9}"
fi

# ── Start the runner, detached, and follow it ────────────────────────────────
log "Starting the deploy on the server (it keeps running if this connection drops)"
remote_copy "${PAYETAM_ROOT}/scripts/deploy-remote-runner.sh" "${DEPLOY_TRANSFER_DIR}/runner-${KEY}.sh" \
    || die "could not copy the runner to the server"
remote "
    mkdir -p $(q "$DEPLOY_REMOTE_DIR")/.deploy
    rm -f $(q "$DEPLOY_REMOTE_DIR")/.deploy/remote-deploy-$(q "$KEY").exit
    nohup setsid bash $(q "${DEPLOY_TRANSFER_DIR}/runner-${KEY}.sh") deploy $(q "$KEY") $(q "$TAG") \
        $(q "$DEPLOY_REMOTE_DIR") $(q "$DEPLOY_OOB_FILES") ${RUN_BOT} ${SAFE_ROLLBACK} \
        > $(q "$DEPLOY_REMOTE_DIR")/.deploy/remote-deploy-$(q "$KEY").log 2>&1 < /dev/null &
    echo started
" > /dev/null || die "could not start the runner on the server"

echo
FOLLOW_CODE=''
follow "$KEY"
echo
report_code "$FOLLOW_CODE" "The deploy of ${TAG}"
history_line "code=${FOLLOW_CODE}"

if [[ "$FOLLOW_CODE" == '0' || "$FOLLOW_CODE" == '13' || "$FOLLOW_CODE" == '14' ]]; then
    echo
    ok "${TAG} is live on ${DEPLOY_SSH_TARGET} (was ${R_CURRENT:-unknown})"
    echo "  Check it:    scripts/deploy-remote.sh --status"
    echo "  Go back:     scripts/deploy-remote.sh --rollback"
fi
[[ "$FOLLOW_CODE" == '0' ]] || exit "$FOLLOW_CODE"
