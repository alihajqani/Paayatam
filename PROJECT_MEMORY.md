# PROJECT_MEMORY.md

Orientation cache for agents and new contributors. **This file does not hold
knowledge — it points at where the knowledge already lives.** The repo carries
~600 KB of maintained documentation; duplicating any of it here would only give
it a second place to go stale.

Last verified against `master` on 2026-08-30.

---

## 1. What this is

**PayeTam** (پایه‌تَم) — a Telegram marketplace for shared activities, in
Persian, RTL-first. A host publishes an activity; a stranger finds it and asks to
join; they negotiate anonymously in a Telegram chat before either knows who the
other is. Coins price the scarce actions, Trust Score prices the people.

Not a bot script. A **NestJS modular monolith** deployed on a single VPS via
Docker Compose, live in production at **`v0.6.3`** (deployed 2026-08-30).

## 2. Read these, in this order

| Question | File |
|---|---|
| What exists today, every route/table/flow | `docs/project-review.md` (52 K) |
| The master plan, frozen decisions, milestones | `docs/implementation-plan.md` (174 K) |
| Why a decision is what it is | `docs/adr/` (18 ADRs, index in its own `README.md`) |
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

Scale (measured 2026-09-03 on `fix/bot-qa-round-1`): 56 Prisma models · 43 migrations
· 14 API controllers · 47 domain services · 20 domain modules · 143 test files,
51 of them integration. Re-measure rather than trusting this line.

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
  not only in a guard, and audited. This is what let the bot become a *fourth*
  admin caller in v0.6.3 without a fourth copy of the rules: `BotService` holds
  no permission check of its own (ADR-0018).

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
make typecheck               # tsc -b, project refs, + vue-tsc on both frontends
                             # NOT the bare `rtk pnpm <script>` shorthand: it
                             # reports a FAILING run as green and exits 0.
                             # See .memory/runtime/verification.md
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
16. **`dispatch` catches everything, so a throw is a silent no-op.** The webhook
    must answer 200 (ADR-0004), so `BotService.dispatch` swallows every error into
    a log line. A colon in a BullMQ job id therefore froze **every wizard step
    after the first, for every user**, while the integration tests stayed green —
    they assert on *state*, and the state was always correct: the conversation
    advanced, the event was created, and nothing reached a screen. **Assert that
    a message was produced, not only that the row moved.** When a bot path looks
    dead in production and the tests are green, read the API log for
    `Update <id> failed:` before anything else — that is where a swallowed throw
    goes.
17. **One update can owe two messages.** `reply` deduped on `bot:<updateId>`, so
    the second message of any update was absorbed by the UNIQUE index and never
    sent — a redelivery guarantee doing its job to something that was not a
    redelivery. The key is per (update, template) now. Exactly-once was never
    one-message-per-update; that was an assumption that held while every branch
    replied once.
18. **A test can encode the bug.** The unit test covering the too-short-title
    refusal asserted the Latin `3` it produced. It passed for as long as the bug
    existed and would have failed on the fix. When a walkthrough disagrees with a
    green test, the test is a suspect too.
19. **`ALTER TYPE … ADD VALUE` cannot run in a transaction** in Postgres, which is
   why migrations 0022, 0023, 0029 and 0031 are separate files. They are not
   rolled back by a later failure — additive-only, so a partial apply is safe,
   but the runbook must say so.
20. **A totality test stays red for a whole release if nobody runs its suite.**
   `response-leak.int.test.ts` asserts that every route the app registers is in
   its scan list, and v0.6.1 shipped `GET`/`PUT /api/v1/me/settings` without
   adding them — so the test that exists to make "an endpoint nobody scanned" a
   build failure was itself failing, in production, for two releases. It was
   found in v0.6.3 by running the integration suite, which is a **32-minute** job
   and is therefore the one check that gets skipped when a change "obviously
   cannot have broken anything".
   Nothing was leaking. That is not the point: "nothing was leaking" became a
   fact somebody established *afterwards*, and the whole value of the list is
   that it is established before the deploy. **The general shape: a check that
   only fails in the slowest suite is a check that is off by default.** Run the
   integration suite before tagging, not after.

