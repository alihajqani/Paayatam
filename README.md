# پایه‌تَم — PayeTam

A two-sided marketplace on Telegram that connects people for shared activities — café and board games,
light outdoor activities, sports, learning. Launching in Tehran.

Three surfaces over one backend:

- **Mini App** — discover, filter and create activities; profile, coins, Trust Score.
- **Bot** — onboarding, notifications, participation requests, and **anonymous chat** before identities are
  exchanged.
- **Channel** — VIP, boosted and trending activities.

Plus an **Admin Panel** for moderation, the economy, and audit.

---

## Status

**Milestone 22 complete — v0.3.0, product and admin upgrades.**

A user can now **edit their profile** after onboarding rather than living with
what they typed the first time, and support can correct one on their behalf
behind `user.profile.edit`, with every field change audited.

The panel can **send a Telegram message** — to one person, or as a broadcast to a
filtered slice. Nothing sends until a preview has been run and the recipient count
typed back; delivery is the worker's, rate-limited, resumable, and unable to send
twice to the same person. See [`docs/admin-panel.md`](docs/admin-panel.md) §9.

**Three actions now cost coins**: creating an event is 5, sending it to the
channel is 15, and inviting the twenty people most likely to come is 10. Every
charge is atomic with the act it pays for, idempotent under retry, and refunded
when the act it paid for could not happen.

**Terms, privacy and rules are versioned.** A published version is immutable, one
version per type is current, and publishing asks every user to re-accept before
they can act again. Acceptance is append-only by database trigger.

**Provinces and cities are managed from the panel** — created, renamed, reordered
and deactivated, never deleted, because profiles and events point at them.

**Membership in several channels can be required**, configurably and per action,
in an order the operator sets. A user must be in *every* active channel — joining
one of three is not enough — and the gate fails open on every outcome except an
authoritative refusal from Telegram, so an outage or one misconfigured channel
degrades the gate rather than the product. It is **off by default.** The widest
action, `APP_ACCESS`, replaces the whole Mini App with the join screen; it is
enforced by the router rather than by `AuthGuard`, because a gate over every
authenticated route would refuse the very calls the screen that clears it is
built from.

The worker now **goes looking for failures** rather than only reacting to them:
a nightly ledger-drift sweep and an outbox-staleness check alert a separate
Telegram group, redacted, throttled, and behind a kill switch.

And the Mini App **has a face**: a mark derived from the logo, a palette sampled
from it, a header that is also the way home, the balance on the home screen, and a
version string on both surfaces that matches the release actually deployed. See
[`docs/brand.md`](docs/brand.md) and [`docs/performance.md`](docs/performance.md).

**Milestone 19 complete — both launch blockers closed.** The admin panel exists (`apps/admin`, twelve
screens over the API M12 built), and the two-account privacy gate has been executed and automated.
See [`docs/admin-panel.md`](docs/admin-panel.md) and
[`docs/b4-privacy-gate.md`](docs/b4-privacy-gate.md).

M19 also gave gift codes campaigns, bulk minting and per-code analytics — and reclassified a code as
a **bearer secret** ([ADR-0016](docs/adr/0016-gift-code-campaigns-and-admin-panel.md)): reads mask
it, every route addresses it by `public_id`, and the plaintext is returned exactly once. The
`ChatsView` privacy copy that had been wrong since M6 is rewritten, and
`referral.status = REJECTED` — an enum value nothing wrote — is wired as an administrative act.

**Milestone 18 complete** — the repo boots (M1), a Telegram user can sign in and accept the terms (M2),
complete a profile from the Mini App and receive the onboarding coins exactly once (M3), create events
that pass through Persian auto-moderation before publishing (M4), browse, filter and search what
everyone else has published (M5), ask to join one — with seats allocated under a row lock that makes
overbooking impossible (M6) — be promoted off the waitlist in FIFO order when a seat frees (M7), and
talk to the other party anonymously from the moment they ask (M8).

A chat exists from the request, not from the acceptance: two strangers negotiate a meeting before either
knows who the other is. Message bodies are AES-256-GCM at rest, aliases («میهمان ۱») are a property of
the chat rather than of the person in it, every Telegram message entity is dropped, and phone numbers,
`@usernames`, `t.me/` links and emails are masked until the sender has explicitly consented to share
them. The CI response-leak scan covers the chat endpoints alongside every other one.

