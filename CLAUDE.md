# PayeTam (پایه‌تَم)

A Telegram marketplace for shared activities, in Persian, RTL-first. A **NestJS modular
monolith** in a pnpm workspace, deployed on one VPS via Docker Compose. Three surfaces
(bot, Mini App, admin panel) over one backend.

> **An entry point, not a knowledge base.** Read [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)
> first — especially §7 ("Traps this repo has actually fallen into") and §8 ("Deliberate
> design positions — do not fix these").

> **Operational memory** — how to verify, test and release — lives in
> [`.memory/index.md`](.memory/index.md), with skills in `.claude/skills/`
> (`/verify`, `/integration-tests`, `/release`, `/memory-sync`, `/session-end`). Read the
> index's routing table rather than every entry.

> **Closing the session is work, not a stop.** "Close the session", "سشن رو ببند" or any
> equivalent means run `/session-end` first — sweep what the session learned into
> `.memory/`, verify each fact against the tree, then hand back the manual-close
> handshake. Claude cannot terminate the client session and never claims it did.

## Project Overview

pnpm `10.30.0` · Node `>=22.12` · TypeScript `5.9.3` project references (`tsc -b`, CommonJS).

| Package | Role |
|---|---|
| `apps/api` | NestJS 11 on Fastify. HTTP + the Telegram **webhook**. There is no separate bot process |
| `apps/worker` | NestJS standalone + BullMQ 6. The **only** process that calls Telegram |
| `apps/miniapp` | Vue 3 + Vite + Pinia + Tailwind 4 (being retired — `docs/v0.4.1-mini-app-retirement-plan.md`) |
| `apps/admin` | Vue 3 + Vite + Pinia + Tailwind 4, staff panel |
| `packages/domain` | **All business logic.** 20 modules, 47 services |
| `packages/db` | Prisma 7 + Postgres 16. 56 models, hand-written migrations |
| `packages/platform` | Redis, BullMQ, pino logging, metrics, crypto, clock, rate limiting |
| `packages/telegram` | Templates, keyboards, callback codec, wizard renderer. No I/O |
| `packages/shared` | Zod contracts + the error catalogue, shared by all four apps |
| `packages/config` | `loadEnv()` — env is validated at boot; a bad value refuses to start |

## Search & Navigation Priority

1. **`PROJECT_MEMORY.md`** — §2 routes any question to the right document, §9 lists patterns
   already abstracted. Cheaper than searching.
2. **`docs/adr/README.md`** — 18 ADRs, the 12 invariants, and which ADR owns each. Read
   before changing architecture.
3. **`docs/project-review.md`** (what exists today) and **`docs/implementation-plan.md`**
   (the frozen plan) — both large, so grep rather than read whole.
4. **ripgrep over `apps/ packages/ tools/ test/`**, excluding `dist/`, `node_modules/` and
   `packages/db/src/generated/` (all build output). Then the tests — 143 `*.test.ts` beside
   their source, 51 `*.int.test.ts` — and `packages/shared/src/contracts/`, `errors.ts` for
   API shapes and error codes.

Comments here are load-bearing: most non-obvious code says *why*. Read it before changing
the line.

## Development Commands

`make help` lists everything. The ones that matter:

```bash
make setup          # pnpm install + generate .env from .env.example (never overwrites)
make dev            # Postgres, Redis, migrate, tsc watch, api, worker, miniapp, admin
make status         # containers, PIDs, ports, /health, /ready, tunnel URLs
make logs SERVICE=api
make stop           # only what `make dev` started; containers stay up
make seed           # policies, catalog, blacklist, RBAC, settings, events — in order

make check          # typecheck + lint + test — the CI gates
make typecheck      # tsc -b, then vue-tsc for both frontends
make lint / make format / make format-check
make test           # all four Vitest projects
make db-test        # create+migrate payetam_test, then set TEST_DATABASE_URL in .env
make test-int       # integration project only — real Postgres, ~30 min

pnpm db:migrate          # dev; db:migrate:deploy is what production runs
pnpm db:generate         # the Prisma client is generated, never committed
pnpm bot-walkthrough     # every wizard screen, no DB and no network
pnpm set-bot-commands    # publish the command menu (once per bot, not per deploy)
```

Local ports: API `3000`, Mini App `5173`, admin `5174`, Postgres `55432`, Redis `56379`
(the last two bound to `127.0.0.1`, deliberately not 5432/6379). Telegram testing is
`make dev && make tunnel && make webhook` — `README.md` §8.

## Architecture Rules

- **`packages/domain` holds all business logic and imports no HTTP framework and no
  grammY.** `apps/api` and `apps/worker` are thin adapters over the same services. If a
  rule needs `request` or `ctx` to be expressed, it is in the wrong layer.
- **Wire a module where the provider is declared.** Nest scopes providers to the declaring
  module; importing into the root is not enough. `apps/{api,worker}/src/app.module.test.ts`
  resolves both graphs and exists to catch exactly this.
- **The 12 invariants** (`README.md` §The twelve invariants) are bugs when violated,
  regardless of what a test says. Most often missed: `telegram_user_id` never reaches an API
  response, a log or a frontend bundle (add every new endpoint to
  `apps/api/src/response-leak.int.test.ts`); every state transition goes through
  `assertTransition()` (`packages/domain/src/state-machine.ts`) and writes `audit_log`;
  every outbound Telegram call goes on the queue (one documented exception,
  `apps/api/src/telegram/membership.probe.ts`); every mutating admin action is authorised
  **in the service layer**, not only a guard.
- **Migrations are hand-written and sequentially numbered**, e.g.
  `packages/db/prisma/migrations/00000000000044_retire_conversations/migration.sql`, and
  **additive only** — nothing dropped, renamed or narrowed, because `scripts/rollback.sh`
  does not undo migrations. Update `schema.prisma` to match, then `pnpm db:generate`.
- **A rule enforced in a guard protects only that guard's surface.** The bot calls domain
  services directly and never passes through `AuthGuard`. Ask of any cross-cutting rule
  which surfaces it actually reaches.
- ADRs are frozen. Changing a decision means a **new ADR plus a plan update**, never an
  edit in passing.

## Coding Conventions

- Files are kebab-case, suffixed by role: `*.controller.ts`, `*.service.ts`, `*.module.ts`,
  `*.guard.ts`, `*.interceptor.ts`, `*.pipe.ts`, `*.filter.ts`, `*.test.ts`, `*.int.test.ts`.
  Vue views are `PascalCaseView.vue`.
- Import from a package root (`@payetam/db`), never its internals — `no-restricted-imports`
  in `eslint.config.mjs` enforces it.
- Enforced by lint: no `any`, no floating promises, `import type`, `eqeqeq`, `prefer-const`,
  `no-param-reassign`, and `no-console` (only `console.error`, only at bootstrap; `tools/`
  and `test/` are exempt).
- Validation is **zod** from `@payetam/shared` via `ZodValidationPipe`, per route — not
  class-validator, so the frontends and the API share one set of rules. Errors are codes
  from `packages/shared/src/errors.ts`, each paired with a Persian message
  (`errors.test.ts` asserts the mapping is total).
- Logging is the redacting `AppLogger` from `@payetam/platform`. Never log a secret or a
  Telegram identifier.
- Prettier (`.prettierrc`): single quotes, semicolons, trailing commas, width 100. Markdown
  is **not** formatted (`.prettierignore`).
- Commits are Conventional Commits with a scope, lowercase and descriptive:
  `fix(bot): the reply button under a direct message was never drawn`.

## Testing and Verification

Four Vitest projects (`vitest.config.mts`): `unit`, `miniapp` (jsdom), `admin` (jsdom),
`integration` (real Postgres, `maxWorkers: 1`). After any change, in this order:

```bash
make typecheck              # NOT the bare `rtk pnpm` shorthand — see below
pnpm lint && pnpm format:check
pnpm test --project unit --project miniapp --project admin   # fast
pnpm test:integration                                        # before tagging, always
pnpm build
```

- **`rtk pnpm typecheck` reports a failing typecheck as green** — `No errors found`,
  **exit 0**, while `tsc` exits 2. Only that bare `rtk pnpm <script>` shorthand is
  affected; `make typecheck`, `rtk pnpm run typecheck` and `rtk proxy …` all report
  correctly, and tests and lint are not masked. A `PreToolUse` hook
  (`.claude/hooks/block-masked-typecheck.sh`) blocks the bad form.
  Detail: `.memory/runtime/verification.md`.
- **`pnpm typecheck` must run before the integration suite.** That project has no
  `@payetam/*` alias, so it resolves to each package's `dist` — without a build you are
  testing the previous one.
- **Integration tests `TRUNCATE` every table.** Run `make db-test` once and set
  `TEST_DATABASE_URL`, or they empty your development data (`test/integration/setup.ts`
  warns, then proceeds). Nothing transactional is mocked: capacity and ledger guarantees
  are database guarantees.
- After touching a wizard: `pnpm bot-walkthrough`. After a deploy: `scripts/smoke-tests.sh`.
- CI (`.github/workflows/ci.yml`) also fails on `$queryRawUnsafe`/`$executeRawUnsafe`, any
  `v-html`, a tracked `.env`, and a missing hand-written index, trigger or CHECK constraint
  (the allowlist in the `integration` job).

## Configuration and Environment

`.env` is the only configuration file, validated at boot by `packages/config/src/env.ts`.
`.env.example` (local) and `.env.production.example` (server) list every key with the command
that generates each secret; `make setup` writes local ones and `scripts/check-env.sh` is the
production pre-flight. `POSTGRES_PASSWORD` and `REDIS_PASSWORD` each appear twice in `.env`
(bare, and inside a URL) because neither Compose nor Node expands `${…}`.

## Security Rules

- **Never commit** `.env` or any `.env.*` except the two `*.example` templates, `*.pem`,
  `*.key`, `secrets/`, backups, or production logs — CI fails the build on a tracked `.env`
  or private key. Never put a real secret value in a document, log, fixture or commit message.
- **`docs/production-deployment-todo.md` is untracked on purpose.** `git add -A` has swept
  it in twice (`PROJECT_MEMORY.md` §7, traps 3 and 10). **Stage by path, and read
  `git status` before every commit.**
- `.claude/`, `.dev/` (PIDs, logs, tunnel URLs) and `.deploy/` are git-ignored, machine-local,
  and must stay so. `packages/db/src/generated/` is generated, never committed.
- Reporting and accepted risks: `SECURITY.md`, `docs/threat-model.md`.

## Git Workflow

- Main branch is `master`; work happens on prefixed branches (`feat/`, `feature/`, `fix/`,
  `docs/`). **Explicit approval before any production action, including `git push`.**
- Releases deploy **by tag**, and every tag needs a `CHANGELOG.md` entry — the tag is the
  unit a rollback undoes.
- A tag push runs the `verify` job only. Deploying is `workflow_dispatch`, or
  `scripts/deploy.sh <tag>` on the server; rollback is `scripts/rollback.sh`.

## Docker and Deployment

- Local (`docker-compose.yml`): Postgres + Redis only, bound to `127.0.0.1`. App processes
  run on the host.
- Production (`docker/docker-compose.prod.yml`): `postgres`, `redis`, `api`, `worker`,
  `nginx`, `certbot`, `certbot-renew`, `tools`, over two networks (`frontend`, `internal`).
  **Only nginx publishes ports** (80/443); `api` and `worker` are `read_only`.
  `docker/Dockerfile` is multi-stage with targets `api`, `worker`, `web`, `tools`.
- Both SPAs must share an origin with the API — it sends no CORS headers, and the admin
  cookie is host-only and scoped to `/admin`.
- Use `scripts/compose.sh`, not a bare `docker compose -f docker/…`: Compose resolves
  `env_file` and relative volumes against the compose file's own directory.
- Full procedure: `DEPLOYMENT.md`.

## Common Pitfalls

`PROJECT_MEMORY.md` §7 lists 25, each from a real debugging session. The four that bite an
agent making a routine change:

- **A green suite is not a booting app.** Unit tests use `new`; only `app.module.test.ts`
  builds a real Nest graph.
- **`BotService.dispatch` swallows every error** (the webhook must answer 200), so a throw
  is a silent no-op with green tests. When a bot path looks dead, read the API log for
  `Update <id> failed:` before anything else.
- **Do not run the Nest apps under `tsx`** — esbuild drops `emitDecoratorMetadata`, so DI
  silently yields `undefined` and it fails at request time, not startup (ADR-0013).
- **Ask what the user sees**, not whether the code does what it says. Most of v0.6.5 was
  mechanisms that worked exactly as written and were still wrong on the screen.

## Needs Verification

- `.claude-work-checkpoint.md` is in `.gitignore` and `PROJECT_MEMORY.md` §7 calls it
  untracked on purpose, but `git ls-files` shows it **is currently tracked**.
- `ci.yml` triggers on `push: branches: [main]` while the default branch is `master`, so a
  direct push to `master` runs no CI — only pull requests do.
- The scale figures in `PROJECT_MEMORY.md` §3 are behind the tree; the counts above were
  measured on `fix/bot-qa-round-1`.