21. **A mechanism that works exactly as written can still be wrong on the
   screen.** v0.6.5 was sixteen QA findings and the majority had this shape.
   `accepted_count` counted PENDING as a seat — correct by its own definition,
   and it made an activity with two places report «ظرفیت تکمیل» while one request
   had been rejected and another had expired, because each release promoted
   somebody who took the seat again. Both quotas raised one error code, so an
   operator raising the daily limit watched the concurrency limit keep refusing
   and reported the setting as broken. The publish dialog compared `Number()`
   against a version the panel renders in Persian digits, so a button was
   unclickable for every operator who has ever used it. **Ask what the user sees,
   not whether the code does what it says.**
22. **A configurable action nothing enforces is a setting that lies.**
   `GATED_ACTIONS` had five members; four were checked in the service that owns
   the operation and `APP_ACCESS` was documented as *the Mini App router's* job —
   on a product whose Mini App is being retired. An operator switched the
   requirement on, chose the widest action, and nothing happened. The rule that
   would have caught it is already in the file that declares the list: *"a
   configurable action nothing checks is a setting that silently does nothing,
   which is worse than one that does not exist."* It was true when written and
   stopped being true when the surface it named went away. **A comment naming
   which surface enforces something is a dependency on that surface still
   existing.**
23. **Shared normalization across two things that only look alike.**
   `normalizeCode` upper-cased and stripped separators for referral codes — right,
   because they are generated from a fixed alphabet and read aloud — and gift
   codes reused it. An operator's `test1` was therefore also redeemable as
   `test 1`. For a *bearer secret whose text a human chooses*, folding is the
   keyspace collapsing inwards. **Two callers of one normalizer is a question
   about whether they are the same kind of value.**
24. **A refusal that carries a payload nobody renders.**
   `CHANNEL_MEMBERSHIP_REQUIRED` has carried `details.channels` and
   `details.joinUrl` since M22 "so the bot and the Mini App can list them from
   the refusal itself" — and the bot rendered `ERROR_MESSAGES_FA[code]`, one
   sentence, throwing the links away. The user was told to join a channel and
   given no way to. **When an error is built to carry detail, grep for who reads
   it.**
25. **A catalogue table nothing populates makes its form unanswerable.**
   `district` is curated, `seed-geography.ts` says outright that the dataset has
   none, and no admin screen creates one — so the bot's «کدام محله؟» step drew a
   keyboard with only «رد کردن» on it, in every deployment that has ever existed.
   **A `load()` that can legitimately return `[]` needs an answer for that case
   at the point the question is asked.**

26. **Trap 1 again, and silent this time: `@Optional()` turned a mis-scoped
   provider into a gate that admitted everybody.** `MEMBERSHIP_PROBE` was
   registered in `AppModule`'s own `providers` array, under a comment saying
   `ChannelMembershipService` would resolve it there. It cannot:
   `ChannelMembershipService` is declared in `ChannelModule`, which imports
   `CatalogModule` and nothing else, and Nest scopes providers to the declaring
   module. The first instance of this trap (§7.1) failed to *boot*, which is
   loud. This one injected `undefined` into an `@Optional()` parameter, so
   `probeFor` answered `{ kind: 'UNKNOWN', reason: 'NO_PROBE' }` for every
   channel — and every outcome except an authoritative `NOT_MEMBER` **fails open
   by design**. So the mandatory-membership requirement admitted everybody, on
   every surface, from M22 until v0.8.1, and nothing anywhere reported a problem:
   `app.module.test.ts` passed (the graph resolves — that is what optional
   means), the integration suite passed, and an operator who switched the
   requirement on watched nothing happen and had no way to tell why.
   The fix is a `@Global()` module in `apps/api`, which is how every other
   cross-cutting port here is published. The general shape, and it is the sharper
   half of §7.1: **`@Optional()` converts a wiring error into a behaviour
   change.** Any `@Optional() @Inject(TOKEN)` across a module boundary needs a
   test that the token actually arrives — asserting the graph resolves proves
   nothing, because the graph resolves either way. And a fail-open default under
   a mis-wired dependency is a feature that silently does not exist.

