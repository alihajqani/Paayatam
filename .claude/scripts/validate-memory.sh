#!/usr/bin/env bash
#
# Validate the repository-local memory, skill and guard system.
#
# Written because this check was run by hand three times in one session and the
# ad-hoc version broke twice on shell quirks (zsh `noclobber` clobbering a
# redirect, `nomatch` aborting a whole `rm` line). A validation you retype is a
# validation that reports the wrong thing.
#
#   .claude/scripts/validate-memory.sh          # exit 0 = clean
#
# Read-only. Touches no database, no container, no network.
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1

fails=0
note() { printf '  %-6s %s\n' "$1" "$2"; }
bad()  { note "FAIL" "$1"; fails=$((fails + 1)); }

FILES=$(find .memory .claude -type f -name '*.md' -not -name 'RESUME.md' 2>/dev/null | sort)

echo "1. internal links resolve"
for f in $FILES; do
    d=$(dirname "$f")
    for l in $(grep -oE '\]\([^)#][^)]*\)' "$f" 2>/dev/null | sed 's/^](//;s/)$//'); do
        case "$l" in http*) continue ;; esac
        [ -e "$d/$l" ] || bad "$f -> $l"
    done
done

echo "2. referenced repository paths exist"
for p in $(grep -rhoE '(apps|packages|scripts|docker|test|tools|docs|\.claude|\.memory)/[A-Za-z0-9_./-]+\.(ts|mts|sh|yml|json|prisma|md|vue)' \
            .memory .claude CLAUDE.md 2>/dev/null | sed 's/[.,)]*$//' | sort -u); do
    [ -e "$p" ] || bad "missing path: $p"
done

echo "3. skill frontmatter"
for f in .claude/skills/*/SKILL.md; do
    [ -e "$f" ] || continue
    dir=$(basename "$(dirname "$f")")
    [ "$(sed -n '1p' "$f")" = '---' ]              || bad "$dir: no frontmatter"
    [ "$(sed -n "2s/^name: //p" "$f")" = "$dir" ]  || bad "$dir: name != directory"
    [ -n "$(sed -n '3s/^description: //p' "$f")" ] || bad "$dir: no description"
    for h in Purpose Safety; do
        grep -q "^## .*$h" "$f" || bad "$dir: missing '## $h'"
    done
done

echo "4. JSON parses"
for j in .claude/settings.json .claude/settings.local.json package.json; do
    [ -e "$j" ] || continue
    python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$j" 2>/dev/null || bad "invalid JSON: $j"
done

echo "5. shell syntax"
for s in .claude/hooks/*.sh .claude/scripts/*.sh; do
    [ -e "$s" ] || continue
    bash -n "$s" 2>/dev/null || bad "syntax: $s"
    [ -x "$s" ]              || bad "not executable: $s"
done

echo "6. no secrets in committed memory"
# Committed files only: .memory/local/ is gitignored and may hold host detail.
if grep -rnEi '(BEGIN [A-Z ]*PRIVATE KEY|[0-9]{9,10}:[A-Za-z0-9_-]{35}|root@[0-9]|[0-9]{1,3}(\.[0-9]{1,3}){3})' \
        .memory .claude CLAUDE.md --exclude-dir=local 2>/dev/null \
        | grep -vE '127\.0\.0\.1|0\.0\.0\.0'; then
    bad "possible secret or host address in a committed file"
fi

echo "7. index stays compact"
n=$(wc -l < .memory/index.md)
[ "$n" -le 60 ] || bad "index.md is ${n} lines (cap 60)"

echo "8. typecheck guard behaves"
H=.claude/hooks/block-masked-typecheck.sh
if [ -x "$H" ]; then
    decide() { printf '{"tool_input":{"command":%s}}' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")" \
                 | "$H" | python3 -c 'import sys,json;d=sys.stdin.read().strip();print(json.loads(d)["hookSpecificOutput"]["permissionDecision"] if d else "allow")'; }
    BAD_FORM="rtk pnpm typecheck"
    [ "$(decide "$BAD_FORM")" = deny ]                      || bad "guard does not block the masking form"
    [ "$(decide "rtk proxy pnpm typecheck")" = allow ]      || bad "guard blocks the proxy form"
    [ "$(decide "rtk pnpm run typecheck")" = allow ]        || bad "guard blocks the run form"
    [ "$(decide "make typecheck")" = allow ]                || bad "guard blocks make"
    [ "$(decide "echo '$BAD_FORM'")" = allow ]              || bad "guard trips on a mention"
    [ "$(printf 'not json' | "$H")" = "" ]                  || bad "guard does not fail open"
else
    bad "guard missing or not executable: $H"
fi

echo "9. session-close nudge behaves"
N=.claude/hooks/session-close-nudge.sh
if [ -x "$N" ]; then
    fires() { printf '{"prompt":%s}' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")" \
                | "$N" | grep -q session-end && echo yes || echo no; }
    [ "$(fires 'close the session')" = yes ]                   || bad "nudge misses the English trigger"
    [ "$(fires 'برو سشن رو ببند')" = yes ]                      || bad "nudge misses the Persian trigger"
    [ "$(fires 'add a close button to the session card')" = no ] || bad "nudge fires on unrelated prose"
    [ "$(fires '/session-end')" = no ]                          || bad "nudge fires inside the skill itself"
    [ "$(printf 'not json' | "$N")" = "" ]                      || bad "nudge does not fail open"
else
    bad "nudge missing or not executable: $N"
fi

echo "10. session-end handshake intact"
E=.claude/skills/session-end/SKILL.md
if [ -e "$E" ]; then
    grep -q '^# ❌ SESSION READY TO CLOSE$' "$E" || bad "session-end: red-X handshake heading missing or altered"
    grep -q 'SESSION READY TO CLOSE' "$E" && grep -q '✅.*SESSION READY TO CLOSE' "$E" \
        && bad "session-end: handshake heading uses a green check"
    grep -q 'manually close this Claude session' "$E" || bad "session-end: manual-close sentence missing"
else
    bad "missing skill: $E"
fi

echo
if [ "$fails" -eq 0 ]; then
    echo "memory system: OK"
else
    echo "memory system: ${fails} failure(s)"
fi
exit "$fails"
