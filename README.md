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

**Milestone 8 complete** — the repo boots (M1), a Telegram user can sign in and accept the terms (M2),
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
gate is therefore *performable* for the first time, and has not been performed.

**The core loop is now usable from the Mini App.** A host writes an event, a stranger finds it, opens it
and asks to join; the host accepts or rejects — from the notification or from the participant list — and
the conversation the request opened continues in Telegram, which is where chat lives by design. Discovery
carries the twelve filters the API exposes, cancellation is priced by the dry-run endpoints before it is
committed, and every screen renders Jalali dates from UTC without a date library.

Sharing contact details takes an explicit confirmation that says plainly what it does and does not do;
reviews are written blind and revealed together at T+24h; coins, Trust Score and invitations each show their
ledger rather than only a number; and anything can be reported from where it is being looked at.
`Idempotency-Key` is built, so boosting an event cannot double-charge a host whose connection dropped.

Still not built: the **admin panel**, which is what makes a report actionable by a human.

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the full plan and milestone
sequence, and [`docs/launch-readiness.md`](docs/launch-readiness.md) for what is and is not ready —
including two delivery bugs that sat behind a green test suite for four milestones.

---

## Start here

| Document | What it is |
|---|---|
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | **The master plan.** Frozen decisions, data model, state machines, milestones, acceptance criteria. Read this first |
| [`docs/adr/`](docs/adr/README.md) | Architecture Decision Records — one decision each, with what was rejected and why |
| [`docs/threat-model.md`](docs/threat-model.md) | Assets, adversaries, controls, and **explicitly accepted risks** |
| [`docs/glossary-fa.md`](docs/glossary-fa.md) | Persian ↔ English terms, error messages, typography rules |

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
6. starts `pnpm exec tsc -b --watch --preserveWatchOutput`, the API, the worker and the Mini App;
7. waits for `/health`, `/ready`, the Mini App and the worker's startup line, then prints the status.

First run on a cold machine takes about half a minute; afterwards `make dev` is a few seconds because
everything it would start is already up.

A database with no reference data will render an empty Mini App. Once, after the first `make dev`:

```bash
make seed      # policies, catalog (cities, districts, categories, interests), blacklist,
               # RBAC, settings, and a few demo events
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

### 7. Testing inside Telegram

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
### 8. The Telegram channel

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
### 9. Checks and tests

```bash
make typecheck      # tsc -b across the workspace, then vue-tsc for the Mini App
make lint
make format-check
make test           # Vitest: unit, miniapp (jsdom) and integration
make test-int       # the integration project alone — real Postgres
make check          # typecheck + lint + test — the three gates CI runs
make build
```

**Integration tests TRUNCATE every table before each test.** Run `make db-test` once to create a
separate `payetam_test` database and set `TEST_DATABASE_URL` in `.env`, or the suite will empty your
development data instead.

Nothing transactional is ever mocked. Capacity, ledger and waitlist tests run against a real database,
because the guarantees they check are database guarantees.

### 10. Ports, and when something is already using one

| Port | What |
|---|---|
| 3000 | API (`API_PORT`) — `/health`, `/ready`, `/metrics`, `/telegram/webhook/:secret` |
| 5173 | Mini App (dev server or preview) |
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

## Security

- **Never commit secrets.** `.env*` is git-ignored; `.env.example` holds placeholders only.
- Report a vulnerability privately to the maintainers, not in a public issue.
- Read [`docs/threat-model.md`](docs/threat-model.md) before touching authentication, chat, the economy, or
  the admin panel.

**Stated honestly:** chat messages are encrypted at rest with a key the application server holds. That
protects database dumps, backups and a stolen disk. It is **not** end-to-end encryption and does not protect
against a compromised server. Do not describe it otherwise to users.

---

## License

Proprietary. All rights reserved.
