#!/usr/bin/env bash
#
# Rehearse scripts/deploy-remote.sh against a FAKE server — a directory on this
# machine. It touches no real server, no Docker and no network.
#
#   scripts/deploy-remote.selftest.sh
#
# What is real: `deploy-remote.sh`, `deploy-remote-runner.sh` and `lib.sh`, copied
# from this checkout. What is fake: ssh and scp (they run the command locally), and
# the server's `deploy.sh`, `rollback.sh` and `compose.sh`, which are small stubs
# that can be told to succeed, fail their build, or fail after the stack started.
#
# Run it after any change to the deploy scripts. It is the only way to try the
# failure paths — a real deploy has no safe way to make a build fail on purpose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

export GIT_AUTHOR_NAME=selftest GIT_AUTHOR_EMAIL=selftest@example.invalid
export GIT_COMMITTER_NAME=selftest GIT_COMMITTER_EMAIL=selftest@example.invalid
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

WORK="$T/work" SRV="$T/srv" XFER="$T/xfer" HOME_DIR="$T/home" ORIGIN="$T/origin.git"
mkdir -p "$T/bin" "$HOME_DIR"

# ── The fake transport ───────────────────────────────────────────────────────
cat > "$T/bin/fake-ssh" << 'EOF'
#!/usr/bin/env bash
# ssh, minus the network: drop the options and the host, run the rest here.
while [[ $# -gt 0 && "$1" == -* ]]; do if [[ "$1" == -o ]]; then shift 2; else shift; fi; done
shift # the host
exec "$@"
EOF
cat > "$T/bin/fake-scp" << 'EOF'
#!/usr/bin/env bash
# scp, minus the network: the last two arguments are the file and host:path.
args=("$@")
src="${args[$((${#args[@]} - 2))]}"
dst="${args[$((${#args[@]} - 1))]}"
cp -- "$src" "${dst#*:}"
EOF
chmod +x "$T/bin/fake-ssh" "$T/bin/fake-scp"

# ── The repository, and the server's stubs ──────────────────────────────────
git init -q "$WORK"
mkdir -p "$WORK/scripts" "$WORK/docker/sites-available" "$WORK/packages/telegram/src" \
    "$WORK/packages/db/prisma/migrations"
cp "$ROOT/scripts/deploy-remote.sh" "$ROOT/scripts/deploy-remote-runner.sh" "$ROOT/scripts/lib.sh" "$WORK/scripts/"

cat > "$WORK/scripts/deploy.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tag="$1"
[[ "${2:-}" == '--no-pull' ]] || { echo "stub: expected --no-pull" >&2; exit 2; }
mkdir -p .deploy
previous="$(git describe --tags --exact-match 2> /dev/null || git rev-parse --short HEAD)"
echo "==> Currently deployed: ${previous}"
if ! git diff --quiet || ! git diff --cached --quiet; then echo "the working tree has uncommitted changes" >&2; exit 1; fi
git rev-parse -q --verify "refs/tags/${tag}" > /dev/null || { echo "tag ${tag} does not exist" >&2; exit 1; }
git checkout --quiet --detach "$tag"
[[ "$previous" == "$tag" ]] || printf '%s\n' "$previous" > .deploy/previous-release
case "${STUB_MODE:-ok}" in
    build-fail) echo "Build failed. Nothing was stopped"; exit 1 ;;
    post-fail)  echo "Deploy failed. Roll back with: scripts/rollback.sh"; exit 1 ;;
    ok)         printf '%s\n' "$tag" > .deploy/current-release; echo "Deployed ${tag}" ;;
esac
EOF
cat > "$WORK/scripts/rollback.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-$(cat .deploy/previous-release)}"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "dirty tree" >&2; exit 1; }
[[ "${STUB_ROLLBACK:-ok}" == ok ]] || exit 1
git checkout --quiet --detach "$target"
printf '%s\n' "$target" > .deploy/current-release
touch .deploy/rollback-ran
echo "Rolled back to ${target}"
EOF
cat > "$WORK/scripts/compose.sh" << 'EOF'
#!/usr/bin/env bash
cd "$(dirname "$0")/.."
case "$*" in
    *'nginx -s reload'*) touch .deploy/nginx-reloaded; exit 0 ;;
    *'nginx -t'*)        exit 0 ;;
    *set-bot-commands*)  touch .deploy/bot-commands-ran; exit 0 ;;
    ps)                  echo "api  healthy"; exit 0 ;;
