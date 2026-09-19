#!/usr/bin/env bash
#
# The half of `deploy-remote.sh` that runs ON THE SERVER.
#
#   deploy-remote-runner.sh <deploy|rollback> <key> <ref> <dir> <oob-files> <bot-commands 0|1> <safe-rollback 0|1>
#
# You do not run this by hand. `scripts/deploy-remote.sh` copies it to the server,
# starts it detached, and follows its log.
#
# ── Why it is a separate, detached script ────────────────────────────────────
#
# A deploy is a build, a migration and a container swap: minutes long, and a
# dropped SSH session must not be able to kill it half way. So the local script
# starts this under `nohup setsid`, and this writes a log and an exit code to
# `.deploy/`; the local script only watches them. If your connection dies, the
# deploy carries on, and `deploy-remote.sh --attach <key>` picks the log up again.
#
# It lives outside the repository (copied to the transfer directory) because
# `deploy.sh` checks another tag out from under a running script otherwise.
#
# ── What it does, in order ───────────────────────────────────────────────────
#
#   1. Sets aside files that are edited on the server by hand (the out-of-band
#      list), because `deploy.sh` and `rollback.sh` refuse a dirty tree.
#      Each is copied to $HOME first and then `git stash`ed, never discarded.
#   2. Runs `scripts/deploy.sh <tag> --no-pull` (or `scripts/rollback.sh`).
#      The tag arrives by git bundle, so there is nothing to pull. It never
#      passes `--no-migrate` or `--no-backup`, and has no option to.
#   3. If, and only if, the stack was already replaced and then failed its health
#      or smoke checks, rolls back — and only when the local script judged the
#      release's migrations additive (safe-rollback = 1).
#   4. Publishes the bot command menu when the local script said it changed.
#   5. Restores the set-aside files and reloads nginx.
#
# ── Exit codes (written to .deploy/remote-deploy-<key>.exit) ─────────────────
#
#    0   done
#   10   failed before the running stack was touched — nothing to undo
#   11   failed after the stack was replaced, and rolled back cleanly
#   12   failed after the stack was replaced and is NOT rolled back: a person
#        has to look (or the runner was killed)
#   13   deployed, but publishing the bot command menu failed
#   14   deployed, but a hand-edited file could not be restored or nginx did not
#        reload — the site may be missing that hand edit
set -uo pipefail

