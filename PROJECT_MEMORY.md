# PROJECT_MEMORY.md

Orientation cache for agents and new contributors. **This file does not hold
knowledge — it points at where the knowledge already lives.** The repo carries
~600 KB of maintained documentation; duplicating any of it here would only give
it a second place to go stale.

Last verified against `feature/bot-commands` on 2026-08-28.

---

## 1. What this is

**PayeTam** (پایه‌تَم) — a Telegram marketplace for shared activities, in
Persian, RTL-first. A host publishes an activity; a stranger finds it and asks to
join; they negotiate anonymously in a Telegram chat before either knows who the
other is. Coins price the scarce actions, Trust Score prices the people.

Not a bot script. A **NestJS modular monolith** deployed on a single VPS via
Docker Compose, live in production at **`v0.4.1`** (deployed 2026-08-29).

## 2. Read these, in this order

| Question | File |
|---|---|
| What exists today, every route/table/flow | `docs/project-review.md` (52 K) |
| The master plan, frozen decisions, milestones | `docs/implementation-plan.md` (174 K) |
| Why a decision is what it is | `docs/adr/` (18 ADRs, index in `README.md`) |
| Setup, ports, testing inside Telegram | `README.md` §Local Development |
| Bare VPS → verified deploy | `DEPLOYMENT.md` (33 K) |
| Attack surface + accepted risks | `docs/threat-model.md`, `SECURITY.md` |
| Persian terms, error copy, typography | `docs/glossary-fa.md` |
| Admin panel screens | `docs/admin-panel.md` (30 K) |
| Adding a city or activity tag | `docs/activities-and-places.md` |
| Session handoff state | `.claude-work-checkpoint.md`, `.claude/RESUME.md` |

**Before changing architecture:** read the plan and the ADR index. Decisions
recorded there are frozen. Changing one means a *new ADR plus a plan update*,
never an edit in passing.

## 3. Layout

```
apps/      api · worker · miniapp · admin
packages/  db · domain · platform · telegram · shared · config
           domain/conversation — bot wizards (ADR-0017)
           telegram/wizard     — their keyboards, calendar, renderer
docker/    Dockerfiles, nginx vhosts, compose
docs/      plan, 18 ADRs, threat model, glossary, brand
test/      integration harness (real Postgres)
tools/     seeds, backup/restore, admin bootstrap
```

The load-bearing rule: **`packages/domain` holds all business logic and imports
no HTTP framework and no grammY.** `apps/api` and `apps/worker` are thin adapters
over the same services. That is what stops the bot and the Mini App from drifting
apart — treat it as an invariant, not a preference.

Scale: 52 Prisma models · 25 migrations · 15 API controllers · 42 domain services
· 20 domain modules · 15 Mini App views · 1309 unit/component tests.

## 4. The twelve invariants

Listed in full in `README.md` §The twelve invariants, with rationale in
`docs/adr/README.md`. **Violating one is a bug regardless of what a test says.**
The four that catch people out most often:

- **7** — `telegram_user_id` never appears in an API response, a log line, or a
  frontend bundle. Enforced by `apps/api/src/response-leak.int.test.ts`, which
  every new endpoint must be added to.
- **10** — every state transition goes through `assertTransition()` and writes
  `audit_log`.
- **11** — every outbound Telegram call goes through the queue, never inline in a
  request. One documented exception: `apps/api/src/telegram/membership.probe.ts`.
- **12** — every mutating admin action is authorised **in the service layer**,
  not only in a guard, and audited.

## 5. Working rules in force

Carried forward from the milestone briefs; they are not negotiable defaults.

- **Additive migrations only.** No column dropped, renamed or narrowed. No
  destructive DB commands.
- **No real Telegram sends in dev or test.**
- **No secrets in logs.**
- **Persian RTL conventions** throughout — see `docs/glossary-fa.md`.
- **Nothing is complete until typecheck + lint + format + tests + build pass.**
- **Explicit approval before any production action**, including `git push`.

## 6. Verification — the actual commands

```bash
pnpm -w typecheck            # tsc -b, project refs, + vue-tsc on both frontends
pnpm -w lint                 # eslint .
pnpm -w format:check         # prettier --check .
npx vitest run --project unit --project miniapp --project admin   # ~12 s
make db-test && pnpm test:integration   # real Postgres, ~20 min
pnpm --filter @payetam/miniapp build && pnpm --filter @payetam/admin build
```