Domain events are written to a transactional outbox as they happen, and the relay turns them into
Telegram notifications (M13) with the worker as the only thing in the product that calls Telegram.

**The bot is now two-way.** `/start` creates the account, the host accepts or rejects from a button in
the notification itself, and a message typed to the bot is relayed into the conversation it belongs to —
resolved by which message it replies to, or by the sender having exactly one live chat, and refused with
an explanation when neither answers. Edits follow. Blocking is detected. M8's two-real-accounts release
gate was therefore *performable* for the first time — and **was performed in M19**.

**The core loop is now usable from the Mini App.** A host writes an event, a stranger finds it, opens it
and asks to join; the host accepts or rejects — from the notification or from the participant list — and
the conversation the request opened continues in Telegram, which is where chat lives by design. Discovery
carries the twelve filters the API exposes, cancellation is priced by the dry-run endpoints before it is
committed, and every screen renders Jalali dates from UTC without a date library.

Sharing contact details takes an explicit confirmation that says plainly what it does and does not do;
reviews are written blind and revealed together at T+24h; coins, Trust Score and invitations each show their
ledger rather than only a number; and anything can be reported from where it is being looked at.
`Idempotency-Key` is built, so boosting an event cannot double-charge a host whose connection dropped.

**Reputation now reaches the screens where somebody decides** (M18). A guest sees the host's Trust Score
before asking to join; a host sees each requester's before answering. Both are `null` — «تازه‌وارد» — for an
account nobody has judged yet, because rendering that as zero would be a claim about a person that is not
true. A conversation is titled «نام — عنوان رویداد» rather than «میهمان ۱», in the Mini App and in the bot,
which is what makes a Telegram thread carrying four conversations readable;
[ADR-0014](docs/adr/0014-conversation-titles-and-reputation-display.md) records why that amends the
anonymity boundary and what it costs. **Gift codes** grant coins through the same ledger everything else
moves through, with the global cap, the per-user limit and the exactly-once guarantee each enforced by a
different database constraint
([ADR-0015](docs/adr/0015-gift-codes.md)) — and the referral programme, complete on the backend since M9,
finally has the screen to share a code and see what it has earned.

Still not built: the **admin panel**, which is what makes a report actionable by a human — and, since M18,
what makes minting a gift code something other than a `curl` session.

New here? [`docs/project-review.md`](docs/project-review.md) is a complete survey of what exists: every
module, route, table and flow, and an honest list of what is unfinished.

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the full plan and milestone
sequence, and [`docs/launch-readiness.md`](docs/launch-readiness.md) for what is and is not ready —
including two delivery bugs that sat behind a green test suite for four milestones.

---

## Start here

| Document | What it is |
|---|---|
| [`docs/project-review.md`](docs/project-review.md) | **What exists today.** Architecture, folders, every route and table, the flows end to end, and what is incomplete |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | **The master plan.** Frozen decisions, data model, state machines, milestones, acceptance criteria. Read this first |
| [`docs/adr/`](docs/adr/README.md) | Architecture Decision Records — one decision each, with what was rejected and why |
| [`docs/threat-model.md`](docs/threat-model.md) | Assets, adversaries, controls, and **explicitly accepted risks** |
| [`docs/activities-and-places.md`](docs/activities-and-places.md) | **Adding an activity tag or a city.** Panel vs. seed file, slug rules, the «سایر» flag |
| [`docs/glossary-fa.md`](docs/glossary-fa.md) | Persian ↔ English terms, error messages, typography rules |
| [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md) §10 | **The bot's conversation wizards** — how a multi-step form works, and the five things that are load-bearing |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | **Putting it on a server.** Step by step, from a bare VPS to a verified deploy |
| [`SECURITY.md`](SECURITY.md) | What the production stack exposes, what protects it, and what is accepted |

**Working on this project?** Read the plan and the ADR index before changing architecture. Decisions recorded
there are frozen; changing one means a new ADR and an update to the plan, not an edit in passing.

---

## Stack

