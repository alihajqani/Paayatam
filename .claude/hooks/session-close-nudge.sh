#!/usr/bin/env bash
#
# UserPromptSubmit backstop — repository-local.
#
# "Close the session" reads like a request to stop, and stopping is exactly the
# wrong move: a session's knowledge dies with its transcript unless the closeout
# runs first. This hook recognises the request in English and Persian and
# injects the pointer to the `session-end` skill, so the protocol does not
# depend on the model remembering it.
#
# It is a *nudge*, never a block: the decision of what the user meant stays with
# the model. The skill (.claude/skills/session-end/SKILL.md) owns the procedure;
# this file owns only the trigger.
#
# Fails open: any internal error adds nothing and the prompt proceeds unchanged.
set -uo pipefail

payload="$(cat)" || exit 0
command -v python3 > /dev/null 2>&1 || exit 0

python3 - "$payload" <<'PYEOF' || exit 0
import json, re, sys

try:
    prompt = json.loads(sys.argv[1]).get("prompt", "")
except Exception:
    sys.exit(0)

# Already inside the skill — the model has the procedure; adding it again is noise.
if re.search(r"(^|\s)/session-end\b", prompt):
    sys.exit(0)

SESSION_EN = r"(?:this|the|our|current)?\s*session"
TRIGGERS = (
    # close / end / finish / wrap up ... session   (and "session ... closeout").
    # The verb must sit next to the noun: "add a close button to the session card"
    # is not a close request, and a nudge on it would be pure noise.
    rf"\b(?:clos(?:e|ing)|end|finish|terminat\w*|wrap\s*up)\b\s*(?:out\s+)?{SESSION_EN}\b",
    rf"\bsession\b[^.\n]{{0,24}}\b(?:close\s*out|closeout|is\s+over|is\s+done)\b",
    # Persian: سشن / سِشن / جلسه / نشست  …  ببند / بستن / تمام
    r"(?:س[ِ]?شن|جلسه|نشست)[^.\n]{0,24}(?:ببند|ببندیم|بستن|تمام|تموم|پایان)",
    r"(?:پایان|بستن)\s+(?:س[ِ]?شن|جلسه|نشست)",
)

if not any(re.search(t, prompt, re.I) for t in TRIGGERS):
    sys.exit(0)

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": (
            "This prompt may be a session-close request. A request to close is "
            "NOT a request to stop: run the `session-end` skill "
            "(.claude/skills/session-end/SKILL.md) first — sweep the session for "
            "durable knowledge, verify each fact against the repository, merge it "
            "into .memory/ without duplicating, update skills/rules/docs only where "
            "earned, run .claude/scripts/validate-memory.sh, then report and print "
            "the '# ❌ SESSION READY TO CLOSE' handshake. Claude cannot "
            "terminate the client session; never claim it did. If the user meant "
            "something else, ignore this note."
        ),
    }
}))
PYEOF
exit 0