if [[ $# -ne 7 ]]; then
    echo "usage: $0 <deploy|rollback> <key> <ref> <dir> <oob-files> <bot-commands 0|1> <safe-rollback 0|1>" >&2
    exit 64
fi

MODE="$1"
KEY="$2"
REF="$3"
DIR="$4"
OOB="$5"
RUN_BOT="$6"
SAFE_ROLLBACK="$7"

cd "$DIR" || { echo "[runner] cannot enter ${DIR}" >&2; exit 10; }
mkdir -p .deploy

EXIT_FILE=".deploy/remote-deploy-${KEY}.exit"
PID_FILE=".deploy/remote-deploy.pid"
printf '%s\n' "$$" > "$PID_FILE"

# Whatever ends this script — a signal, an unset variable, a bug — the local side
# is told something, and "worst case" is what it is told unless we say otherwise.
RESULT=12
trap 'rm -f "$PID_FILE"; printf "%s\n" "$RESULT" > "$EXIT_FILE"' EXIT

say() { printf '[runner] %s\n' "$*"; }

# ── 1. Set aside hand-edited files ───────────────────────────────────────────
STASH_MESSAGES=()
STASH_FILES=()

set_aside() {
    local file ts message backup
    ts="$(date +%Y%m%d-%H%M%S)"
    # shellcheck disable=SC2086 # $OOB is a space-separated list, validated by the caller
    for file in $OOB; do
        [[ -e "$file" ]] || continue
        [[ -n "$(git status --porcelain --untracked-files=no -- "$file")" ]] || continue

        backup="${HOME}/oob-$(basename "$file")-${ts}"
        cp -p -- "$file" "$backup" || { say "cannot back up ${file}; stopping before anything changes"; return 1; }
        message="oob: ${file} (remote deploy ${KEY} ${ts})"
        git stash push -q -m "$message" -- "$file" \
            || { say "cannot stash ${file}; stopping before anything changes"; return 1; }
        STASH_MESSAGES+=("$message")
        STASH_FILES+=("$file")
        say "set aside ${file} (copy kept at ${backup})"
    done
    return 0
}

# Popped by message, not by position: nothing else stashes here today, but "the
# newest stash is ours" is exactly the assumption that breaks on the day it is not.
restore_aside() {
    local i ref failed=0
    for ((i = ${#STASH_MESSAGES[@]} - 1; i >= 0; i--)); do
        ref="$(git stash list | grep -F -- "${STASH_MESSAGES[i]}" | head -1 | cut -d: -f1)"
        if [[ -z "$ref" ]]; then
            say "ATTENTION: the stash for ${STASH_FILES[i]} is gone; restore it from the copy in ${HOME}"
            failed=1
        elif git stash pop -q "$ref"; then
            say "restored ${STASH_FILES[i]}"
        else
            say "ATTENTION: ${STASH_FILES[i]} did not restore cleanly (the file changed between releases)."
            say "           The stash is kept (${ref}); the previous copy is in ${HOME}. Merge by hand."
            failed=1
        fi
    done

    if ((${#STASH_FILES[@]} > 0 && failed == 0)); then
        if ./scripts/compose.sh exec -T nginx nginx -t > /dev/null 2>&1 \
            && ./scripts/compose.sh exec -T nginx nginx -s reload > /dev/null 2>&1; then
            say "nginx reloaded with the hand-edited file"
        else
            say "ATTENTION: nginx did not accept the restored file or could not reload."
            failed=1
        fi
    fi
    return "$failed"
}

if ! set_aside; then
    restore_aside || true
    RESULT=10
    exit 10
fi

# ── 2. The deploy (or the rollback) ──────────────────────────────────────────
OUT="$(mktemp)"

if [[ "$MODE" == 'rollback' ]]; then
    say "rolling back to ${REF}"
    # The local script showed the migrations and got a person's yes before
    # starting this; `rollback.sh` would ask again on a terminal this does not have.
    PAYETAM_YES=1 ./scripts/rollback.sh "$REF" 2>&1 | tee "$OUT"
    rc="${PIPESTATUS[0]}"
    if ((rc == 0)); then RESULT=0; else RESULT=12; fi
else
    say "deploying ${REF}"
    ./scripts/deploy.sh "$REF" --no-pull 2>&1 | tee "$OUT"
    rc="${PIPESTATUS[0]}"

    if ((rc == 0)); then
        # deploy.sh says "Deployed", and this asks the file it writes last.
        if [[ "$(cat .deploy/current-release 2> /dev/null)" == "$REF" ]]; then
            RESULT=0
        else
            say "deploy.sh exited 0 but .deploy/current-release says '$(cat .deploy/current-release 2> /dev/null)'"
            RESULT=12
        fi
    elif grep -q 'Roll back with: scripts/rollback.sh' "$OUT"; then
        # ── 3. Failed after the stack was replaced ───────────────────────────
        #
        # That sentence is printed by exactly the two dies that come after
        # `compose up` — API unhealthy, smoke tests failed — so it is the line
        # between "nothing to undo" and "the new release is serving".
        if [[ "$SAFE_ROLLBACK" == '1' ]]; then
            say "the new release failed its checks after it started; rolling back"
            PAYETAM_YES=1 ./scripts/rollback.sh 2>&1 | tee -a "$OUT"
            if [[ "${PIPESTATUS[0]}" == '0' ]]; then RESULT=11; else RESULT=12; fi
        else
            say "the new release failed its checks after it started, and its migrations were not"
            say "clearly additive-only, so this does NOT roll back by itself. Read them first;"
            say "then: deploy-remote.sh --rollback"
            RESULT=12
        fi
    else
        RESULT=10
    fi
fi
rm -f "$OUT"

# ── 4. The bot command menu ──────────────────────────────────────────────────
if [[ "$MODE" == 'deploy' && "$RESULT" == '0' && "$RUN_BOT" == '1' ]]; then
    say "publishing the bot command menu"
    # PAYETAM_VERSION on the command line, or Compose runs a stale :local image
    # and reports «Command not found» as though the image were broken.
    if ! PAYETAM_VERSION="$REF" ./scripts/compose.sh --profile tools run --rm tools pnpm set-bot-commands; then
        say "the deploy succeeded but the command menu was not published"
        RESULT=13
    fi
fi

# ── 5. Give the hand-edited files back ───────────────────────────────────────
if ! restore_aside; then
    if [[ "$RESULT" == '0' || "$RESULT" == '13' ]]; then RESULT=14; fi
fi

say "finished with code ${RESULT}"
exit "$RESULT"