27. **A template with no producer is a feature nobody shipped.**
   `TEMPLATES.REVIEW_WINDOW_OPEN` had Persian copy, a notification category, a
   deep link and a `render()` case from M12, and **nothing ever emitted it** — so
   for the whole seven-day review window the only way to learn a review was owed
   was to open `/reviews` and look. It is §7.24 pointing the other way (*when an
   error is built to carry detail, grep for who reads it*): **when a template is
   written, grep for who sends it.** `notification-category.ts` listing a key is
   not evidence that anything produces it.

## 8. Deliberate design positions — do not "fix" these

- The channel membership gate **fails open on every outcome except an
  authoritative `NOT_MEMBER`**, so a Telegram outage degrades the gate rather
  than the product. It is **off by default**. Failing open is the position;
  *never having a probe* was a bug (§7.26) and is not — `MembershipProbeModule`
  is `@Global()` for that reason and must stay a module import rather than a
  provider on `AppModule`.
- **The bottom keyboard is one button, and only on messages that carry no inline
  keyboard** (v0.8.1). `reply_markup` holds one thing *per message*, but a reply
  keyboard lives on the **client** until another replaces it — so «☰ منوی اصلی»
  is attached where `remove_keyboard` used to go, stays put while messages with
  inline keyboards go past, and competes with nothing. v0.7.0's argument for
  removing the menu was about *seven* labels crowding every screen; it was never
  an argument against one. Do not re-add the other six, and do not "simplify" the
  sender by attaching it to every message — an inline keyboard would then be
  dropped.
- **Asking to join is a deposit, not a fee** (v0.8.1). `economy.event_join_coins`
  is charged inside the join transaction and **reversed whenever the guest never
  got an answer** — a rejection *and* an expiry. `refundJoinCharge` undoes the
  ledger row rather than crediting today's price, so a refund cannot drift from
  what was taken, and the two carry different reason codes because «the host said
  no» and «the host never answered» are different answers to "why did this number
  move". A **withdrawal is not refunded**: the guest changed their mind, and
  `cancel` prices that on its own thresholds. The comment in `join` that used to
  say refunding "would make this a deposit, which is a different product
  decision" records the decision that was taken, not one still open.
- `APP_ACCESS` gating is enforced **by the router, not `AuthGuard`** — a gate
  over every authenticated route would refuse the very calls the screen that
  clears it is built from. From v0.6.5 that means **both** routers: the bot's
  `route`/`onCallback` and the Mini App's. `/start` and `/help` are exempt, and
  that is not an oversight — gating account creation would refuse the deep links
  the join screen sends people back through.
- **A seat is consumed by an acceptance and nothing else** (v0.6.5).
  `accepted_count` counts ACCEPTED only; a PENDING request holds a *slot in the
  host's queue*, which is what `join` admits against. Do not "restore" PENDING to
  the seat-holding set to make the waitlist work — `SLOT_HOLDING_STATUSES` is
  what makes it work, and the reason for the split is written on both constants.
- **Gift codes are matched exactly; referral codes are not.** The two look like
  the same kind of string and are not: one is generated from a fixed alphabet and
  read aloud, the other is chosen by an operator and worth money. Do not
  re-unify `exactCode` and `normalizeCode`.
- **Birth year is Gregorian in the column and Jalali on the screen.** The
  conversion is at the wizard boundary (`edit-profile.ts`), the same rule ADR-0008
  sets for timestamps. Do not migrate the column.
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
ICU. `node:22-alpine` carries full ICU; this was verified **inside the image**,
not on the host.

`datetime.ts` rendered Gregorian until v0.6.5, on a comment — *"the Mini App
renders Jalali"* — that had stopped being true twice over. What it produced was
«۰۷/۰۹/۲۰۲۶، ۱۲:۰۰», a Gregorian date wearing Persian digits, on the three most
public surfaces the product writes: channel posts, paid invitations and the
moderation case digest. It is now `formatJalali` + `formatJalaliTime`, and every
date a user reads is Persian.