`make help` lists the full development loop. `make dev` brings up the whole
stack; `make tunnel` + `make webhook` is how you test inside real Telegram.

**Fully green as of 2026-08-28 on `feature/bot-commands`** — the v0.3.1 baseline
below, re-verified after the bot-command work:

| Check | Result |
|---|---|
| `pnpm -w typecheck` | PASS |
| `eslint .` | PASS |
| `prettier --check .` | PASS |
| unit + miniapp + admin | **1309/1309** in 76 files (13 s) |
| **integration** (real Postgres) | **1363/1363** in 49 files (32 min) |
| **Docker production build** | api, worker, web all built |
| **nginx config validation** | syntax ok, test successful |

**2672 tests green in total.** The integration run's `ERROR`/`WARN` log lines are
negative-path assertions (an invalid blacklist regex, a refused Redis connection,
a campaign paused on repeated rate limits), not failures.

Validating nginx needs two things the config does not supply itself: an upstream
that resolves (`--add-host api:127.0.0.1`) and a self-signed placeholder cert per
domain, exactly as `scripts/init-letsencrypt.sh` writes before certbot first runs.
The two `ssl_stapling ignored` warnings are the documented no-op for a placeholder
chain.

## 7. Traps this repo has actually fallen into

Each of these cost a real debugging session. They are recorded because the test
suite was green through all of them.

1. **A green suite is not a booting app.** M22 wired a service into three modules
   without importing its `ChannelModule` into any of them. Nest scopes providers
   to the declaring module, so a root import is not enough — the API *and* the
   worker would have failed at boot. Unit tests use `new`, integration tests
   assemble by hand; nothing built a real graph. Now pinned by
   `apps/{api,worker}/src/app.module.test.ts`, which resolve both graphs with
   Nest's `preview: true` (no DB, no Redis, no consumers).
2. **A gate on data that does not exist refuses everything.**
   `ConsentService.hasAcceptedCurrentPolicies()` returned `false` when *no*
   policy version was published, which `AuthGuard` turned into
   `POLICY_VERSION_STALE` — bricking every gated write on a fresh install. Ask
   "what does this return on an empty set?" of every gate.
3. **`git add -A` swept up a deliberately-untracked file** into a commit. Two
   files at the repo root are untracked **on purpose**:
   `docs/production-deployment-todo.md` and `.claude-work-checkpoint.md`. Stage
   by path.
4. **Caches in front of consent are hostile.** A 30 s policy cache made the
   re-accept release refuse the very acceptance that would clear the gate. It was
   removed deliberately; the comment in the file records why.
5. **A bind mount hid an incomplete image.** The `web` target copied
   `nginx.conf`, `sites-available/` and `sites-enabled/` but **not `snippets/`**,
   which both site files `include`. Production bind-mounts all four paths read-only
   over the baked copies, so nginx started anyway and nothing ever surfaced it —
   but `docker run payetam/web` alone failed `nginx -t` and the container could
   never have become healthy. Fixed 2026-08-28 by adding the fourth `COPY`. The
   general shape: **a runtime mount that overrides baked config will mask a broken
   image until the one deploy that does not mount it.**
6. **An unbounded list becomes a message that can never be sent.** `/requests`
   and `/myevents` rendered every row `listMine` / `listOwned` returned, and
   neither read has a meaningful cap (`listMine` and `listForUser` take no `take`
   at all). Past Telegram's 4096 characters `sendMessage` returns
   `400 Bad Request: message is too long` — and `classify()` reads a bare 400 as
   `RETRY`, so the message would have been retried until it dead-lettered, for a
   user who simply never heard back. Every bot digest now goes through
   `buildDigest`, which caps by entries *and* by length and says how many it did
   not show. The general shape: **anything rendered into a Telegram message needs
   a ceiling at the point of rendering**, because the transport's rejection is
   permanent and looks retryable.
7. **A partial `Record<string, string>` with a `??` fallback renders the enum.**
   `ChatsView`'s `STATUS_FA` had three keys — one of which, `EXPIRED`, is not a
   `ChatStatus` — and fell back to `?? chat.status`. `listForUser` filters by
   nothing, so a Persian RTL screen showed the Latin word `ANONYMOUS` for what is
   the *usual* state of a live conversation. Typed `Record<Enum, string>` in
   `@payetam/shared` is the fix that stays fixed: a new status fails the build
   instead of appearing untranslated at a user. **A fallback that renders the raw
   value is how a missing translation stops being a build error and becomes a
   feature nobody notices.**
