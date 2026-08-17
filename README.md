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

## Development

```bash
make setup                # installs deps and writes .env with generated local secrets
make up                   # postgres + redis (ports 55432 / 56379, so they do not
                          # collide with any other stack on your machine)
pnpm db:generate          # Prisma client is generated, not committed
pnpm --filter @payetam/db db:migrate:deploy
make seed                 # policies, catalog (cities, categories, interests), blacklist
pnpm dev                  # tsc --watch + api + worker + miniapp
```

```bash
curl localhost:3000/health   # {"status":"ok",...}
curl localhost:3000/ready    # {"ready":true,"checks":{"database":"up","redis":"up"}}
```

```bash
pnpm typecheck            # tsc -b across the workspace, then vue-tsc for the Mini App
pnpm lint
pnpm test                 # unit (Vitest)
pnpm test:integration     # real Postgres
pnpm check                # what CI runs
```

**Integration tests TRUNCATE every table before each test.** Run `make db-test` once to create a
separate `payetam_test` database and set `TEST_DATABASE_URL` in `.env`, or the suite will empty your
development data instead.

The Mini App runs at `localhost:5173` and proxies `/api` to the API. It only authenticates inside
Telegram — `initData` is what it signs in with, and a plain browser tab has none — so open it through
BotFather's Mini App URL (an `ngrok`/`cloudflared` tunnel to port 5173 works) rather than directly.

**Do not run the Nest apps under `tsx`.** esbuild does not emit
`emitDecoratorMetadata`, so dependency injection silently yields `undefined` and the
app fails at request time rather than at startup. See
[ADR-0013](docs/adr/0013-typescript-build-and-dev-loop.md).

Nothing transactional is ever mocked. Capacity, ledger and waitlist tests run against a real database,
because the guarantees they check are database guarantees.

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