The grid is walked in Gregorian and labelled in Jalali, so Jalali→Gregorian —
where hand-written implementations get leap years wrong — is never needed. The
week starts on **شنبه**; a grid starting Monday puts every date under the wrong
heading, which looks like styling and is a wrong date.

### The wizards

| Kind | Command | Shape |
|---|---|---|
| `CREATE_EVENT` | `/create_event` | eleven steps, then a summary; the optional nine are behind «افزودن جزئیات بیشتر» |
| `EDIT_PROFILE` | `/edit_profile`, `/interests` | seven steps, every one skippable; the last is a **multi-select** over the interest catalogue, and `/interests` opens the same wizard with the other six `when`'d out |
| `EDIT_EVENT` | `/edit_event` | `pick`, then the create wizard's own steps with `optional` set |
| `ACCEPT_POLICIES` | opened by the gate, or `/terms` | one step, not cancellable |
| `WRITE_REVIEW` / `FILE_REPORT` / `ADMIN_CASE` / `REDEEM_CODE` | see §10b | |
| `BUG_REPORT` | `/bug`, «🐞 گزارش مشکل» | a description, then screenshots — **the only wizard that takes a photo** |

`EDIT_EVENT` reuses `createEventWizard.steps` rather than redefining them, and a
test asserts the two lists stay equal. A second copy of sixteen validators is the
thing that arrangement exists to prevent.

**`BUG_REPORT` is why `WizardInput` grew a `photo` kind** (v0.6.5). Every other
surface answers a photo with «این نوع پیام پشتیبانی نمی‌شود» — criterion 11, and
right for the chat relay, where a forwarded image is a payload nothing can
moderate, encrypt or account for. It is exactly wrong for the one form whose
value *is* the screenshot. `value` then carries a Telegram **`file_id`**: the
image stays on Telegram's servers and the product stores a handle, so there is no
retention policy, deletion path or scanning question to own.

The photo step is **last**, so every picture lands back on the summary with the
count one higher rather than advancing — which is what makes "send five
screenshots" five messages and one growing summary rather than five forms.

**Two steps that changed shape in v0.6.5**, both because the question had no
answerable form:

- `EDIT_PROFILE`'s birth year asks in **Jalali** and stores Gregorian. It used to
  ask for Gregorian and refuse ۱۳۷۰ with an explanation of how to convert it —
  the product asking a Persian speaker to do arithmetic it could do itself, three
  screens after a Jalali date picker. The column is unchanged.
- `CREATE_EVENT`'s `dist` step accepts **typed text** as well as a tap. See §7
  trap 25: the district catalogue is empty everywhere, so the keyboard had only
  «رد کردن» on it. A typed neighbourhood lands in `event.district_label`,
  mutually exclusive with `district_id` by CHECK.

### The consent gate

**`AuthGuard` does not run for the bot.** The policy gate is declared per route
with `@RequiresCurrentPolicies()`, and `BotService` calls domain services
directly — so every bot write bypassed it from M13 until ADR-0017: chat relays,
participation decisions, contact sharing. `BotService.mayWrite` is the gate on
this surface, and it is called by **every** write path.

It returns a boolean rather than throwing, because the answer to "you have not
accepted" is a *screen*: the consent wizard opens where the refused action would
have happened.

From v0.6.5 it gates **two** things, in this order: a `SUSPENDED` account is
refused first, then the policy acceptance. Suspension is write-only — a suspended
user can still read their events, chats and wallet, which is the difference
between a suspension and a slower ban, and is what `MessagingService` already
assumed by treating `SUSPENDED` as reachable for broadcasts. Until v0.6.5
`user.status = 'SUSPENDED'` was written by the panel and read by nothing.

**The channel requirement is a check, not a wizard step.** An operator can switch
it on next week or add a channel, so nobody ever finishes it — which is exactly
why the Mini App declares `/join-channels` outside `ONBOARDING_PATHS`.