8. **A wizard that advances on a redelivered update skips a question.** Telegram
   retries any webhook call that did not answer 200, and the bot's old
   idempotency was *architectural* — it held no state, so there was nothing to
   advance twice. `conversation_state` removed that guarantee and
   `last_update_id` replaces it. Any new code path that mutates a draft must go
   through `ConversationService.handle`, which checks it. **A refused answer must
   consume its update too**, or the same complaint is shown twice.
9. **Reading text before checking for an open wizard sends it to a stranger.**
   `BotService.onText` handles two things through one channel: answers to a form,
   and messages relayed into an anonymous chat. The wizard is asked first and the
   relay only runs when there is no wizard. Reversed, an event description is
   delivered to somebody the user has never met — which `onText`'s own comment
   calls the worst thing this relay can do.
10. **`git add -A` swept up a deliberately-untracked file — again.** It happened
    a second time while staging the wizard work, caught only because the status
    output was read before committing. `docs/production-deployment-todo.md` and
    `.claude-work-checkpoint.md` are untracked **on purpose**. Stage by path, and
    read `git status` before every commit.
11. **The integration suite runs `dist`, not your edits.** The `integration`
    vitest project has no alias for `@payetam/*`, so they resolve through
    `node_modules` to each package's `dist`. Edit a package and run the
    integration tests without building and **you are testing the previous
    build** — which cost a long debugging session chasing a routing bug that had
    already been fixed in source. `pnpm -w typecheck` runs `tsc -b` and therefore
    builds; running it before the integration suite is what makes the suite
    honest. The unit project has the same shape for `@payetam/shared`.
12. **After a prefill, "the form has a value" stops meaning "the user chose
    it".** `EDIT_EVENT` fills the draft from the event so the summary can show
    it, and skipping the time steps then wrote the time *back* — moving an event
    at 22:45 to 22:00, because the wizard offers whole hours. Any edit wizard that
    prefills needs `touchedFields`, which the machine maintains. The general
    shape: **a default that is indistinguishable from an answer will eventually
    be saved as one.**
13. **The bot bypassed the policy gate for two milestones.**
    `@RequiresCurrentPolicies()` is a route decorator read by `AuthGuard`, and
    `BotService` does not pass through `AuthGuard` — it calls domain services
    directly. So chat relays, participation decisions and contact sharing were
    all possible without a current acceptance, from M13 until ADR-0017. The
    general shape, which `BotService`'s own comment already stated and which
    nobody had checked against the *gate*: **a rule enforced in a guard protects
    the surface the guard runs on, and the bot is not that surface.** Ask of any
    new cross-cutting rule: which surfaces does it actually reach?
14. **A message that is not edited becomes a keyboard that outlives its step.**
    `conversation_state.last_message_id` was never set in v0.4.0, so every wizard
    step sent a *new* message. The visible bug was chat clutter; the damaging one
    was that old keyboards stayed on screen, and tapping one sent a callback for
    a step the user had left — which the current step refused with a message
    about a different field. It was reported as «the Free button is broken». Two
    fixes, and both are needed: the worker records the id after sending a
    `bot.wizard`, and a callback whose action does not match the current step
    **re-renders instead of refusing**.
15. **Showing a document's *title* is not showing the document.** The consent
    gate printed «TERMS v1 — قوانین استفاده از پایه‌تَم» over an accept button.
    Consent to something nobody has been shown is not consent, and this is the
    one screen in the product where that distinction is legal rather than
    aesthetic.
16. **A test can encode the bug.** The unit test covering the too-short-title
    refusal asserted the Latin `3` it produced. It passed for as long as the bug
    existed and would have failed on the fix. When a walkthrough disagrees with a
    green test, the test is a suspect too.
17. **`ALTER TYPE … ADD VALUE` cannot run in a transaction** in Postgres, which is
   why migrations 0022 and 0023 are separate files. They are not rolled back by a
   later failure — additive-only, so a partial apply is safe, but the runbook
   must say so.

## 8. Deliberate design positions — do not "fix" these

