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
Docker Compose, live in production at `v0.3.0`.

## 2. Read these, in this order

| Question | File |
|---|---|
| What exists today, every route/table/flow | `docs/project-review.md` (52 K) |
| The master plan, frozen decisions, milestones | `docs/implementation-plan.md` (174 K) |
| Why a decision is what it is | `docs/adr/` (17 ADRs, index in `README.md`) |
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
docker/    Dockerfiles, nginx vhosts, compose
docs/      plan, 17 ADRs, threat model, glossary, brand
test/      integration harness (real Postgres)
tools/     seeds, backup/restore, admin bootstrap
```

The load-bearing rule: **`packages/domain` holds all business logic and imports
no HTTP framework and no grammY.** `apps/api` and `apps/worker` are thin adapters
over the same services. That is what stops the bot and the Mini App from drifting
apart — treat it as an invariant, not a preference.

Scale: 51 Prisma models · 24 migrations · 15 API controllers · 42 domain services
· 19 domain modules · 15 Mini App views · 1151 unit/component tests.

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
| unit + miniapp + admin | **1151/1151** in 65 files (13 s) |
| **integration** (real Postgres) | **1313/1313** in 48 files (30 min) |
| **Docker production build** | api, worker, web all built |
| **nginx config validation** | syntax ok, test successful |

**2420 tests green in total.** The integration run's `ERROR`/`WARN` log lines are
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
8. **`ALTER TYPE … ADD VALUE` cannot run in a transaction** in Postgres, which is
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

## 10. The bot surface, and where it stops

The bot is **deliberately stateless**. `packages/telegram/src/update.ts` classifies
an update into five intents (`START`, `COMMAND`, `TEXT`, `EDITED_TEXT`,
`UNSUPPORTED`, plus `BLOCK_CHANGED`/`CALLBACK`), and `BotService` holds no per-user
conversation state at all. There is nowhere for a half-typed event to live — which
is exactly what makes a redelivered Telegram update idempotent.

`BotService` obeys three rules, all load-bearing:

1. **It calls the same domain services the Mini App calls.** No rule about who may
   accept a request lives in the bot. A rule enforced on one surface protects one
   surface.
2. **It never calls Telegram.** Every reply is a `notification` row plus an enqueue
   (invariant 11). A direct send would also bypass the global rate limiter.
3. **A reply is a row, not a fire-and-forget send** — deduped by a UNIQUE index on
   a key derived from Telegram's `update_id`.

The commands today are `/start`, `/help`, `/balance`, `/requests`, `/myevents`,
`/chats`.

**Adding a read-only command** (`feature/bot-commands`):

- add the key + render case in `packages/telegram/src/templates.ts`
- dispatch it in `BotService.onCommand`
- add it to `BOT_COMMANDS` in `packages/telegram/src/commands.ts` — that is what
  `/help` renders from *and* what Telegram's menu is published from, and
  `commands.test.ts` fails if the list advertises something the switch does not
  dispatch
- run `pnpm set-bot-commands` against the bot afterwards, or the menu keeps
  advertising the old list
- `update.ts` needs **no change** — it already parses any `/command` into
  `{ kind: 'COMMAND', command }`
- test through the webhook, not against the service: what matters is the one
  deduped notification row, and a service-level test asserts the call instead
- the totality test over `Object.values(TEMPLATES)` in `escape.test.ts` picks up
  new templates automatically

**Persian status labels are per-perspective, not per-enum.**
`PARTICIPANT_STATUS_GUEST_FA` and `PARTICIPANT_STATUS_HOST_FA` in
`@payetam/shared` describe the *same nine statuses* differently, because the
difference is «شما»: `PENDING` is «در انتظار پاسخ میزبان» to the requester and
«در انتظار پاسخ شما» to the host; `CANCELLED_BY_HOST` is «میزبان لغو کرد» to one
and «شما لغو کردید» to the other. Seven of the nine differ. **Do not collapse
them** — it looks like duplication and is not. `EVENT_STATUS_FA` is one map,
because an event's status is a fact about the event rather than a relationship
between two people.

**Deep links.** Every «باز کردن برنامه» button is
`https://t.me/<bot>?startapp=<target>`, built by `openAppButton`, which encodes
`/` as `_` because Telegram allows no slash. The Mini App reads it back in
`deepLinkTarget()` (`apps/miniapp/src/telegram/webapp.ts`) against a **fixed
allowlist** — the payload is attacker-supplied, so a path would let a stranger
choose which screen somebody else's app opens on. Adding a template with a new
target means adding it to `DEEP_LINKS` too, or the button silently lands on the
splash — which is what every one of them did until 2026-08-28.

**Where the bot stops.** Single-turn, read-mostly work belongs in the bot; anything
with a form belongs in the Mini App, and `/help` says so rather than failing
silently. The form-heavy views are not stylistic preferences — `CreateEventView`
alone is 16 fields with three dependent selects (province → city → district over
1252 cities), two datetimes, and conditional validation (`costAmount` required for
FIXED/APPROX and forbidden for FREE/SPLIT; `maxAge >= minAge`). Expressing that as
a conversation means inventing a persisted multi-step wizard, which is a new
architecture, not a refactor — and ADR-0003 froze the Vue + Telegram Design System
choice.

## 11. Open operational items

From `.claude-work-checkpoint.md` §2 — none blocking, all worth knowing:

1. `MONITORING_CHAT_ID` is empty in production — alerts log to the container only.
2. Backups are **plaintext and single-host**. `PAYETAM_BACKUP_GPG_RECIPIENT` and
   `PAYETAM_BACKUP_REMOTE` unset. `DEPLOYMENT.md` §10 has the steps; do this
   before real users exist.
3. Pushing a release tag may trigger `.github/workflows/deploy.yml`, whose
   `deploy` job sits behind `environment: production`.