It is **not** in `mayWrite`, and that is deliberate: the four per-action gates are
enforced by the services that own the operations, and putting a generic check in
`mayWrite` would apply whichever action an operator configured to every write.
What the bot enforces is `APP_ACCESS`, in `route` and `onCallback` — see §7 trap
22 for why it was enforced by nothing at all until v0.6.5.

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

## 10b. v0.6.3 — buttons everywhere, and a staff surface in the chat

**Deployed 2026-08-30**, commit `4420c70`, from v0.6.1 — v0.6.2 was tagged and
never deployed, so this release carried it too. 27/27 smoke checks; migrations
0029, 0030 and 0031 applied; every data-integrity count identical to the
pre-deploy baseline (1 admin, 3 users, 4 events, 10 ledger rows, 0 moderation
cases, 0 Telegram links). The two warnings are the standing ones in §11 —
`MONITORING_CHAT_ID` empty and backups plaintext and single-host — not anything
this release introduced.

Two things are shipped **off**, deliberately, and both are one row away from on:
`economy.event_join_coins` has no `app_setting` row (so joining is free, as it
has been since M6), and `admin_telegram_link` is empty (so no moderation queue
is reachable from any Telegram account).

Four things, and the thread running through all of them is that **a command is a
fallback now, not a path**. The persistent keyboard plus a button on every screen
is how the product is reached; `/settings`, `/discover` and the rest still work
because somebody who has learned one should not be told to go and find a button.

### Settings became a board where every row is a switch

Two of the three areas used to be *sentences telling the reader to send a
command* — «برای تغییر این مورد، /edit_profile را بفرستید» under privacy, and an
italic line under language. Both true, both the wrong shape: a board of switches
where two rows answer a tap with homework teaches the reader that the rows are
decoration.

Three areas, three stores, **nothing copied between them**:

| Area | Where it lives |
|---|---|
| Notifications | `user_settings` (migration 0028) |
| Privacy | `user_profile.invite_opt_out`, which the invitation pool already reads |
| Language | `user.locale`, one value, fa-IR |

Privacy is carried in the callback as **what the reader sees** («دریافت دعوت»)
and inverted once, at the write. A payload already in the column's polarity is
where that bug hides. Somebody with no profile row has no flag to flip and
`ProfileService.update` refuses — so the switch is replaced by the button that
opens the profile form. **A switch that exists to be refused is worse than the
button that fixes the reason.**

`GET`/`PUT /api/v1/me/settings` covers the same three areas, assembled from the
same three reads, and the PUT writes the profile first because that is the half
that can refuse.

### The channel post got two buttons, and both reach the bot

The single one opened the **Mini App** — the application v0.4.6 spent a release
removing every other button to. «👀 مشاهده در ربات» and «✅ شرکت می‌کنم», both
`?start=` links, and the link form is not stylistic:

> **The bot cannot message somebody who has never opened a chat with it.** A
> `callback_query` from a channel reader could be answered with a toast and
> nothing else — no acknowledgement, no host notification, no explanation of a
> refusal. Following a link opens the chat, which is what makes every message
> after it deliverable. It also survives a post forwarded out of the channel.

`parseStartPayload` runs *before* the referral claim and is told apart by shape,
so a channel tap does not log a refused referral. A reader who owes an acceptance
gets the welcome, the activity **with its join button**, and the consent screen —
stopping at the gate would leave them having accepted the policies with no way
back to the activity, because the post is in a channel they have now left.
Nothing is remembered; the id is in the button.

**`economy.event_join_coins` ships at 0.** The button reaches the same
`ParticipationService.join` the in-bot one does, so a non-zero default would have
started charging for every join on every surface as a side effect of adding a
button to a channel post. The mechanism is there; the price is one row in
`app_setting`.

### Admin moderation in the bot (ADR-0018)