| Layer | Choice | ADR |
|---|---|---|
| Backend | TypeScript modular monolith — NestJS | [0001](docs/adr/0001-modular-monolith-and-deployment.md) |
| Database | PostgreSQL 16 + Prisma | [0002](docs/adr/0002-postgresql-and-prisma.md) |
| Queue / cache | Redis 7 + BullMQ | [0005](docs/adr/0005-transactional-outbox-and-jobs.md) |
| Bot | grammY, webhook mode | [0004](docs/adr/0004-telegram-webhook-and-miniapp-auth.md) |
| Frontends | Vue 3 + Vite + Pinia + Tailwind | [0003](docs/adr/0003-vue-frontend-and-telegram-design-system.md) |
| Mini App design | Telegram Native Design System, RTL-first fa-IR | [0003](docs/adr/0003-vue-frontend-and-telegram-design-system.md) |
| Deployment | Single VPS, Docker Compose | [0001](docs/adr/0001-modular-monolith-and-deployment.md) |

```
apps/     api · worker · miniapp · admin
packages/ db · domain · platform · telegram · shared · config
docker/   Dockerfiles, nginx, compose
docs/     plan, ADRs, threat model, glossary
test/     integration harness (real Postgres)
tools/    seeds, anonymization, backup/restore
```

`packages/domain` holds all business logic and imports no HTTP framework and no grammY. `apps/api` and
`apps/worker` are thin adapters over the same services — which is why the bot and the Mini App cannot drift
apart.

---

## The twelve invariants

These are the properties the architecture exists to guarantee. Violating one is a bug regardless of what a
test says. Full list with rationale in [`docs/adr/README.md`](docs/adr/README.md).

1. `accepted_count <= capacity` — DB CHECK **and** row lock.
2. `coin_account.balance >= 0` — DB CHECK.
3. Coin and trust ledgers are append-only — trigger-enforced.
4. One participation row per `(event, user)` — DB UNIQUE.
5. One report per `(target, reporter)` — DB UNIQUE.
6. One review per `(participation, reviewer)` — DB UNIQUE.
7. `telegram_user_id` never appears in an API response, a log line, or a frontend bundle.
8. No review is readable by the counterparty before reveal — enforced at the **API layer**.
9. All policy timing uses the server clock; no endpoint accepts a client timestamp.
10. Every state transition goes through `assertTransition()` and writes `audit_log`.
11. Every outbound Telegram call goes through the queue, never inline in a request.
12. Every mutating admin action is authorised **in the service layer** and audited.

---

## Local Development

One command brings up the whole stack:

```bash
make dev
```

That is Postgres, Redis, the Prisma client, the migrations, the TypeScript watch build, the API, the
worker and the Mini App — started in dependency order, each in the background with its own log, and
each skipped if it is already running. It is safe to run twice.

There is **no separate bot process**: inbound Telegram is a webhook served by the API, and every
outbound message is the worker draining the queue (ADR-0004, ADR-0005).