- The channel membership gate **fails open on every outcome except an
  authoritative `NOT_MEMBER`**, so a Telegram outage degrades the gate rather
  than the product. It is **off by default**.
- `APP_ACCESS` gating is enforced **by the router, not `AuthGuard`** — a gate
  over every authenticated route would refuse the very calls the screen that
  clears it is built from.
- `ledger.drift` **reports and never repairs.** Auto-correcting would either
  overwrite a balance a user holds or write a plug entry into an append-only
  ledger.
- Trust Score renders as «تازه‌وارد», never `0`, for an unjudged account —
  rendering it as zero would be a claim about a person that is not true.
- The two brand marks are **copies** across `apps/{miniapp,admin}/public/brand/`
  (separate nginx roots, one Vite `publicDir` each). `docs/brand.md` §3–4 is the
  checklist that keeps them in step. Nothing enforces it.

## 9. Patterns already abstracted

Reach for these before writing a new one:

| Concern | Where |
|---|---|
| Domain contracts + error codes shared across all four apps | `packages/shared/src/contracts/`, `errors.ts` |
| Persian normalization + search folding | `packages/shared/src/search-fold.ts` |
| Telegram message building, escaping, keyboards, callback data | `packages/telegram/src/` |
| Outbox → Telegram relay, all job processors | `apps/worker/src/queues/processors.service.ts` |
| Rate limiting, encryption, clock | `packages/platform/src/` |
| State transitions + audit | `packages/domain/src/state-machine.ts` |
| Idempotency for paid actions | `Idempotency-Key`, see economy module |
| Bot digests, capped to Telegram's message limit | `packages/telegram/src/digest.ts` |
| The bot's command list — menu, `/help`, dispatch | `packages/telegram/src/commands.ts` |
| Multi-step bot forms: steps, validation, persistence | `packages/domain/src/conversation/` |
| Their keyboards, Jalali calendar and screens | `packages/telegram/src/wizard/` |

## 10. Conversation wizards, and the state the bot now keeps

**The bot was stateless and is not any more.** ADR-0017 reversed the position
this section used to record — *single-turn work in the bot, forms in the Mini
App* — because the product owner decided to retire the Mini App and move the
forms into the chat. Read the ADR before touching any of it; what follows is the
map, not the argument.

### The two halves

`packages/telegram/src/wizard/` is **pure presentation**: the `wz:` callback
codec, the Jalali calendar, the paged choice keyboard, and `renderStep` /
`renderSummary`. No database, no services.

`packages/domain/src/conversation/` is the **machine**: `wizard.ts` holds
`apply`, `nextStep`, `previousStep` and `progressOf`, all pure functions over a
form; `conversation.service.ts` holds persistence, idempotency and the walk;
`wizards/` holds one file per form.

### Adding a wizard

- write `wizards/<name>.ts`: a list of `WizardStep`s and an `empty()`
- register it in `WIZARDS` in `conversation.service.ts`, keyed by the
  `ConversationKind` enum member (a new member is a migration)
- dispatch a command for it in `BotService.onCommand`, add it to `BOT_COMMANDS`
- handle its `submit` in `drawWizard` — that is where the *thing* gets created,
  by the same domain service the API calls

### The five things that are load-bearing

1. **`last_update_id` is the idempotency.** Telegram retries any webhook call
   that did not answer 200. An update not greater than the stored one is a
   redelivery: **re-render, never advance.** Advancing twice skips a question and
   leaves somebody looking at the answer to one they were never asked. A
   *refused* answer consumes its update too, or the complaint appears twice.
2. **`conversation_state.user_id` is UNIQUE, and that is the authorisation
   model.** A wizard callback carries a step and a value and *no draft id*; the
   draft is found by the authenticated sender. "Can user A advance user B's
   wizard?" is answered by there being nothing in the button that names B.
3. **A wizard is one message, edited.** `lastMessageId` addresses it, and the
   redraw is a `BOT_EDIT_MESSAGE` job — invariant 11 has no exception for
   wizards. The payload carries the internal `user_id`, never a chat id; the
   worker resolves the Telegram id through `NotificationService.telegramTargetFor`
   at delivery, exactly as notifications do.
4. **Text typed while a wizard is open is an answer, not a chat message.**
   `BotService.onText` asks `conversations.handle` *first* and only relays when
   it returns null. Get this backwards and an event description goes to a
   stranger.
