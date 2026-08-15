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

**Milestone 0 complete** — architecture decisions frozen and documented. No application code yet.

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the full plan and milestone sequence.

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
packages/ db · domain · telegram · shared · config
docker/   Dockerfiles, nginx, compose
docs/     plan, ADRs, threat model, glossary
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
pnpm dev                  # tsc --watch + api + worker
```

```bash
curl localhost:3000/health   # {"status":"ok",...}
curl localhost:3000/ready    # {"ready":true,"checks":{"database":"up","redis":"up"}}
```

```bash
pnpm typecheck            # tsc -b across the workspace
pnpm lint
pnpm test                 # unit (Vitest)
pnpm test:integration     # real Postgres + Redis
pnpm check                # what CI runs
```

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
