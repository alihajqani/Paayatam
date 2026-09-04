#!/usr/bin/env bash
#
# PreToolUse(Bash) guard — repository-local.
#
# `rtk pnpm typecheck` reports a FAILING typecheck as green: it prints
# "TypeScript: No errors found" and exits 0 while tsc exits 2. Measured with
# rtk 0.45.0 on 2026-09-03 against a one-line TS2322 probe:
#
#   rtk pnpm typecheck        exit 0   "No errors found"   <-- masks
#   rtk pnpm run typecheck    exit 2   error TS2322
#   rtk make typecheck        exit 2   error TS2322
#   rtk proxy pnpm typecheck  exit 2   error TS2322
#   pnpm typecheck            exit 2   error TS2322
#
# Only the bare `rtk pnpm <script>` shorthand is affected, so this blocks that
# one form and nothing else.
#
# Heredoc bodies are stripped before matching: writing a file that *documents*
# the bad form is not running it. That false positive was hit while authoring
# .memory/runtime/verification.md, which is why the stripping exists.
#
# Fails open: any internal error allows the command. A guard that blocks the
# whole session when it breaks is worse than the hazard it guards against.
set -uo pipefail

payload="$(cat)" || exit 0
command -v python3 > /dev/null 2>&1 || exit 0

python3 - "$payload" <<'PYEOF' || exit 0
import json, re, sys

try:
    cmd = json.loads(sys.argv[1]).get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)

# Strip heredoc bodies — their content is data being written, not a command.
cmd = re.sub(
    r"<<-?\s*['\"]?(\w+)['\"]?.*?^\s*\1\b",
    " ",
    cmd,
    flags=re.S | re.M,
)

# Only at a command boundary, so `echo "rtk pnpm typecheck"` in prose does not trip it.
if not re.search(r"(?:^|[;&|(]|&&|\|\|)\s*rtk\s+pnpm\s+typecheck\b", cmd, re.M):
    sys.exit(0)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            "That form reports a FAILING typecheck as green "
            "(prints 'No errors found', exits 0 while tsc exits 2). "
            "Use `make typecheck`, `rtk pnpm run typecheck`, or "
            "`rtk proxy pnpm typecheck` — all three report correctly. "
            "See .memory/runtime/verification.md"
        ),
    }
}))
PYEOF
exit 0
