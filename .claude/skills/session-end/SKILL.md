---
name: session-end
description: Close out a session — sweep it for durable knowledge, fold that into .memory/, skills, rules and docs, validate, then hand back the manual-close handshake. Use when asked to close, end or finish the session ("close the session", "سشن رو ببند").
---

# session-end

## Purpose

A session's knowledge dies with its transcript unless someone writes it down.
This skill is the exit gate: sweep, triage, verify, record, validate, report —
then hand the close back to the user, because Claude cannot terminate the
client session.

Per-fact mechanics belong to the `memory-sync` skill. This one decides what a
*whole session* leaves behind, and in what order; it does not restate those
rules.

## When to invoke

On "close the session", "end the session", "finish this session", "سشن رو ببند",
"برو سشن رو ببند", or any clearly equivalent instruction, in any language.
`.claude/hooks/session-close-nudge.sh` (a `UserPromptSubmit` hook, registered in
`.claude/settings.json`) recognises the common phrasings and injects a pointer
here as a backstop — but it is only a nudge that fails open, so the trigger is
the meaning of the request, not its wording.

**A request to close is not a request to stop.** The close is the work below.

## Preconditions

- `git status` read first. Unrelated working-tree changes belong to the user and
  stay untouched; if a commit is requested, stage by path (`CLAUDE.md`
  §Security Rules, trap 3/10).
- No integration run in flight (`pgrep -f 'vitest[.]mjs run'`) — and do not
  start one. A closing session is not a reason to run a 30-minute suite.
- Another session may share this tree. Re-read a file immediately before
  editing it and edit only the section this session owns.

## Steps

1. **Sweep the session.** Re-read it for: project facts, architecture, root
   causes of failures, commands that worked *and* commands that lied,
   production and deployment knowledge, testing requirements, security
   findings, Telegram and UI behaviour, database and migration behaviour, new
   pitfalls, user preferences specific to this repository, workflow
   improvements — anything a future session would otherwise pay to rediscover.

2. **Triage.** Keep only what is reusable, verified, likely to prevent a
   recurring mistake, and worth more than the tokens to maintain it. Drop
   transient reasoning, one-off command output, unverified assumptions,
   duplicates, full logs, raw transcript, and anything with no future
   implementation value. Never store a secret or credential.

3. **Verify every survivor against the repository** — source, tests, `Makefile`,
   package scripts, configuration, `.github/workflows/ci.yml`, `scripts/`,
   observed command output, or an explicit statement the user made this
   session. Tag it per `.memory/index.md` §Verification policy
   (`[validated: path:line]`, `[validated: cmd …]`, `[user-confirmed: <date>]`).
   Important but unverifiable ⇒ a **Needs Verification** heading, never a bare
   fact.

4. **Record it.** For each fact, follow the `memory-sync` skill: find the
   canonical home via the index routing table, merge into it rather than
   appending a near-duplicate, delete what this session invalidated, add a
   routing row only for a genuinely new topic, and send machine-specific detail
   to `.memory/local/` (gitignored).

5. **Skills.** A procedure that recurred, or that is now better understood,
   updates the skill which already owns it. Create a skill only when none fits
   — never to hold a single command, and never one that performs a destructive
   or production-changing action on its own. Include the real commands,
   preconditions and validation steps.

6. **Rules.** `CLAUDE.md` and `.claude/` rules earn a line only for knowledge
   that is stable, verified and broadly applicable. That file is always loaded:
   keep it compact and leave the procedure in a skill or a focused memory entry.

7. **Documentation.** Correct `README.md`, `PROJECT_MEMORY.md` or a `docs/` page
   only where this session proved it wrong and the fix is clearly supported, and
   say what was corrected and why. Do not rewrite historical records. **Never
   edit an accepted ADR to match a later implementation** — that is a new ADR
   plus a plan update (`docs/adr/README.md`).

8. **Dedupe and reconcile.** One fact, one home, across memory, skills, rules
   and docs. Where two records disagree and the source tree settles it, fix the
   wrong one; where nothing settles it, mark it `Needs Verification`. Check that
   links, indexes and referenced paths still resolve and the commands still exist.

9. **Validate.**
   ```bash
   .claude/scripts/validate-memory.sh
   ```
   Covers internal links, referenced paths, skill frontmatter, JSON parsing,
   hook behaviour, secrets in committed files, and index size. Run a code gate
   (`/verify`) **only if** this closeout changed something a gate covers — a
   closing session is not, by itself, a reason to typecheck, and never a reason
   to touch production.

10. **Report, then hand back the close** — the two sections below.

## Report

- New knowledge saved
- Existing memory updated
- Skills created or updated
- Rules or documentation updated
- Important items intentionally **not** saved
- Validation performed
- Unresolved issues
- Whether the repository is clean or carries unrelated changes

## Handshake

Then print this verbatim. The heading is a **red X** and never a green check:
its job is to say *ready for you to close*, not *closed*.

```text
# ❌ SESSION READY TO CLOSE

Memory, skills, rules, and documentation have been reviewed and updated.

Session-close status:

- Memory maintenance: complete
- Skill maintenance: complete | not required
- Rule/documentation maintenance: complete | not required
- Validation: passed | <each failure, named>
- Remaining unresolved items: <list> | None
```

Follow it with exactly this sentence:

> Session closeout is complete. You can now manually close this Claude session
> and start a new one.

Then stop. Do not claim the client session was terminated, and do not wait for
or invite a further command.

## Failure handling

- A memory or skill write that fails is reported as failed and the closeout is
  **not** claimed complete.
- A failing validation check is named under `Validation:` — never rolled up as
  passed.
- Nothing in this procedure justifies a commit, push, tag, deploy or migration.

## Safety

Repository-local writes only: never `~/.claude/`, never outside this tree.
Never commit, push, deploy, migrate production or run a destructive command
unless explicitly requested and approved (`CLAUDE.md` §Git Workflow). Preserve
unrelated working-tree changes. Never overwrite another session's memory. No
secrets, no logs, no speculation dressed as fact.

## Expected output

The report above, then the handshake heading and its sentence — in that order,
with nothing after them.

## Memory update

This skill *is* the memory update. If the closeout procedure itself changes,
edit this file rather than describing it in a `.memory/` entry.