esac
EOF
chmod +x "$WORK"/scripts/*.sh

printf '.deploy/\n' > "$WORK/.gitignore"
printf 'server { listen 443; }\n' > "$WORK/docker/sites-available/site.conf"
printf 'export const BOT_COMMANDS = [1];\n' > "$WORK/packages/telegram/src/commands.ts"
printf '# readme\n' > "$WORK/README.md"

# A CHANGELOG the size of a real one (well past a pipe buffer), newest entry first:
# the shape that made `git show | grep -q` die of SIGPIPE under `pipefail`.
{ for i in $(seq 1 4000); do printf 'filler line %d to make the changelog large enough to matter\n' "$i"; done; } > "$T/filler.txt"

commit_tag() { # <tag> <changelog entry: yes|no>
    if [[ "$2" == yes ]]; then
        { printf '## [%s] — 2026-01-01\n\nnotes\n\n' "$1"; cat "$WORK/CHANGELOG.md" 2> /dev/null || cat "$T/filler.txt"; } > "$T/changelog.new"
        mv "$T/changelog.new" "$WORK/CHANGELOG.md"
    fi
    git -C "$WORK" add -A
    git -C "$WORK" commit -q --allow-empty -m "release $1"
    git -C "$WORK" tag -a "$1" -m "$1"
}

commit_tag v0.1.0 yes
git clone -q "$WORK" "$SRV" # the server, as of v0.1.0 — before any later tag exists
git -C "$SRV" checkout -q --detach v0.1.0
mkdir -p "$SRV/.deploy" "$XFER"
echo v0.1.0 > "$SRV/.deploy/current-release"

mkdir -p "$WORK/packages/db/prisma/migrations/00000000000001_additive"
echo 'ALTER TABLE t ADD COLUMN c int; -- we never DROP anything' > "$WORK/packages/db/prisma/migrations/00000000000001_additive/migration.sql"
commit_tag v0.2.0 yes

mkdir -p "$WORK/packages/db/prisma/migrations/00000000000002_destructive"
# The DROP is on the first line of a large file: the shape in which a scan that lets
# grep -q close the pipe early misses it, silently.
{ echo 'ALTER TABLE t DROP COLUMN c;'; sed 's/^/-- /' "$T/filler.txt"; echo 'SELECT 1;'; } > "$WORK/packages/db/prisma/migrations/00000000000002_destructive/migration.sql"
commit_tag v0.3.0 yes

commit_tag v0.4.0 no # no CHANGELOG entry: must be refused

git -C "$WORK" rm -q -r packages/db/prisma/migrations/00000000000002_destructive
printf 'export const BOT_COMMANDS = [1, 2];\n' > "$WORK/packages/telegram/src/commands.ts"
commit_tag v0.5.0 yes # the bot command menu changes

commit_tag v0.6.0 yes

git init -q --bare "$ORIGIN"
git -C "$WORK" remote add origin "$ORIGIN"

# ── Helpers ──────────────────────────────────────────────────────────────────
PASS=0 FAIL=0 RC=0
OUT="$T/out"

# Run deploy-remote.sh from the "operator's" checkout, with no terminal on stdin.
run() {
    set +e
    (cd "$WORK" && env HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DEPLOY_REMOTE_CONFIG=/nonexistent \
        DEPLOY_SSH_CMD="$T/bin/fake-ssh" DEPLOY_SCP_CMD="$T/bin/fake-scp" DEPLOY_SSH_TARGET=fake \
        DEPLOY_REMOTE_DIR="$SRV" DEPLOY_TRANSFER_DIR="$XFER" DEPLOY_POLL_SECONDS=0.2 \
        DEPLOY_OOB_FILES=docker/sites-available/site.conf \
        bash scripts/deploy-remote.sh "$@") > "$OUT" 2>&1 < /dev/null
    RC=$?
    set -e
}

check() { # <description> <command...>
    local description="$1"
    shift
    if "$@" > /dev/null 2>&1; then
        PASS=$((PASS + 1))
        printf '  ok    %s\n' "$description"
    else
        FAIL=$((FAIL + 1))
        printf '  FAIL  %s\n' "$description"
    fi
}

said() { grep -q -F -- "$1" "$OUT"; }
current() { cat "$SRV/.deploy/current-release"; }
checkout_is() { [[ "$(git -C "$SRV" describe --tags --exact-match 2> /dev/null)" == "$1" ]]; }
hand_edit() { printf '# hand edit\n' >> "$SRV/docker/sites-available/site.conf"; }
hand_edit_kept() { grep -q '# hand edit' "$SRV/docker/sites-available/site.conf"; }
stash_empty() { [[ -z "$(git -C "$SRV" stash list)" ]]; }
absent() { [[ ! -e "$SRV/.deploy/$1" ]]; }
present() { [[ -e "$SRV/.deploy/$1" ]]; }

# Put the server in a known state: a clean checkout of <tag>, serving it.
server_at() {
    git -C "$SRV" stash clear
    git -C "$SRV" checkout -q --detach -f "$1"
    rm -f "$SRV"/.deploy/*-ran "$SRV"/.deploy/nginx-reloaded "$SRV"/.deploy/remote-deploy* "$SRV/.deploy/previous-release"
    echo "$1" > "$SRV/.deploy/current-release"
}

section() { printf '\n%s\n' "$1"; }

# ── Scenarios ────────────────────────────────────────────────────────────────
section "A clean deploy, over a bundle, keeping a hand-edited file"
server_at v0.1.0
hand_edit
run v0.2.0 --skip-remote-check --yes
check "exits 0" test "$RC" -eq 0
check "the server serves v0.2.0" test "$(current)" = v0.2.0
check "the checkout is at v0.2.0" checkout_is v0.2.0
check "the rollback target is v0.1.0" test "$(cat "$SRV/.deploy/previous-release")" = v0.1.0
check "the hand edit is back after the deploy" hand_edit_kept
check "no stash is left behind" stash_empty
check "a copy of the hand-edited file was kept" bash -c "ls '$HOME_DIR'/oob-site.conf-* > /dev/null"
check "nginx was reloaded with it" present nginx-reloaded
check "the additive migration was listed" said "1 new"
check "the bot menu was NOT republished (commands.ts unchanged)" absent bot-commands-ran
check "the history line says code=0" grep -q 'code=0' "$WORK/.deploy/remote-deploy-history.log"

section "Dry run changes nothing and warns about a DROP"
server_at v0.2.0
run v0.3.0 --skip-remote-check --dry-run
check "exits 0" test "$RC" -eq 0
check "the tag was not sent to the server" bash -c "! git -C '$SRV' rev-parse -q --verify refs/tags/v0.3.0"
check "the server is untouched" test "$(current)" = v0.2.0
check "it flags the DROP" said "00000000000002_destructive"
check "and says why" said "DROP"

section "A destructive migration needs a person"
server_at v0.2.0
run v0.3.0 --skip-remote-check --yes
check "refuses without a terminal, even with --yes" test "$RC" -ne 0
check "says so" said "no terminal"
check "nothing changed" test "$(current)" = v0.2.0

section "Refusals before anything is sent"
run v0.4.0 --skip-remote-check --yes
check "a tag with no CHANGELOG entry" test "$RC" -ne 0
check "  names the entry" said "no '## [v0.4.0]' entry"
run main --skip-remote-check --yes
check "a branch name is not a release" test "$RC" -ne 0
run 'v1.0.0;touch injected' --skip-remote-check --yes
check "a tag with shell characters" test "$RC" -ne 0
check "  ran nothing" test ! -e "$WORK/injected"
run v9.9.9 --skip-remote-check --yes
check "a tag that does not exist" test "$RC" -ne 0
run v0.6.0
check "a tag that is not on origin (GitHub check on)" test "$RC" -ne 0
check "  says so" said "not on origin"
git -C "$WORK" push -q origin v0.6.0
run v0.6.0 --dry-run
check "the same tag once pushed passes the GitHub check" test "$RC" -eq 0
server_at v0.2.0
git -C "$SRV" tag -f v0.6.0 v0.1.0 > /dev/null
run v0.6.0 --skip-remote-check --yes
check "the server already has that tag on another commit" test "$RC" -ne 0
check "  says DIFFERENT commit" said "DIFFERENT commit"
git -C "$SRV" tag -d v0.6.0 > /dev/null

section "Server checkout with changes it does not know about"
server_at v0.2.0
printf 'x\n' >> "$SRV/README.md"
run v0.5.0 --skip-remote-check --yes
check "refuses" test "$RC" -ne 0
check "names the file" said "README.md"
git -C "$SRV" checkout -q -- README.md

section "A deploy already running"
server_at v0.2.0
sleep 30 &
sleeper=$!
echo "$sleeper" > "$SRV/.deploy/remote-deploy.pid"
run v0.5.0 --skip-remote-check --yes
kill "$sleeper" 2> /dev/null || true
check "refuses to start a second one" test "$RC" -ne 0
check "says it is running" said "already running"
rm -f "$SRV/.deploy/remote-deploy.pid"

section "Failure before the stack was touched"
server_at v0.2.0
hand_edit
STUB_MODE=build-fail run v0.5.0 --skip-remote-check --yes
check "exits 10" test "$RC" -eq 10
check "the server still reports v0.2.0" test "$(current)" = v0.2.0
check "no rollback was attempted" absent rollback-ran
check "the hand edit is back" hand_edit_kept
check "no stash is left behind" stash_empty

section "Failure after the stack started: automatic rollback"
server_at v0.2.0
hand_edit
STUB_MODE=post-fail run v0.5.0 --skip-remote-check --yes
check "exits 11 (rolled back)" test "$RC" -eq 11
check "rollback ran" present rollback-ran
check "the server serves v0.2.0 again" test "$(current)" = v0.2.0
check "the hand edit is back" hand_edit_kept

section "Failure after start, rollback fails too"
server_at v0.2.0
STUB_MODE=post-fail STUB_ROLLBACK=fail run v0.5.0 --skip-remote-check --yes
check "exits 12 (needs a person)" test "$RC" -eq 12

section "The runner does not roll back by itself when the migrations are not clearly additive"
server_at v0.2.0
STUB_MODE=post-fail bash "$WORK/scripts/deploy-remote-runner.sh" deploy manual v0.5.0 "$SRV" '' 0 0 > "$OUT" 2>&1 || true
check "exits 12" test "$(cat "$SRV/.deploy/remote-deploy-manual.exit")" = 12
check "and did not roll back" absent rollback-ran
check "and said what to do" said "does NOT roll back by itself"

section "The bot command menu is republished when it changed"
server_at v0.2.0
run v0.5.0 --skip-remote-check --yes
check "exits 0" test "$RC" -eq 0
check "the menu was published" present bot-commands-ran
check "the plan said so" said "will be republished"

section "Status, and a manual rollback"
run --status
check "status exits 0" test "$RC" -eq 0
check "status says what is serving" said "Serving        v0.5.0"
run --rollback --yes
check "rollback exits 0" test "$RC" -eq 0
check "the server is back on v0.2.0" test "$(current)" = v0.2.0

section "Configuration"
set +e
(cd "$WORK" && env HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DEPLOY_REMOTE_CONFIG=/nonexistent bash scripts/deploy-remote.sh v0.2.0) > "$OUT" 2>&1 < /dev/null
RC=$?
set -e
check "no SSH target: refuses and explains" test "$RC" -ne 0
check "  points at the example file" said "deploy-remote.env.example"
printf 'DEPLOY_SSH_TARGET=from-file\nDEPLOY_BOGUS=1\n' > "$T/cfg.env"
set +e
(cd "$WORK" && env HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DEPLOY_REMOTE_CONFIG="$T/cfg.env" DEPLOY_SSH_CMD=/nonexistent-ssh bash scripts/deploy-remote.sh v0.2.0) > "$OUT" 2>&1 < /dev/null
set -e
check "a file's target is used (and an unknown key is reported)" said "ignoring unknown key DEPLOY_BOGUS"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