### 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node ≥ 22.12 | `node --version`. The dev loop uses `node --watch` and `--env-file`. |
| pnpm 10.30 | `corepack enable && corepack prepare pnpm@10.30.0 --activate` |
| Docker + Compose v2 | Postgres and Redis only; the app processes run on the host |
| Linux or WSL2 | `make dev` uses `setsid`, `ss` and `/proc` for process supervision |
| `cloudflared` | Only for `make tunnel` — [install](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |

### 2. Install and configure

```bash
make setup     # pnpm install, and writes .env with freshly generated local secrets
```

`make setup` copies `.env.example` to `.env` and generates `CHAT_ENCRYPTION_KEY`, `PII_HASH_PEPPER`,
both JWT secrets and both Telegram webhook secrets. It never overwrites an existing `.env`.

Every variable is validated at boot by `packages/config`, and **the process refuses to start if one is
missing or malformed** — deliberately, because a half-configured service that boots is worse than one
that does not.

What matters locally:

| Variable | Needed for | Value |
|---|---|---|
| `DATABASE_URL` | everything | matches `docker-compose.yml`: port **55432** |
| `REDIS_URL` | everything | port **56379** |
| `API_PORT` | the API | `3000` |
| `TELEGRAM_BOT_TOKEN` | anything Telegram | from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_BOT_USERNAME` | channel deep links | your bot's username, without `@` |
| `TELEGRAM_MODE` | the bot | `webhook` for tunnel testing (`polling` is refused in production) |
| `TELEGRAM_WEBHOOK_SECRET_PATH` / `_TOKEN` | the webhook | generated by `make setup`; both are checked in constant time |
| `TELEGRAM_CHANNEL_ID` | VIP/BOOST/trending posts | see [Telegram channel](#telegram-channel) |
| `TEST_DATABASE_URL` | integration tests | see [Tests](#tests) |

The Telegram variables are optional until you need them: the API, the worker and the Mini App all start
without a bot token.

### 3. Start the stack

```bash
make dev
```

In order, that:

1. runs `pnpm install` if `node_modules` is missing;
2. `docker compose up -d` and waits for **postgres** and **redis** to report *healthy*;
3. `pnpm db:generate` — the Prisma client is generated, never committed;
4. `pnpm db:migrate:deploy` — applies migrations;
5. `pnpm exec tsc -b` — builds the project graph once, so there is compiled output to run;
6. starts `pnpm exec tsc -b --watch --preserveWatchOutput`, the API, the worker, the Mini App and the
   admin panel;
7. waits for `/health`, `/ready`, the Mini App, the admin panel and the worker's startup line, then
   prints the status.

First run on a cold machine takes about half a minute; afterwards `make dev` is a few seconds because
everything it would start is already up.

A database with no reference data will render an empty Mini App. Once, after the first `make dev`:

```bash
make seed      # policies, catalog (cities, districts, categories, interests), blacklist,
               # RBAC, settings, and a few demo events
```

**`make seed` writes no gift codes**, deliberately: a code that grants coins is a campaign somebody
decided to run, not reference data — and a valuable code committed to a repository is a code
everybody who ever cloned it holds. Campaigns are minted from the panel (`/gift-codes`).

For local work there is a separate command, gated by an **allowlist** of environments rather than a
"not production" check, with no `ALLOW_PROD_SEED` escape hatch:

```bash
make seed-gift-codes-dev    # DEV/TEST only — six named fixtures, one per redemption outcome,
                            # plus a fresh batch of 25. Refuses under any other NODE_ENV.
```

### 4. Day-to-day

| Command | What it does |
|---|---|
| `make dev` | start everything that is not already running |
| `make stop` | stop **only** the processes `make dev` started (containers stay up) |
| `make restart` | `stop`, then `dev` |
| `make status` | containers, processes, ports, `/health`, `/ready`, tunnel URLs |
| `make logs` | follow every service's log; `make logs SERVICE=api` follows one |
| `make down` | stop Postgres and Redis (data is preserved) |
| `make ps` / `make docker-logs` | the containers, directly |

PIDs, logs and tunnel URLs live in `.dev/`, which is git-ignored. `make stop` signals the process
*group* of each PID it recorded — so `node --watch` and its child both go — and it refuses to signal a
PID that is no longer the process it started, which is what makes a stale PID file harmless.

Two safeguards worth knowing about, because they print a warning rather than doing something:

- **A port already in use is never taken over.** If something else holds 3000 or 5173, that service is
  not started and `make status` names the PID holding the port.
- **A matching process `make` did not start is left alone.** An ad-hoc `pnpm dev` in another terminal,
  or a worker orphaned by a deleted PID file, is reported instead of duplicated — two workers on the
  same queues would process every job twice.

`make dev` runs everything in the background. The old single-terminal loop is still there as
`make dev-single-shell` (`pnpm dev`).

### 5. Verifying it is up

```bash
make status
```

```bash
curl localhost:3000/health   # {"status":"ok","uptimeSeconds":…}
curl localhost:3000/ready    # {"ready":true,"checks":{"database":"up","redis":"up"}}
curl -I localhost:5173       # 200 — the Mini App
curl -I localhost:5174       # 200 — the admin panel
```

`/ready` is the database and Redis check: it answers `{"database":"up","redis":"up"}` only if both
respond. For the worker — which serves no port — look for its startup line:

```bash
grep "Worker started" .dev/logs/worker.log
make logs SERVICE=worker
```

And the database directly:

```bash
docker compose exec postgres psql -U payetam -d payetam -c '\dt' | head
pnpm db:studio                      # Prisma Studio, if you prefer a browser
```

### 6. Working on the Mini App

The Mini App runs at `localhost:5173` and proxies `/api` to the API, so nothing hardcodes an origin.
Two modes:

```bash
make dev                          # MINIAPP_MODE=dev (default) — Vite dev server, HMR
make dev MINIAPP_MODE=preview     # vite build --watch + vite preview — the real bundle
```

`dev` is what you want while writing components. `preview` is what Telegram must be given: the dev
server ships every module as its own request, which is fine over localhost and unusable on a phone
through a tunnel. `make tunnel` switches to `preview` on its own.

**It only authenticates inside Telegram.** Sign-in is Telegram's `initData`, and a plain browser tab
has none — so the screens render, and anything that calls the API answers `UNAUTHENTICATED`. Real
sign-in needs the tunnel below.

### 7. Working on the admin panel

The panel runs at `localhost:5174` and proxies `/admin` to the API.

**That proxy is a requirement, not a convenience.** The staff session is an `HttpOnly` cookie scoped
to `/admin` and the API sets no CORS headers, so the panel and the API have to be the same origin —
a cross-origin panel is signed out on every request with no useful error to read. In production nginx
serves the bundle and proxies `/admin/v1`; see [`docs/admin-panel.md`](docs/admin-panel.md) §8.

The cookie is `Secure`. Browsers treat `localhost` and `127.0.0.1` as trustworthy, so it works in
development — but not over plain HTTP to a LAN address. Use `https` anywhere that is not loopback.

**Signing in needs a staff account**, and there is no self-service sign-up: `admin_user` has no
foreign key to `user`, and that separation is the security control. Run `pnpm seed:rbac` first (roles
and permissions, from the code catalogue), then create an account through
`AdminAccessService.createAdmin`, which returns the TOTP secret **once**. `docs/admin-panel.md` §1 is
the procedure.

The panel is deliberately **not** tunnelled by `make tunnel`: it is opened by a person at a desk and
has no reason to be publicly reachable.

### 8. Testing inside Telegram

```bash
make dev
make tunnel
```

`make tunnel` switches the Mini App to preview mode if it is not there already, opens two Cloudflare
quick tunnels — one to the API on 3000, one to the Mini App on 5173 — and prints both URLs. Then:

```bash
make webhook        # points the bot's webhook at the API tunnel
make webhook-info   # what Telegram thinks the webhook is, and any delivery error
```

`make webhook` reads `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_PATH` and
`TELEGRAM_WEBHOOK_SECRET_TOKEN` from `.env` at the moment it runs; nothing is stored anywhere else, and
`setWebhook` subscribes to exactly the four update types the bot parses.

It waits for the tunnel to answer publicly before it registers anything, because Telegram resolves the
hostname itself and **a failed `setWebhook` clears the webhook the bot already had**. A brand-new
quick-tunnel hostname can take a minute to reach Telegram's resolver; if `make webhook` gives up
anyway, the hostname is usually stuck in a negative cache — `make tunnel-stop && make tunnel` for a
fresh one, then `make webhook` again.

In [@BotFather](https://t.me/BotFather), once per tunnel:

- `/mybots` → your bot → **Bot Settings → Menu Button** (or **Configure Mini App**) → paste the
  **miniapp** tunnel URL, e.g. `https://<random-words>.trycloudflare.com`.
- `/setdomain`, if you also use a Login Widget, takes the same host.

Then open the bot in Telegram, send `/start`, and tap the menu button.

**Quick-tunnel hostnames change every time cloudflared restarts**, so after `make restart` (or
`make tunnel-stop && make tunnel`) re-run `make webhook` and paste the new Mini App URL into BotFather.
`make tunnel-stop` closes the tunnels and leaves the rest of the stack running; `make webhook-delete`
un-registers the webhook when you are finished.

`vite.config.ts` already allows `*.trycloudflare.com`, `*.ngrok-free.app` and `*.ngrok.app` as hosts —
Vite rejects an unrecognised `Host` header, and a tunnel is exactly what that defence looks like.

<a id="telegram-channel"></a>
### 9. The Telegram channel

VIP, boosted and trending events are posted to a channel (M14) by the worker. Two things must be true:

- **`TELEGRAM_CHANNEL_ID`** — for a **public** channel this is simply its `@channelusername`
  (e.g. `TELEGRAM_CHANNEL_ID=@payetam`). A private channel has no username, so it is the numeric id
  instead, which looks like `-1001234567890`.
- **The bot must be an administrator of that channel**, with **Post Messages** and **Delete Messages**.
  Posting needs the first; taking a finished or cancelled post down needs the second.

Neither is checked at boot, because neither is required to run. When they are wrong the worker retries
and, after three consecutive failed sweeps, logs
`Channel publishing has failed N sweeps in a row … Check that TELEGRAM_CHANNEL_ID is set and the bot is
an administrator of that channel.` If the channel is not working, that line is where to look first.

<a id="tests"></a>
### 10. Checks and tests

```bash
make typecheck      # tsc -b across the workspace, then vue-tsc for the Mini App
make lint
make format-check
make test           # Vitest: unit, miniapp (jsdom), admin (jsdom) and integration
make test-int       # the integration project alone — real Postgres
make check          # typecheck + lint + test — the three gates CI runs
make build
```

**Integration tests TRUNCATE every table before each test.** Run `make db-test` once to create a
separate `payetam_test` database and set `TEST_DATABASE_URL` in `.env`, or the suite will empty your
development data instead.

Nothing transactional is ever mocked. Capacity, ledger and waitlist tests run against a real database,
because the guarantees they check are database guarantees.

### 11. Ports, and when something is already using one

| Port | What |
|---|---|
| 3000 | API (`API_PORT`) — `/health`, `/ready`, `/metrics`, `/telegram/webhook/:secret` |
| 5173 | Mini App (dev server or preview) |
| 5174 | Admin panel (`ADMIN_PORT`) — proxies `/admin` to the API |
| 55432 | Postgres, bound to `127.0.0.1` |
| 56379 | Redis, bound to `127.0.0.1` |

The database ports are deliberately not 5432/6379, so this stack cannot collide with another one on
your machine.

If `make dev` reports a port in use, `make status` names the PID. If it is a leftover of a previous
session that `make` no longer tracks, stop that PID yourself and run `make dev` again — `make stop`
will not touch a process it did not start.

**Do not run the Nest apps under `tsx`.** esbuild does not emit `emitDecoratorMetadata`, so dependency
injection silently yields `undefined` and the app fails at request time rather than at startup. See
[ADR-0013](docs/adr/0013-typescript-build-and-dev-loop.md).

---

## The bot

Nine read-only commands and two conversation wizards. The list lives in
`packages/telegram/src/commands.ts` and is the single source for Telegram's menu,
for `/help`, and for the test that keeps both honest.

| Command | What it does |
|---|---|
| `/start` | Creates the account. The only command that may. Takes a referral code |
| `/help` | What the bot can do, and what still needs the app |
| `/discover` | Activities in your city, from your profile — no arguments |
| `/balance` | Coin balance |
| `/requests` | What you have asked to join, and where each stands |
| `/myevents` | What you are hosting, and how full each is |
| `/chats` | Which conversations are open, and who is waiting |
| `/reviews` | Reviews you still owe, and when they expire |
| `/profile` | Your profile — and the only place your own Trust Score is shown |
| `/terms` | The policies — the gate if you owe one, what you signed if you don't |
| `/create_event` | **Wizard.** Builds a full event in the chat (ADR-0017) |
| `/edit_event` | **Wizard.** Changes an event you host |
| `/edit_profile` | **Wizard.** Changes any part of your profile |
| `/cancel` | Closes an open wizard |

Every write goes through the consent gate first. A user who owes a policy
acceptance gets the gate *where the action would have happened*, one button from
being able to continue — the bot never simply refuses.

### Publishing the command menu

```bash
pnpm set-bot-commands            # publish what BOT_COMMANDS says
pnpm set-bot-commands --info     # read back what Telegram has
```

Once per bot, and again whenever `BOT_COMMANDS` changes. Not a per-deploy step —
the list is global to the token, so two environments sharing one would overwrite
each other on every restart. See `DEPLOYMENT.md` §12.

### Testing a wizard by hand

```bash
make dev            # the whole stack
make tunnel         # a public URL for the webhook
make webhook        # point Telegram at it
```

Then message the bot. A wizard lives on **one message that is edited in place**,
so watch that message change rather than expecting new ones. If it stops
updating, the likely cause is the `telegram-send` queue rather than the wizard:
check the worker's log for `BOT_EDIT_MESSAGE`.

`/cancel` clears a stuck form. So does starting another one — `/create_event`
replaces whatever was in progress rather than refusing.

**A draft lives seven days** and is swept at 04:15 Tehran. To see one, look at
`conversation_state`; the form itself is encrypted, so `step` and `updated_at`
are what is readable without the key.

---

## Production

Everything runs in Docker Compose on one VPS. [`DEPLOYMENT.md`](DEPLOYMENT.md) is
the step-by-step guide; this is the shape of it.

### The topology

```
                        internet
                            │
                    :80 ────┴──── :443
                            │
                    ┌───────────────┐        the only published ports
                    │     nginx     │        TLS, static bundles, proxy
                    └───────┬───────┘
        app.paayatam.online     │     admin.paayatam.online
        /            /api/  │  /admin/v1/         /
    miniapp bundle ─────────┼───────────── admin bundle
                            │  frontend network
                    ┌───────┴───────┐
                    │      api      │  NestJS on Fastify, uid 1000, read-only fs
                    └───────┬───────┘
                            │  internal network
              ┌─────────────┼─────────────┐
        ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴──────┐
        │ postgres  │ │   redis   │ │   worker   │──→ api.telegram.org
        │    16     │ │     7     │ │   BullMQ   │
        └───────────┘ └───────────┘ └────────────┘
```

Postgres, Redis, the API and the worker publish **no host port**. The worker is
the only process that talks to Telegram (invariant 11).

**Both SPAs must share an origin with the API, and this is forced by the code
rather than chosen.** The API sends no CORS headers, both clients build relative
paths, and the admin session cookie is `Secure`, `SameSite=Lax`, host-only and
scoped to `/admin`. A separate `api.paayatam.online` would fail every request in the
browser. So `app.paayatam.online` serves the Mini App *and* proxies `/api/` and
`/telegram/webhook/`; `admin.paayatam.online` serves the panel *and* proxies
`/admin/v1/`.

### The files

| Path | What |
|---|---|
| `docker/Dockerfile` | Multi-stage. Targets: `api`, `worker`, `web` (nginx + both bundles), `tools` (migrations and seeds) |
| `docker/docker-compose.prod.yml` | The whole stack. Standalone — it does not extend the development `docker-compose.yml` |
| `docker/nginx.conf`, `sites-available/`, `snippets/` | TLS, both origins, the closed endpoints |
| `.env.production.example` | Every variable, with the command that generates each secret |
| `scripts/` | Deploy, rollback, migrate, backup, restore, smoke tests |

### The commands

```bash
./scripts/check-env.sh                              # before anything: is .env sane?
./scripts/init-letsencrypt.sh --email you@…         # once, after DNS resolves
./scripts/deploy.sh v0.2.0                          # build, migrate, start, verify
./scripts/rollback.sh                               # back to the previous tag
./scripts/smoke-tests.sh                            # 24 assertions against what is running
./scripts/backup.sh                                 # dump, verify, encrypt, copy off-host
./scripts/restore-rehearsal.sh                      # prove the backup restores
./scripts/set-webhook.sh --info                     # what Telegram thinks the webhook is
./scripts/compose.sh logs -f api worker             # docker compose, from anywhere
```

`scripts/compose.sh` exists because Compose resolves `env_file` and relative
volume paths against the compose file's own directory, so a bare
`docker compose -f docker/…` behaves differently depending on where you ran it.

### Generating the secrets

```bash
openssl rand -hex 24      # TELEGRAM_WEBHOOK_SECRET_PATH
openssl rand -hex 32      # TELEGRAM_WEBHOOK_SECRET_TOKEN
openssl rand -base64 32   # CHAT_ENCRYPTION_KEY
openssl rand -base64 32   # PII_HASH_PEPPER
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 24   # REDIS_PASSWORD
```

`POSTGRES_PASSWORD` and `REDIS_PASSWORD` each appear **twice** in `.env` — once on
their own line and once inside the matching URL. Neither Compose's `env_file` nor
Node's `--env-file` expands `${…}`, so they really are two copies;
`scripts/check-env.sh` is what keeps them equal.

### Backup, restore, rollback

- **Backup** wraps the existing `tools/backup.sh` — custom format, verified with
  `pg_restore --list`, rotated only after that verification passes — then encrypts
  to a GPG public key whose private half is deliberately *not* on the server, and
  copies off-host. 14-day retention.
- **Restore** stops the writers, dumps the state it is about to discard, restores
  into a *new* database and renames it into place, then checks the table count,
  the `coin_ledger` append-only triggers and the ledger reconciliation before
  letting the API near it.
- **Rollback** rebuilds the previous tag and restarts. Because the bundles are
  baked into the nginx image, the frontend goes back too. It does **not** undo
  migrations — the script counts what was applied since the target and makes you
  read them before continuing.

### Monitoring

The worker posts to a Telegram group (`MONITORING_CHAT_ID`). Five things reach
it, and nothing else does:

| Alert | Raised when |
| --- | --- |
| `job-exhausted:<queue>:<job>` | A job used its last retry |
| `job-failure-write` | The failed-job record itself could not be written |
| `campaign-paused:<id>` | A campaign was rate-limited three times running and paused itself |
| `ledger.drift` | A coin balance disagrees with its ledger (nightly sweep) |
| `outbox.stale` | The oldest undelivered outbox row is over fifteen minutes old |

The first three are reactions to something that already went wrong. The last two
go looking, because both failures are **silent**: nobody complains about a
notification they were never told existed, and a drifted balance surfaces weeks
later as a user disputing it. Both sweeps are read-only — a drift is reported,
never "corrected", since the two available corrections are overwriting a balance
somebody is holding and writing a plug entry into an append-only ledger.

Every alert carries `severity`, `service`, `env`, a stable code and a UTC
timestamp, and none carries a user id, a phone number or a message body. Alerts
are throttled per key with the suppressed count carried forward, and a global
budget caps the whole channel per window, so a queue failing every job produces
one message rather than a flood that gets the bot rate-limited.
`MONITORING_ENABLED=0` silences delivery without clearing the chat id; either way
the same lines go to the container log, so turning alerting off loses delivery
rather than information. `scripts/notify-telegram.sh` uses the same group for
failed backups, deploys and rollbacks.

Everything else is structured JSON on stdout, capped at 10 MB × 5 files per
service, plus Prometheus metrics at `/metrics` — reachable only from inside the
compose network.

### One conflict with the deployment TODO

`docs/production-deployment-todo.md` — a local working document, deliberately not
tracked — lists `TRUST_PROXY` among the variables that "do not exist in the code
and must not be added". It was accurate when written, and this milestone
overrules it: the variable did not exist, and the deployment it describes needs
it. Behind any reverse proxy — nginx in Docker, or nginx on the host in front of
systemd — Fastify reports the proxy's address as `request.ip`, so every IP
rate-limit bucket is shared by the whole internet, every `ip_hash` in `audit_log`
is identical, and `/metrics`' private-address check passes for everyone. See
[`SECURITY.md`](SECURITY.md) §3.

---

## Security

- **Never commit secrets.** `.env*` is git-ignored; `.env.example` and
  `.env.production.example` hold placeholders only.
- Report a vulnerability privately to the maintainers, not in a public issue.
- Read [`docs/threat-model.md`](docs/threat-model.md) before touching authentication, chat, the economy, or
  the admin panel, and [`SECURITY.md`](SECURITY.md) before changing anything about the
  deployment — it carries the accepted risks and the secret-rotation table.

**Stated honestly:** chat messages are encrypted at rest with a key the application server holds. That
protects database dumps, backups and a stolen disk. It is **not** end-to-end encryption and does not protect
against a compromised server. Do not describe it otherwise to users.

---

## License

Proprietary. All rights reserved.
