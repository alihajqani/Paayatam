---
name: memory-sync
description: Fold what a task just taught you into repository-local memory without duplicating it. Use after a debugging session that cost real time, or after a change that invalidates a recorded fact.
---

# memory-sync

## Purpose

Keep `.memory/` accurate and small. The failure mode it prevents is a memory
system that grows until nobody reads it.

## When to invoke

After a task that (a) cost significant time to a cause worth recording, (b)
invalidated something already written down, or (c) established a workflow that
will recur. **Not** after routine changes — a one-off implementation detail is
not memory.

## Steps

1. **Name the fact in one sentence.** If that is hard, it is not a fact yet.
2. **Find its canonical home.** `.memory/index.md` routing table. If an entry
   already covers the topic, **merge into it** — never append a near-duplicate,
   and never create a second file on the same subject.
3. **Re-read the target file immediately before editing.** Other sessions share
   this tree. Edit the one section; do not rewrite the file to change a line.
4. **Tag it**: `[validated: path:line]`, `[validated: cmd …]`, or
   `[needs-verification: reason]`. Untagged claims do not go in.
5. **Delete what the change invalidated.** A superseded fact left in place is
   worse than no fact.
6. **Check routing.** New topic ⇒ add a row to the index table. Keep the index
   under ~50 lines.
7. **Machine-specific?** → `.memory/local/` (gitignored). Hostnames, IPs, VPN
   topology and credentials never enter a tracked file.
8. **Skill drift?** If the workflow is now better understood, update the skill.
9. **Documentation** — correct `README.md`, `PROJECT_MEMORY.md` or `CLAUDE.md`
   only where the code proves them wrong. **Never edit an accepted ADR to match
   a later implementation** — that is a new ADR (`docs/adr/README.md`).
10. **Unresolved contradiction?** Record it under a "Needs Verification" heading
    rather than guessing.

## Safety

Repository-local writes only. Never write to `~/.claude/` or anywhere outside
this tree. Never delete another session's entry without establishing it is
obsolete. No secrets, no logs, no speculation.

## Expected output

A short list: entries merged, entries deleted, routing rows changed, and anything
left under Needs Verification.