**This spends a control rather than adding one.** ADR-0010's separation of the
two identity systems *was* the control, and its second decision says admin access
must not follow from a staff member's personal Telegram being taken over. Read
the ADR before touching any of it; what follows is the map.

Four properties bound the trade, and each is enforced rather than described:

1. **Granted, never derived, and never by yourself.** `admin_telegram_link` is
   written by an admin holding `role.manage`, with a reason, in an audit row.
   `tools/link-admin-telegram.ts` refuses when `--by` and `--email` match. There
   is deliberately **no admin endpoint** — a route taking a Telegram id would put
   invariant 7's value in request logs, browser history and a Vue bundle at once.
2. **The session is an intersection.** `BOT_PERMISSIONS` is a hard-coded
   allowlist — `event.moderate`, `report.review` — and a `SUPER_ADMIN` on the bot
   is a moderator and no more. **A list in code because it is the boundary of a
   channel rather than a job.** Adding a line is another ADR.
3. **No foreign key to `user`.** The Telegram id is carried directly, so the two
   identity systems stay disjoint tables.
4. **The submit resolves the session again.** A wizard lives seven days; deciding
   from the session that opened the form would let a revoked moderator finish
   work they started before losing access. That is the load-bearing test.

`moderate` is **not** in `BOT_COMMANDS` — publishing a staff command to everyone
makes "is there an admin surface?" a question the bot answers on request. A
stranger who guesses it gets the unknown-command sentence *byte for byte*,
through the same method, so the two cannot drift apart. And «🛡 داوری» resolves
for everybody and authorises nobody, because a menu label that failed to resolve
would be **relayed into an anonymous chat** (trap 9's shape).

What the queue may show is bounded twice — by the two permissions, and by the
fact that a chat message can be forwarded out of the chat it was sent to. Report
reasons counted, never quoted; blacklist matches counted, never named; a
`MESSAGE` case carries nothing and says so.

### Who is coming, and the no-show

Already built in v0.6.2 and reachable from `/myevents`; v0.6.3 pinned the other
route — a host opening their **own** activity's detail screen gets «👥 مهمان‌ها»
where a guest gets «پیوستن», and neither joining nor reporting, both of which the
services would refuse.

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

---

## 12. v0.4.2 — the fresh-deploy runbook, and what it caught

On 2026-08-29 the production stack was rebuilt from nothing: all four volumes
and every container destroyed, then brought back up on v0.4.2. What follows is
what was actually done and what it found, because the two are not the same list.

### The order that works

Certificates **before** `deploy.sh`, not after. `deploy.sh` ends in
`smoke-tests.sh`, which fetches `https://app.paayatam.online/health` over real
TLS and takes the deploy down with it when that fails. Deploy-before-certs is a
guaranteed failed deploy on a host whose `certbot-etc` volume was just deleted.

Then: `deploy.sh` → the five content seeds → `create-admin` → publish the legal
documents. `README.md` §"From zero to production" carries the commands.

`PAYETAM_VERSION` must be exported before **any** bare `compose.sh` call.
Destroying volumes and containers leaves the *images*, so this is the difference
between reusing `payetam/web:v0.4.2` and silently rebuilding a `:local` tag.

### Trap — the stack was healthy and the database was empty

All six containers reported healthy, `/health` returned `{"status":"ok"}`, and
`psql -c '\dt'` said **"Did not find any relations."** Migrations had never run.
The API's health check does not assert a schema, so nothing about the outside of
the system said so; the only evidence was in the worker's log, repeating
`The table public.event does not exist` every twenty seconds while its eleven
scheduled jobs burned through their retries.

The fix is `./scripts/migrate.sh`, and then **restart the worker** — it recovers
on its own but its retry backlog stays in the log, which matters for the next
trap.

### Trap — `grep -q` under `pipefail` fails *because* it succeeded

`smoke-tests.sh` checked the worker with

```bash
compose logs --tail 200 worker 2>/dev/null | grep -q 'Worker started'
```

`lib.sh` sets `set -euo pipefail`. `grep -q` exits at the **first** match and
closes the pipe; `docker compose logs` then dies on SIGPIPE (141); `pipefail`
takes the rightmost non-zero status, and the check reports failure. It fails
precisely when the line is found *early enough that compose is still writing* —
so it passed on a short log for every previous deploy and failed the moment the
crash-loop backlog above made the log long.

Fixed by capturing into a variable first (`worker_log="$(compose logs … || true)"`,
then `grep -q … <<< "$worker_log"`). The general rule: **never pipe into
`grep -q` in a `pipefail` script.** Use `grep -c`, or capture first.

This is the second failure in this repo whose whole symptom was a non-zero exit
with nothing printed — see §11 items 5 and 6. Both were shell plumbing, not code.

### Trap — the hand-written `policy_version` INSERT that cannot work

A suggested recovery step was to insert policy rows directly with columns
`title_en`, `body_fa`, `body_en` and integer ids. None of them exist:
`policy_version` has `content_md`, `title_fa`, `summary_fa`, an **Int** `version`,
a **uuid7 string** `id`, and `type` is the `policy_type` enum. `seed:policies`
writes the correct shape and the audit row the rail requires. Reach for the seed,
never a hand-written INSERT — the schema in someone's head is not the schema.

### What only a human can do

Three steps resist automation, two of them deliberately:

1. **The content seeds** demand a typed database name and refuse a non-TTY stdin.
   `ssh -tt` satisfies this honestly (it allocates a real pty); piping into a
   non-TTY does not, and is not meant to.
2. **`create-admin`** refuses `--password` as an argument and prints the TOTP
   secret exactly once. Running it inside an agent session would put a production
   password and its second factor in the same transcript, which is the whole
   thing 2FA exists to prevent.
3. **Walking the bot in Telegram** needs a Telegram client. Everything behind it
   is checkable — webhook registration, current policy count, worker relay — but
   the walk itself is not.

### The state this left

27/27 smoke checks. 4 roles, 25 permissions, 2 current policy versions, 31
provinces, 1252 cities (31 active), 14 categories, 25 interests, 8 blacklist
terms, 64 settings. `admin_user` and `user` at 0 — the first administrator is
created by hand, and `MONITORING_CHAT_ID` is still empty.

### Trap — the deploy workflow had never once succeeded

`gh run list --workflow=deploy.yml` on 2026-08-29: **seven runs, seven failures**,
every tag from v0.2.0 onward. Not a regression — it had never worked.

One step was responsible:

```yaml
- name: Validate the compose file
  run: docker compose -f docker/docker-compose.prod.yml config > /dev/null
```

Every service declares `env_file: ../.env`. `.env` is gitignored, so on a runner
it does not exist, and Compose treats a missing `env_file` as fatal *before* it
validates anything: `env file /home/runner/work/… not found`. CI writes
`.env.production.example` to `.env` for the length of the step instead —
placeholder values validate structure exactly as well as real ones.

Two things follow from this, and the second is the one that matters:

1. `deploy` has `needs: verify`, so **no tag has ever deployed from CI.** All
   seven releases were deployed by hand. The `environment: production` gate was
   never what protected production; the broken step was.
2. Fixing `verify` would have made the next tag push deploy on its own, for the
   first time ever, on the same commit that fixed it. Deploy is therefore now
   `if: github.event_name == 'workflow_dispatch'` — a tag push verifies and
   stops, and `notify` treats `skipped` as green rather than as failure.

### Trap — `docker compose config` prints the secrets after all

The compose file's header claimed `config` was "safe to run and safe to share",
reasoning that nothing uses `${VAR}` interpolation. That covers interpolation and
nothing else: **Compose v2 also inlines `env_file` contents into the
`environment:` block it prints.** Run on the server, `config` emits the database
password, the bot token and both JWT secrets to stdout.

`deploy.sh` and the CI check both redirect to `/dev/null`, so nothing leaked. The
comment was the hazard — it invited someone to run `config` and paste the output
into a bug report. Corrected in place.

The general shape, and it is the third time in this file: **a claim about a
tool's behaviour that was true when written and silently stopped being true.**