5. **Conditional fields are `when`, not a refusal.** The cost-amount step is
   *asked* only for FIXED and APPROX, and `nextStep` re-evaluates on every move —
   so «رایگان» after «مبلغ مشخص» removes the step even though it was visited. The
   stale amount is cleared in the same patch, which is why `FormPatch` is a mapped
   type and not `Partial` (under `exactOptionalPropertyTypes` only the former can
   express *clearing* a field).

### Dates are Jalali now

`packages/telegram/src/wizard/jalali.ts` renders the Persian calendar through
ICU. `datetime.ts` still renders Gregorian and its comment explains why — *the
Mini App renders Jalali* — which stopped being true. `node:22-alpine` carries
full ICU; this was verified **inside the image**, not on the host.

The grid is walked in Gregorian and labelled in Jalali, so Jalali→Gregorian —
where hand-written implementations get leap years wrong — is never needed. The
week starts on **شنبه**; a grid starting Monday puts every date under the wrong
heading, which looks like styling and is a wrong date.

### The four wizards

| Kind | Command | Shape |
|---|---|---|
| `CREATE_EVENT` | `/create_event` | eleven steps, then a summary; the optional nine are behind «افزودن جزئیات بیشتر» |
| `EDIT_PROFILE` | `/edit_profile` | six steps, every one skippable |
| `EDIT_EVENT` | `/edit_event` | `pick`, then the create wizard's own steps with `optional` set |
| `ACCEPT_POLICIES` | opened by the gate, or `/terms` | one step, not cancellable |

`EDIT_EVENT` reuses `createEventWizard.steps` rather than redefining them, and a
test asserts the two lists stay equal. A second copy of sixteen validators is the
thing that arrangement exists to prevent.

### The consent gate

**`AuthGuard` does not run for the bot.** The policy gate is declared per route
with `@RequiresCurrentPolicies()`, and `BotService` calls domain services
directly — so every bot write bypassed it from M13 until ADR-0017: chat relays,
participation decisions, contact sharing. `BotService.mayWrite` is the gate on
this surface, and it is called by **every** write path.

It returns a boolean rather than throwing, because the answer to "you have not
accepted" is a *screen*: the consent wizard opens where the refused action would
have happened.

**The channel requirement is a check, not a wizard step.** An operator can switch
it on next week or add a channel, so nobody ever finishes it — which is exactly
why the Mini App declares `/join-channels` outside `ONBOARDING_PATHS`.

### What is still in the Mini App

`JoinChannelsView` is the last user-facing screen with no bot equivalent, and it
does not need one: the gate renders as a message with a URL button per channel.

**The Mini App can now be retired**, in this order and no other: the bot takes
consent (`ACCEPT_POLICIES`), completes profiles (`/edit_profile`), and creates
and edits events. Turning it off before the bot could take an acceptance would
have refused **every gated write for every user** — the shape of trap 2 below,
which would have bricked v0.3.0.

`apps/admin` is unaffected and stays. ADR-0003 still governs it.

### The read-only commands

`/start`, `/help`, `/discover`, `/balance`, `/requests`, `/myevents`, `/chats`,
`/reviews`, `/profile`, `/terms`. The list lives in `packages/telegram/src/commands.ts`,
`commands.test.ts` asserts it advertises only commands the dispatch switch
handles, and `pnpm set-bot-commands` publishes it to Telegram's menu. Until that
script existed `setMyCommands` had never been called, so the "/" autocomplete was
empty and every command was invisible.

**Persian status labels are per-perspective, not per-enum.**
`PARTICIPANT_STATUS_GUEST_FA` and `PARTICIPANT_STATUS_HOST_FA` in
`@payetam/shared` describe the *same nine statuses* differently, because the
difference is «شما». Seven of the nine differ. **Do not collapse them.**
`EVENT_STATUS_FA` and `CHAT_STATUS_FA` are single maps, because a status there is
a fact about the thing rather than a relationship between two people.

**Deep links.** Every «باز کردن برنامه» button is
`https://t.me/<bot>?startapp=<target>`, resolved against a fixed allowlist in
`deepLinkTarget()` — the payload is attacker-supplied. Pinned by
`apps/miniapp/src/telegram/deep-links.test.ts`, which renders every template and
checks its target. It found two that had never worked.

## 10a. v0.4.0 / v0.4.1 — the bot wizards

Merged to `master` (`2c98a31`), tagged, **deployed 2026-08-29**. 27 smoke checks
passed; `.deploy/previous-release` reads `v0.3.1`.

| Piece | State |
|---|---|
| `ACCEPT_POLICIES` — the consent gate | done, 6 integration tests |
| `CREATE_EVENT` — `/create_event` | done, walked end to end to a real `event` row |
| `EDIT_EVENT` — `/edit_event` | done, reuses the create steps |
| `EDIT_PROFILE` — `/edit_profile` | done |
| `/terms` | done |
| `ENABLE_CONVERSATION_WIZARD` | rollback lever, defaults on, non-destructive off |
| Manual test in Telegram | **never run** — risk accepted, see below |
| Merge / tag / deploy | done; migration 0025 applied |
| Command menu | 12 commands published — the first time `setMyCommands` has ever been called |

**It shipped without a manual test in Telegram, deliberately.** `make webhook`
calls `setWebhook` on whatever token `.env` holds, and that token is the
**production** bot — running it would deliver real users' messages to a laptop,
and a *failed* `setWebhook` deletes the previous registration. A real manual test
needs a second bot from BotFather, which nothing here can create. The product
owner accepted that risk against a cheap rollback; `scripts/manual-test-results.md`
records what is and is not verified.

**The first person to walk a wizard in Telegram was a user, and it showed.**
v0.4.1 is the repair: ten reports, eight of which traced to one fault — the
wizard never edited its own message, so old keyboards accumulated and taps landed
on steps the user had left. The walkthrough could not have caught it; it renders
screens, and this was a bug about *which* screen a tap reaches. What would have
caught it is twenty minutes in Telegram. If something
looks wrong in production, the honest first move is still the twenty-minute walk
with a BotFather token — it is the only thing that reproduces what a user sees.
The fast lever meanwhile is `ENABLE_CONVERSATION_WIZARD=0` plus an API restart,
which reverts the bot to read-only and keeps drafts in flight. Note the variable
is **absent** from production's `.env` rather than set to `1`, so turning it off
means appending the line, not editing one.

**What was done instead.** `pnpm bot-walkthrough` (`tools/bot-walkthrough.ts`)
drives the real step machine through the real renderer and prints every screen —
no database, no network. It found two bugs the 2672 automated tests could not:
a calendar row of seven blank buttons, and validation messages in Latin digits
sitting under a Persian progress line. Run it after touching any wizard; a
removed button or a changed screen shows up in a diff of its output.

Retiring the Mini App is planned separately in
`docs/v0.4.1-mini-app-retirement-plan.md` and is **more than a config change**:
21 templates carry a deep link, and five of them point at screens the bot still
does not have.

## 11. Open operational items

From `.claude-work-checkpoint.md` §2 — none blocking, all worth knowing:

1. `MONITORING_CHAT_ID` is empty in production — alerts log to the container only.
2. Backups are **plaintext and single-host**. `PAYETAM_BACKUP_GPG_RECIPIENT` and
   `PAYETAM_BACKUP_REMOTE` unset. `DEPLOYMENT.md` §10 has the steps; do this
   before real users exist.
3. Pushing a release tag may trigger `.github/workflows/deploy.yml`, whose
   `deploy` job sits behind `environment: production`.
4. **The server holds no private SSH key.** `git fetch` from GitHub therefore
   fails unless you connect with `ssh -A` and have the key in your local agent.
   Every deploy that fetches needs agent forwarding; `deploy.sh --no-pull` does
   not fetch, so the tag must be on the server before it runs.
5. **`git fetch --tags` exits 1 on this server.** A stale local `v0.3.0` tag
   differs from origin's, so fetch reports *would clobber existing tag* and
   returns non-zero — which silently aborted a deploy chained behind `&&`.
   Production was untouched, and the failure produced no output at all, which is
   the worst kind. Fetch the one tag instead:
   `git fetch origin refs/tags/<tag>:refs/tags/<tag>`.
6. **Do not `git checkout <tag>` before running `deploy.sh <tag>`.** The script
   records the currently-deployed ref as the rollback target *before* it checks
   out. Checking out first makes the new tag its own rollback target — which is
   what made `rollback.sh` a no-op after the v0.3.0 deploy.
