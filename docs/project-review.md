# PayeTam — Project Review

**As of 2026-08-20, after M18.** A complete walk of what exists: the architecture, every module, every
route, every table, the flows that matter, and an honest list of what is unfinished.

This is a *survey*, not a plan. Where it and [`implementation-plan.md`](implementation-plan.md) disagree,
the plan states intent and this states what the code does — and every such disagreement found while
writing this has been reconciled in one direction or the other (see §14).

| Read this for | Go here instead for |
|---|---|
| What is built, and where it lives | [`implementation-plan.md`](implementation-plan.md) — the frozen plan and milestone sequence |
| How a flow actually runs end to end | [`adr/`](adr/README.md) — why each architectural decision was made |
| What is missing or risky | [`launch-readiness.md`](launch-readiness.md) — the 32 acceptance criteria and the open blockers |
| | [`threat-model.md`](threat-model.md) — assets, adversaries, accepted risks |
| | [`glossary-fa.md`](glossary-fa.md) — Persian ↔ English terms |

---

## 1. What the product is

A two-sided marketplace on Telegram for shared activities in Tehran — café and board games, light
outdoor activity, sport, learning. Three surfaces over one backend:

- **Mini App** — discover, filter and create activities; profile, coins, Trust Score, invitations.
- **Bot** — onboarding, notifications, accept/reject from a button, and the **anonymous chat relay**.
- **Channel** — VIP, boosted and trending activities, posted by the worker.

Plus an **admin panel** (`apps/admin`) over the admin API, for moderation, the economy and audit —
built in M19, which closed blocker B2. See [`admin-panel.md`](admin-panel.md).

The differentiator is that **a chat exists from the request, not from the acceptance**: two strangers
negotiate a meeting before either has committed to anything.

---

## 2. Architecture

### 2.1 Shape

A TypeScript **modular monolith** (ADR-0001) built with NestJS, deployed as **two processes** plus a
static bundle:

```
                    ┌──────────────────────────────┐
   Telegram ───────▶│  apps/api        (Fastify)   │
   (webhook)        │  · /api/v1  Mini App, Bearer │
                    │  · /admin/v1 panel, cookie   │
   Mini App ───────▶│  · /telegram/webhook/:secret │
   (initData→JWT)   │  · /health /ready /metrics   │
                    └───────────┬──────────────────┘
                                │  enqueue only, never send
                    ┌───────────▼──────────────────┐
   Postgres 16 ◀────│  Redis 7 + BullMQ            │
   (Prisma)         └───────────┬──────────────────┘
        ▲                       │
        │           ┌───────────▼──────────────────┐
        └───────────│  apps/worker                 │────▶ Telegram (the only sender)
                    │  · outbox relay              │
                    │  · 8 repeatable sweeps       │
                    │  · channel publishing        │
                    └──────────────────────────────┘
```

Two rules make this hold together, and both are invariants:

- **`packages/domain` holds all business logic and imports no HTTP framework and no grammY.** `apps/api`
  and `apps/worker` are thin adapters over the same services, which is why the bot and the Mini App
  cannot drift apart: a host who accepts from an inline button and a host who accepts from the
  participant list reach the same method.
- **Every outbound Telegram call goes through the queue** (invariant 11). The API enqueues; the worker
  is the only thing in the product that calls Telegram.

### 2.2 Data flow for a state change

```
request ──▶ service ──▶ ┌ transaction ─────────────────────────┐
                        │ 1. SELECT … FOR UPDATE (if capacity) │
                        │ 2. assertTransition()                │
                        │ 3. write the state change            │
                        │ 4. write audit_log                   │
                        │ 5. write outbox_event                │
                        └──────────────────────────────────────┘
                                        │ commit
                          relay ────────┴──▶ notification rows ──▶ telegram-send ──▶ Telegram
```

The **transactional outbox** (ADR-0005) is what makes "state changed ⇒ notification sent" true across a
crash: the domain event commits with the change that caused it. A `RelayNudgeInterceptor` wakes the
relay as soon as a request that may have written one returns; a five-minute backstop sweep is the
guarantee behind it.

### 2.3 Stack

| Layer | Choice | ADR |
|---|---|---|
| Backend | TypeScript modular monolith — NestJS 11, Fastify adapter | [0001](adr/0001-modular-monolith-and-deployment.md) |
| Database | PostgreSQL 16 + Prisma 7 (`prisma-client` generator, CJS output) | [0002](adr/0002-postgresql-and-prisma.md) |
| Queue / cache | Redis 7 + BullMQ | [0005](adr/0005-transactional-outbox-and-jobs.md) |
| Bot | grammY, **webhook mode** (polling is refused in production) | [0004](adr/0004-telegram-webhook-and-miniapp-auth.md) |
| Frontend | Vue 3 + Vite 8 + Pinia + Tailwind 4, RTL-first fa-IR | [0003](adr/0003-vue-frontend-and-telegram-design-system.md) |
| Validation | zod 4 schemas in `packages/shared`, shared by API and Mini App | — |
| Tests | Vitest 4 — three projects: `unit`, `miniapp` (jsdom), `integration` (real Postgres) | — |
| Build | `tsc -b` project references; **never `tsx` for the Nest apps** | [0013](adr/0013-typescript-build-and-dev-loop.md) |
| Deploy | Single VPS, Docker Compose, nginx | [0001](adr/0001-modular-monolith-and-deployment.md) |

Node ≥ 22.12, pnpm 10.30, workspaces.

---

## 3. Folder structure, and what each part is for

```
apps/
  api/       NestJS HTTP adapter. Controllers + view mappers only; no business logic.
  worker/    BullMQ consumers. The outbox relay, eight sweeps, the Telegram client.
  miniapp/   Vue 3 SPA served by Vite. 13 screens.
  admin/     Vue 3 SPA served by Vite. 12 screens, RTL Persian, its own palette —
             it is not a Telegram surface (M19, §3.7).
packages/
  domain/    ALL business logic. Imports no HTTP framework, no grammY. The reason
             the bot and the Mini App cannot disagree.
  db/        Prisma schema, hand-written migrations, the generated client, PrismaService.
  shared/    zod contracts + the error catalogue. Imported by API, worker AND Mini App,
             so a response shape has exactly one definition.
  platform/  Cross-cutting infrastructure with no domain knowledge: clock, logger,
             redaction, metrics, Redis, queues, rate limiting, PII hashing, env provider.
  telegram/  Message templates, keyboards, callback-data codec, HTML escaping, update
             parsing. Pure functions — it does not call Telegram.
  config/    Environment validation. The process refuses to start if a variable is
             missing or malformed.
docs/        This file, the plan, ADRs, threat model, glossary, runbooks.
test/        Integration harness: the real-Postgres client, TRUNCATE reset, fixtures.
tools/       Seed scripts (policies, catalog, blacklist, RBAC, settings, demo events).
```

### 3.1 `apps/api` — one directory per bounded context

| Directory | Contents |
|---|---|
| `auth/` | `initData` → JWT exchange, refresh, the **global** `AuthGuard` (deny-by-default) |
| `onboarding/` | `/me`, current policies, consent, profile completion |
| `catalog/` | Cities, districts, categories, interests, promotion pricing |
| `events/` | Create, edit, boost, cancel, cancel-preview, own events |
| `discovery/` | Search/filter, one event, `explain-rank` |
| `participation/` | Join, accept, reject, cancel, no-show, own participations, the host's queue |
| `chat/` | List, read, send, close, share contact |
| `economy/` | Coins, Trust Score, referral summary + claim, **gift-code redemption** |
| `reviews/` | Pending, submit, read own, a user's revealed reviews |
| `moderation/` | Report an event, user, review or message |
| `admin/` | The whole `/admin/v1` surface, plus the cookie/CSRF guard |
| `telegram/` | Webhook controller + `BotService`, the inbound handler |
| `health/`, `metrics/` | `/health`, `/ready`, `/metrics` |
| `common/` | Exception filter, zod pipe, idempotency interceptor, rate-limit guard, relay nudge, security headers, observability |

`*.view.ts` files are the **DTO mappers**, and they are field-by-field by rule, never a spread
(§3.6 layer 2 of the plan). That is what stops a new column reaching the wire.

### 3.2 `packages/domain` — one directory per module

`identity` · `profile` · `catalog` · `events` · `participation` · `chat` · `discovery` · `economy` ·
`reviews` · `moderation` · `adminaccess` · `notifications` · `outbox` · `audit` · `channel` · `privacy`

Each holds its services, its `state-machine.ts` where it has one, and its `*.int.test.ts`.

---

## 4. Data model

**44 Prisma models, 33 enums, 45 tables, 16 migrations.** All hand-written SQL — `prisma migrate dev`
is not used to author them, so every constraint, partial index and trigger is deliberate and commented.

> **Migration numbering has a gap**: there is no `0010`. Migrations run in lexical order and Prisma
> records applied names, so the gap is inert — but it is a real artefact and worth knowing about before
> somebody "fixes" it. (`0010` was folded into `0009` during M9.)

### 4.1 Identity and profile

```
User ──1:1── TelegramAccount        the highest-value PII, deliberately its own table
 │                                  (only the identity module may read it — invariant 7)
 ├──1:1── UserProfile ── City, District
 ├──n:m── Interest  (UserInterest)
 ├──1:n── Consent ── PolicyVersion
 ├──1:1── CoinAccount        ──1:n── CoinLedger
 ├──1:1── TrustScore         ──1:n── TrustScoreLedger
 ├──1:1── Referral (as referred)   ──n── Referral (as referrer)
 ├──1:n── GiftCodeRedemption ── GiftCode
 ├──1:n── Event (hosted)
 ├──1:n── EventParticipant
 ├──1:n── ChatParticipant
 ├──1:n── Review (written / received), Report, Notification
 └──1:n── RequestIdempotency
```

- `user.public_id` is a **random UUIDv4** and is the only identifier that may appear in a response or a
  URL. `user.id` is UUIDv7 — time-ordered for index locality — and never leaves the backend.
- `telegram_user_id` is `BIGINT`, which Prisma maps to `bigint`. That is a useful accident:
  `JSON.stringify` throws on a bigint, so serialising one fails loudly instead of leaking silently.
- `user.referral_code` is nullable and **generated on first read**, so a user who never opens the invite
  screen costs nothing.
- `user_profile.birth_year` is a *year*, not a date — the coarsest value that still answers "is this
  person 18?" (ADR-0009 D4).

### 4.2 Catalog

`City ──1:n── District`, `Category ──1:n── Interest`. Nothing user-selectable is free text: a user picks
from admin-managed lists, which is what makes filtering and moderation tractable.

### 4.3 Events and participation

```
Event ──n:1── User (host), Category, City, District?
  │
  ├──1:n── EventParticipant ──1:1── AnonymousChat
  │             │                       ├──1:n── ChatParticipant ──1:n── ChatMessage
  │             │                       ├──1:n── ChatAction
  │             │                       └──1:n── ChatUnsealGrant
  │             ├──1:n── Review
  │             ├──1:1── ReviewPair
  │             └──n:1── CoinLedger (the penalty this cancellation produced)
  └──1:n── ChannelPost
```

Load-bearing details:

- **`event.accepted_count <= capacity`** is a DB CHECK *and* is only ever changed under
  `SELECT … FOR UPDATE` on the event row (invariant 1, ADR-0006).
- **`UNIQUE (event_id, user_id)`** on `event_participant` is invariant 4 and the duplicate-request guard:
  the join path inserts and reads the row count rather than checking first, because a read-then-write has
  a race window and a constraint has none.
- **There is no waitlist table.** A waitlisted user *is* an `event_participant` with
  `status = 'WAITLISTED'`, and queue order is derived from `(requested_at, id)` under a partial index.
- `event.search_vector` is `Unsupported("tsvector")`, maintained by a trigger from the *normalized*
  columns. It is invisible to the generated client on purpose — every query that uses it is raw SQL in
  `PostgresSearchProvider`.
- Partial indexes carry the discovery, boost, waitlist and retention queries.

### 4.4 Chat — the anonymity boundary in table form

- A chat names an event, a participant and two users **by internal id**. There is no path from a message
  to a Telegram identifier.
- `chat_participant.alias` is stored, not derived, and is assigned per *chat* from arrival order within
  the event. It never changes, because a recipient who has been reading «میهمان ۲» for a week cannot
  have that person silently renumbered.
- `chat_message.body_ciphertext` is AES-256-GCM with a per-message nonce and a `key_version`. Metadata
  stays in clear so moderation can query patterns without decrypting anything.
- `anonymous_chat.next_seq` is the gap-free per-chat allocator:
  `UPDATE … SET next_seq = next_seq + 1 RETURNING` in one statement, whose implicit row lock is held only
  for the insert that follows.

### 4.5 Economy

```
CoinAccount (cached balance, CHECK >= 0)  ──1:n── CoinLedger (append-only, trigger-enforced)
TrustScore  (cached 0–100)                ──1:n── TrustScoreLedger (append-only)
Referral    (referred_user_id UNIQUE, CHECK referrer <> referred)
GiftCode    ──1:n── GiftCodeRedemption ──1:1── CoinLedger
```

**The balance is a cache; the ledger is the truth.** `balance` must always equal
`SUM(coin_ledger.amount)`, and a reconciliation test asserts it. Every movement carries a UNIQUE
`idempotency_key` derived from its cause, which is what makes every economic operation safe to retry.

`trust_score_ledger.delta` is the **effective** movement after clamping — a rule worth +3 against
somebody at 99 stores +1 and records the 3 in `metadata`. Storing the requested value would break
`score = SUM(delta)` the first time anyone hit a bound.

### 4.6 Reviews, moderation, ops, admin

`Review` / `ReviewPair` (blind, revealed together at T+24h) · `Report` (UNIQUE per target+reporter) ·
`ModerationCase` + `BlacklistTerm` / `BlacklistVersion` · `OutboxEvent` · `Notification` (UNIQUE
`dedupe_key`) · `JobFailure` (DLQ mirror) · `ChannelPost` · `AppSetting` / `FeatureFlag` ·
`RequestIdempotency` · `AuditLog` · `AdminUser` / `Role` / `Permission` / `RolePermission` /
`AdminUserRole` / `RoleChangeRequest` / `ChatUnsealGrant`.

### 4.7 The twelve invariants

1. `accepted_count <= capacity` — DB CHECK **and** row lock.
2. `coin_account.balance >= 0` — DB CHECK.
3. Coin and trust ledgers are append-only — trigger-enforced.
4. One participation row per `(event, user)` — DB UNIQUE.
5. One report per `(target, reporter)` — DB UNIQUE.
6. One review per `(participation, reviewer)` — DB UNIQUE.
7. `telegram_user_id` never appears in an API response, a log line, or a frontend bundle.
8. No review is readable by the counterparty before reveal — enforced at the API layer.
9. All policy timing uses the server clock; no endpoint accepts a client timestamp.
10. Every state transition goes through `assertTransition()` and writes `audit_log`.
11. Every outbound Telegram call goes through the queue.
12. Every mutating admin action is authorised **in the service layer** and audited.

---

## 5. APIs

Three bases, three authentication schemes:

| Base | Who | Auth |
|---|---|---|
| `/api/v1` | Mini App and bot-driven user actions | Bearer JWT from `initData` |
| `/admin/v1` | Staff | `HttpOnly` session cookie + CSRF header |
| `/telegram/webhook/:secretPath` | Telegram | Secret path **and** secret token, both compared in constant time |

Error envelope: `{ error: { code, messageFa, details? } }`. `code` is stable and machine-readable;
`messageFa` is Persian a user can read. `errors.test.ts` asserts the mapping is **total** over
`ErrorCode`, so adding a code without a Persian message fails the build.

Mutating endpoints accept `Idempotency-Key`; a replay returns the byte-identical stored response with
`Idempotency-Replayed: true`.

### 5.1 `/api/v1`

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/telegram` | Public. HMAC + freshness + one-time replay guard |
| POST | `/auth/refresh` | Public. Rotating refresh with family reuse detection |
| GET | `/me` | Session user + profile + coin balance |
| GET | `/policies/current` | Public |
| POST | `/onboarding/consent` | |
| POST | `/onboarding/profile` | Grants the onboarding coins **exactly once** |
| GET | `/catalog` | Cities, districts, categories, interests, promotion pricing |
| GET | `/events` | Discovery: 12 filters, 3 sorts, keyset pagination ≤ 50 |
| GET | `/events/:publicId` | One event, as a stranger sees it. **Now includes `host.trustScore`** |
| GET | `/events/:publicId/explain-rank` | The score's component breakdown |
| POST | `/events` | Create → Persian auto-moderation → publish or block |
| PATCH | `/events/:publicId` | Optimistic concurrency on `version` |
| POST | `/events/:publicId/boost` | `BOOST` or `VIP`. Spends coins; `Idempotency-Key` matters here |
| POST | `/events/:publicId/cancel` | Refunds, closes chats, penalises the host |
| GET | `/events/:publicId/cancel-preview` | What cancelling *would* cost |
| GET | `/me/events` | The host's own events, including ones discovery hides |
| POST | `/events/:publicId/join` | 201 with `PENDING` **or** `WAITLISTED` + rank |
| GET | `/events/:publicId/participants` | Host only. **Now includes each requester's `trustScore`** |
| POST | `/participants/:publicId/accept` \| `/reject` | Host only, checked in the service |
| POST | `/participants/:publicId/cancel` | |
| GET | `/participants/:publicId/cancel-preview` | |
| POST | `/participants/:publicId/no-show` | |
| GET | `/me/participations` | |
| GET | `/chats` | **Now includes `counterpartName`** |
| GET/POST | `/chats/:publicId/messages` | |
| POST | `/chats/:publicId/close` \| `/share-contact` | |
| GET | `/me/coins` \| `/me/trust` | Balance **and its ledger** — ADR-0007's whole point |
| GET | `/me/referral` | Own code, invited, qualified, coins earned, own referrer status |
| POST | `/referrals/claim` | |
| POST | `/gift-codes/redeem` | **New (M18).** 10/hour |
| GET | `/me/reviews/pending` · POST `/participants/:id/review` · GET `/users/:id/reviews` | |
| POST | `/events\|users\|reviews\|chats/:publicId/report` | |

### 5.2 `/admin/v1`

`auth/login` (email + password + TOTP, all three, always) · `auth/logout` · `me` (identity **and**
the CSRF token, so a reloaded panel can still act — M19) ·
`moderation/cases` + `.../decide` · `coins/adjust` · `trust/adjust` · `users/:publicId/status` ·
`chats/:publicId/unseal` + `chats/unseal/:grantId` (break-glass) · `roles/requests` +
`.../approve` (four-eyes) · `audit`.

**Gift codes** (M18, reshaped in M19 by ADR-0016 — every route addresses a code by `public_id`, and
no read returns one): `POST|GET gift-codes` · `POST gift-codes/batch` · `PATCH gift-codes/:publicId` ·
`POST gift-codes/:publicId/active` · `GET gift-codes/campaigns` ·
`GET gift-codes/:publicId/analytics` · `GET gift-codes/:publicId/redemptions`.

**Referral review** (M19, permission `referral.manage`): `GET referrals` · `GET referrals/:id` ·
`POST referrals/:id/reject` · `POST referrals/:id/reinstate`.

**The panel's own reads** (M19): `GET dashboard` · `GET users` + `users/:publicId` · `GET events` +
`events/:publicId` + `POST events/:publicId/moderate` · `GET reports` +
`POST reports/:publicId/decide` · `GET ledger` + `ledger/reconcile` · `GET audit/search` ·
`GET settings` + `POST settings/:key`.

**There is no permission check in the admin controller.** ADR-0010 rule 2 puts authorisation in the
service layer, because a controller guard protects one route while a service check protects every
caller — including the jobs and scripts that do not exist yet. `rbac-matrix.int.test.ts` asserts
**every role × every operation** against the services, and fails if an operation is added without a
declared permission.

### 5.3 Defence in depth on the request path

```
Fastify hook (request id, metrics)
  → AuthGuard        (global; @Public() to opt out; terms gate)
  → RateLimitGuard   (keyed on the user when there is one, the IP when there is not)
  → IdempotencyInterceptor
  → RelayNudgeInterceptor
  → ZodValidationPipe (per route, over the shared contracts)
  → controller → service → transaction
  ← AppExceptionFilter (AppError → documented status + Persian message)
```

---

## 6. Registration, login and authentication

**There is no password and no email for end users.** Identity is Telegram's.

```
Mini App opens inside Telegram
  └─ window.Telegram.WebApp.initData
       │
       ▼  POST /api/v1/auth/telegram
   1. InitDataValidator — HMAC-SHA256 with the bot token, and a freshness window.
      Throws before any I/O happens.
   2. InitDataReplayGuard — the hash is claimed once, in Redis. Steps 1+2 together
      are what make a captured blob useless.
   3. UserService.findOrCreateByTelegram — only now is the Telegram id trustworthy
      enough to write. Creates `user` + `telegram_account`.
   4. SessionService.issue — our own access + refresh JWTs. initData is never used again.
       │
       ▼
   { accessToken, refreshToken, user: { publicId, onboardingState, locale, timezone } }
```

Refresh is **rotating with family reuse detection**: `POST /auth/refresh` consumes the old token, issues
a new one in the same family, and **re-reads the user** rather than trusting the retired token's copy —
so a ban takes effect on the next refresh and a freshly-onboarded user gets their new state.

The bot's `/start` is the other entry: it creates the account the same way, and `/start <code>` claims a
referral code in one step.

### Onboarding gate

```
NEW ──accept terms──▶ TERMS_ACCEPTED ──complete profile──▶ PROFILE_COMPLETE
                                            └─ grants the onboarding coins, once
                                            └─ seeds the Trust Score, once
```

`AuthGuard` is registered **globally** via `APP_GUARD`, so a new endpoint is protected unless it opts
out with `@Public()`. The terms gate lives in the guard; the 18+ rule lives in `ProfileService`. The
Mini App's router mirrors the funnel as a navigation aid — **not** as enforcement.

---

## 7. Event creation and management

```
POST /events
  │
  ├─ assertHostCanAuthor      profile must be complete — an event carries a display name
  ├─ assertWithinQuota        5/day and 3 concurrent upcoming (app_setting)
  ├─ normalize(title, description)   ADR-0012's Persian pipeline
  ├─ ModerationService.scan   against the active blacklist version
  │     ├─ BLOCK  → CONTENT_BLOCKED, nothing is published, a case records the version
  │     └─ FLAG   → published AND flagged; a moderator looks while users can see it
  ├─ create event (status PUBLISHED, moderationStatus APPROVED/FLAGGED/PENDING)
  ├─ audit_log + outbox_event
  └─ trigger maintains search_vector from the normalized columns
```

`PATCH /events/:publicId` takes `expectedVersion` — optimistic concurrency for two host sessions.
**Capacity is never protected by the version token**; a version check cannot make a counter safe.

`POST /events/:publicId/boost` spends coins (`BOOST` buys a 24-hour window, `VIP` a standing flag) and
is the endpoint `Idempotency-Key` exists for: a second boost is a legitimate second purchase, so the
service cannot tell "asked twice" from "arrived twice" — only the client can, by naming the intention.

`POST /events/:publicId/cancel` is the heavy one: under the event lock it retires every request, refunds
accepted participants, closes every conversation, penalises the host by lateness bucket, and emits one
domain event that fans out to everybody. `GET .../cancel-preview` quotes the price first, from the same
code against the same clock.

A worker sweep retires finished events (`ONGOING` → `COMPLETED` → settlement).

---

## 8. The guest request flow

```
POST /events/:publicId/join
  │
  ├─ eligibility, from the SERVER's copy of the facts: age band, gender preference,
  │  not the host, event joinable. No field in the request decides anything.
  │
  └─ transaction:
       1. SELECT … FOR UPDATE on the event row      ← first statement, only lock
       2. INSERT event_participant ON CONFLICT DO NOTHING
          └─ row count 0 ⇒ DUPLICATE_REQUEST (the UNIQUE decides, not a prior read)
       3. seat free?  → PENDING,  accepted_count += 1, hostDeadlineAt =
          │                        min(now + 24h, starts_at − 3h)
          └─ no seat?  → WAITLISTED, rank derived from (requested_at, id)
       4. ChatService.createForParticipant  ← under the SAME lock, which is what
          makes two simultaneous joiners get two different aliases
       5. audit_log + outbox_event
```

**Nothing slow happens inside the lock** — no network call, no Telegram API — because the lock
serialises every joiner of a popular event.

The response is what the client renders. `EventDetailView` does **not** predict `PENDING` vs
`WAITLISTED` from `remainingCapacity`, because that prediction is wrong exactly when it matters: two
people tapping join on the last seat.

A `PENDING` request holds a seat. If the host does not answer by `hostDeadlineAt`, the `expire-pending`
sweep releases it.

---

## 9. Approval and rejection

Two surfaces, **one code path**:

- the Mini App's participant list (`MyEventsView`), and
- an inline button in the host's Telegram notification (`chat:accept|reject:<publicId>`).

Both reach `ParticipationService.accept/reject`, which:

1. takes the event row lock;
2. verifies the caller **is the host** — in the service, not the controller, and answers
   `EVENT_NOT_FOUND` rather than `FORBIDDEN`, because telling a stranger "this exists but is not yours"
   is more than they are entitled to know;
3. runs `assertParticipantTransition`;
4. on accept: `accepted_count += 1` if it was not already counted, sets `acceptedAt` and
   `graceExpiresAt` (now + 15 min), and **opens the chat** (`ANONYMOUS` → `OPEN`, which is what unlocks
   contact sharing);
5. on reject: frees the seat, which triggers waitlist promotion;
6. writes `audit_log` and an outbox event.

**Waitlist promotion** happens under the same lock, FIFO by `(requested_at, id)`, and notifies *both*
parties (ADR-0011 D8). Two concurrent cancellations promote two **different** people — asserted by a
50-iteration test.

Since M18 the host sees each requester's **Trust Score** beside their name while deciding.

---

## 10. Messaging

**Chat lives in Telegram by design.** The Mini App lists conversations and hands the user back to the
bot; it is deliberately not a chat client, because one conversation with two composers is a message that
half-arrives in the wrong one.

```
guest types in the bot's DM
  └─ webhook → BotService
       ├─ which conversation? — the message it replies to, or "the sender has exactly
       │  one live chat". Neither ⇒ an explanation, never a guess: delivering a
       │  private message to the wrong stranger is the one unacceptable outcome.
       ├─ sanitizeInbound — ALL Telegram entities stripped; phone numbers, @usernames,
       │  t.me/ links and emails masked until that sender has consented to share
       ├─ encrypt (AES-256-GCM) — the sanitizer runs BEFORE the cipher, so a masked
       │  number is masked in the ciphertext too and the platform never holds a
       │  number it refused to relay
       ├─ seq = UPDATE anonymous_chat SET next_seq = next_seq + 1 RETURNING
       └─ outbox_event 'chat.message'
            └─ relay → notification → telegram-send → sendMessage (never forwardMessage,
               link previews disabled)
```

Since M18 (ADR-0014) a relayed message is headed **«name — event»** — `senderName` falling back to the
per-chat alias, beside the event title — and the Mini App's conversation list is titled the same way.
Before that, a host with several events saw several conversations all headed «میهمان ۱», in a single
Telegram thread, with nothing to tell them apart.

Edits propagate (a new message, marked, because nothing populates `telegram_message_ids` yet).
Deletions replace the recipient's copy with «پیام حذف شد» while the row survives as the evidentiary
record (D10). Blocking is detected via `my_chat_member` and stops delivery.

Contact sharing takes an **explicit two-step confirmation** that says plainly what it does and does not
do: the platform holds no phone number and surrenders no username; what changes is that the caller's own
messages stop being masked.

---

## 11. The economy — coins and Trust Score

Both are **append-only ledgers with a cached total** (ADR-0007). Nothing writes to `coin_account` or
`trust_score` except `CoinService` and `TrustService`.

### 11.1 How a coin moves

```
CoinService.apply({ userId, amount, type, reasonCode, idempotencyKey, actorType, ... }, tx?)
  │
  ├─ create the account if absent (ON CONFLICT DO NOTHING)
  ├─ SELECT balance FROM coin_account WHERE user_id = $1 FOR UPDATE
  ├─ idempotency check WHILE HOLDING THE LOCK  ← reading it first would let two
  │  concurrent grants both see "not yet applied"
  ├─ balanceAfter < 0 ⇒ INSUFFICIENT_COINS (reported before the CHECK fires, so the
  │  user gets a sentence rather than a constraint violation as a 500)
  ├─ INSERT coin_ledger  (append-only; a BEFORE UPDATE OR DELETE trigger raises)
  └─ UPDATE coin_account SET balance = …, version = version + 1
```

`penalize()` differs deliberately: a **spend** must fail when you cannot afford it; a **penalty** must
not, or somebody escapes a cancellation charge by spending down to nothing first. It takes what is there
and records what it wanted in `metadata`.

`reverse()` writes the opposite as a new `REVERSAL` row. `reverses_ledger_id` is UNIQUE, so a row can be
reversed at most once. A `REVERSAL` cannot itself be reversed.

### 11.2 Sources and sinks

| Type | Direction | When |
|---|---|---|
| `ONBOARDING_REWARD` | + 50 | First profile completion, exactly once |
| `REFERRAL_REWARD` | + 30 / + 10 | Referrer / referred, after the referred user **attends** |
| `REVIEW_REWARD` | + 10 | On submitting a review |
| `GIFT_CODE_REDEEM` | + configured | **New (M18).** Per gift code |
| `BOOST_SPEND` | − 40 | 24 hours near the top of discovery |
| `VIP_SPEND` | − 100 | A standing placement flag |
| `CANCELLATION_PENALTY` | − 15 / − 40 | 24h–3h / under 3h |
| `NO_SHOW_PENALTY` | − 60 | |
| `HOST_CANCELLATION_REFUND` | + | Participants, when a host calls it off |
| `ADMIN_ADJUSTMENT` | ± | `coin.adjust`, which `SUPPORT` does **not** hold |
| `REVERSAL` | ∓ | Corrections |

### 11.3 Trust Score

0–100, starting at 50, `CHECK`-bounded in the schema. Moves on profile completion (+5), attendance (+2,
capped +2/day), reviews received (+3 … −5 by rating), cancellation, no-show, moderation, rehabilitation
and admin adjustment. It is **one tenth** of the discovery ranking signal, deliberately capped so a new
host with a neutral score is never buried (plan §12).

Since M18 it is visible to the counterparty as a **number only** — the host on the event page, each
requester in the host's queue. `null` means "never judged", not zero.

### 11.4 Every tunable number lives in `app_setting`

~50 keys with code defaults in `SETTING_DEFAULTS`. The defaults are not a second source of truth — they
are what the system does when a row is missing, because a missing config row taking onboarding down is a
worse failure than granting the documented default. `pnpm seed:settings` writes them **create-only**, so
an operator who tuned production is never silently reset.

---

## 12. Invitations and gift codes

### 12.1 Referral — implemented since M9, extended in M18

**The rules, and they are the project's own, not a default I invented:**

| Rule | Value | Where |
|---|---|---|
| Referrer reward | **30 coins** | `economy.referral_referrer_coins` |
| Referred reward | **10 coins** | `economy.referral_referred_coins` |
| **Qualifying action** | The **referred user attends an event** — an `event_participant` reaching `COMPLETED` | `ReferralService.qualifyForAttendance` |
| Velocity signal | 10 referrals / 24 h | `referral.velocity_window_hours`, `referral.velocity_threshold` |

**Payment on attendance, not on signup, is the whole design.** Accounts are free, so a reward for
creating one is a reward for creating them in bulk. Attendance costs a farmer a real person in a real
café, and no amount of automation makes that cheap (T6).

```
user opens the invite tab
  └─ GET /me/referral → code generated on first read (8 chars, 31-char alphabet with
     no 0/O and no 1/I/L, drawn with randomInt)

someone else: POST /referrals/claim { code }   — or /start <code> in the bot
  ├─ unknown code OR banned referrer ⇒ INVALID_REFERRAL_CODE   (one error for both:
  │  distinguishing them turns this into an oracle for which codes exist)
  ├─ own code ⇒ SELF_REFERRAL, and CHECK (referrer <> referred) behind it
  ├─ INSERT referral → UNIQUE (referred_user_id) ⇒ ALREADY_REFERRED
  │  One referrer per person, FOR LIFE, decided by the database
  ├─ fraud_signals recorded if the referrer is prolific — RECORDED, NOT ENFORCED:
  │  a wrong automatic rejection silently steals a real user's reward
  └─ status PENDING, pays nothing yet
       (if the caller has ALREADY attended something, it settles immediately)

referred user completes an event
  └─ qualifyForAttendance — checks the condition ITSELF rather than trusting the caller
       └─ ONE transaction: referrer reward + referred reward + status QUALIFIED
          The coin movement — not the status read — is what decides who qualified it:
          ten concurrent settlements all read PENDING under READ COMMITTED, so the
          read is an early exit and the idempotency key is the guard.
```

**M18 added the UI the feature was missing**: share/copy the code, and a status panel showing how many
used it, how many have qualified, and what has been earned. The claim form is hidden once the caller
already has a referrer, because a second claim can only ever be refused.

### 12.2 Gift codes — new in M18 (ADR-0015)

A campaign code typed in exchange for coins. **Not a second economy**: every coin goes through
`CoinService`, so `balance = SUM(coin_ledger.amount)` keeps holding.

```
gift_code:  code (UNIQUE, stored normalized)  coins  max_redemptions?  per_user_limit
            starts_at?  expires_at?  is_active  redeemed_count  note  created_by_admin_id
gift_code_redemption:  (gift_code_id, user_id, seq) UNIQUE   coin_ledger_id UNIQUE

POST /api/v1/gift-codes/redeem { code }        ← a string. No amount, nowhere to put one.
  ├─ resolve the code outside any transaction   (an unknown code costs no lock)
  └─ transaction:
       1. SELECT … FOR UPDATE on gift_code       ← guard 1: the global cap
       2. is_active? window? redeemed_count < max?
       3. count this user's redemptions → seq    ← guard 2: UNIQUE (code, user, seq)
       4. CoinService.apply(key = gift-code:{id}:{user}:{seq})  ← guard 3
       5. INSERT gift_code_redemption → ledger row
       6. redeemed_count += 1
       7. audit_log
```

Lock ordering is **`gift_code → coin_account`**, never the reverse — the second ordered pair in the
product after `event → coin_account`.

Four refusals: `GIFT_CODE_INVALID` (unknown **or** disabled — deliberately indistinguishable),
`GIFT_CODE_EXPIRED`, `GIFT_CODE_ALREADY_REDEEMED`, `GIFT_CODE_EXHAUSTED`.

**Management** is `/admin/v1/gift-codes`, guarded by `giftcode.manage`, held by `SUPER_ADMIN` alone.
Minting coins from nothing is the same class of capability as `coin.adjust`. M19 gave it a panel and
reclassified the code itself as a **bearer secret** (ADR-0016): reads mask it, every route addresses
it by `public_id`, and bulk minting hands the plaintext over exactly once. §13 is the operator's
summary.

`GIFT_CODE_REDEEM` is rate-limited to **10/hour** — the tightest bucket in the product, because this is
the only endpoint where guessing pays.

---

## 13. Managing gift codes

**From the panel** — `http://127.0.0.1:5174/gift-codes` locally, guarded by `giftcode.manage`. Mint
one, mint a batch of up to a thousand, watch a campaign drain, read its analytics, retune it, stop
it. [`admin-panel.md`](admin-panel.md) §4 is the operator's account of it.

The `curl` recipes this section used to carry were removed in M19 rather than corrected, because two
of the three no longer work and the third would teach the wrong habit:

| M18 | M19 | Why |
|---|---|---|
| `GET /admin/v1/gift-codes` returned `codes[].code` | returns `codes[].codeMasked` + `codes[].publicId` | A list of live codes turns a stolen admin cookie into the promotional budget |
| `POST /admin/v1/gift-codes/NOWRUZ1405/active` | `POST /admin/v1/gift-codes/:publicId/active` | A code in a URL path is a code in the access log — which ADR-0015 forbade and then did |
| — | `POST /admin/v1/gift-codes/batch` | Server-side CSPRNG generation; the plaintext is returned **once** and is not recoverable |

The whole of ADR-0016's reasoning is that a gift code is a **bearer secret**, not an identifier.

If you do need the API directly — a script, a partner integration — the session is still a cookie
plus a CSRF token from `POST /admin/v1/auth/login`, and `GET /admin/v1/me` returns the token again so
a long-lived script can recover it. Finding one specific code is
`GET /admin/v1/gift-codes?code=NOWRUZ1405`, matched **exactly**: an operator holding a code can find
its row and an operator holding nothing cannot enumerate a campaign.

`GET /admin/v1/audit/search?action=giftcode.` shows who minted, enabled, disabled or retuned what —
and, since M19, every refused redemption with its reason.
`payetam_gift_code_redemptions_total{result}` on `/metrics` is still the alerting surface; the
durable rows behind the panel's report are what a campaign is reported from (ADR-0016 §5).

**Length is no longer the operator's problem.** A batch draws 12 characters from a 31-character
alphabet by default — ≈ 7.7 × 10¹⁷ codes — and the 10-an-hour bucket bounds a sweep of it to longer
than any campaign lasts.

---

## 14. Mini App — screens and routes

13 screens, Vue 3 + Pinia, RTL, Jalali dates rendered from UTC **without a date library**.

| Route | Screen | Purpose |
|---|---|---|
| `/` | `SplashView` | Authenticates, then redirects by onboarding state |
| `/terms` | `TermsView` | Policy text + consent |
| `/profile` | `ProfileView` | Display name, birth year, city, district, interests |
| `/home` | `HomeView` | Hub |
| `/discover` | `DiscoverView` | Twelve filters, three sorts, keyset pagination |
| `/events/new` | `CreateEventView` | Authoring; declared **before** `/events/:publicId` or the literal is swallowed as an id |
| `/events/:publicId` | `EventDetailView` | One event, join, report. **Host's Trust Score (M18)** |
| `/events/:publicId/edit` | `EditEventView` | |
| `/my-events` | `MyEventsView` | Host's events + the request queue, accept/reject, promote, cancel. **Requester Trust Scores (M18)** |
| `/my-requests` | `MyRequestsView` | The guest's side |
| `/chats` | `ChatsView` | Conversations. **Titled «name — event» (M18)** |
| `/reviews` | `ReviewsView` | Blind reviews |
| `/wallet` | `WalletView` | Coins + ledger, Trust + ledger, invitations. **Gift-code redemption and referral sharing/status (M18)** |

Components: `EventCard`, `MainButton`, `PromotionDialog`, `ReportDialog`, `StateBlock`, `TrustBadge`
(new). `StateBlock` is the loading / empty / error trio in one place — because the copy that gets
forgotten is always the error state, which is the one a user on a mobile network actually meets.

**It only authenticates inside Telegram.** A plain browser tab has no `initData`, so screens render and
anything that calls the API answers `UNAUTHENTICATED`.

---

## 15. Dependencies and technologies

**Runtime:** NestJS 11 (`common`, `core`, `platform-fastify`), Fastify, Prisma 7 + `@prisma/adapter-pg`,
`pg`, BullMQ, `ioredis`, grammY, zod 4, `reflect-metadata`, `argon2` (admin passwords), Vue 3,
`vue-router` 4, Pinia 3, Tailwind 4, `vazirmatn`.

**Tooling:** TypeScript 5.9.3 (pinned), ESLint 10 + `typescript-eslint` 8, Prettier 3, Vitest 4, `tsx`
(seeds only — **never** the Nest apps: esbuild does not emit `emitDecoratorMetadata`, so DI silently
yields `undefined`), `vue-tsc`, `jsdom`.

**Infrastructure:** PostgreSQL 16, Redis 7, Docker Compose, nginx, `cloudflared` (dev tunnels).

**Notable absences, all deliberate:** no date library (Jalali is computed with `Intl`), no ORM beyond
Prisma, no state-management library beyond Pinia, no component library, no `class-validator` (the zod
schemas in `packages/shared` are the single validation definition), no CDN or WAF in MVP.

---

## 16. Incomplete, ambiguous or outdated

### Blocking launch

**Both blockers closed in M19.** What remains below is real and none of it blocks.

| # | What | Notes |
|---|---|---|
| ~~**B2**~~ | ~~No admin panel.~~ **CLOSED, 2026-08-21** | `apps/admin` exists: twelve screens over the API M12 built, RTL Persian, permission-aware navigation and route guards over the same `meta` the service checks again. Reports are actionable, campaigns are mintable, the ledger is searchable and reconcilable. See [`admin-panel.md`](admin-panel.md). Two admin capabilities are deliberately still API-only — break-glass unseal and four-eyes role changes — and §6 there says why |
| ~~**B4**~~ | ~~The manual privacy gate has never been run.~~ **CLOSED, 2026-08-21** | Executed and automated as `privacy-gate.int.test.ts`: two accounts created through signed `initData`, five messages across both surfaces including a real `text_mention` update, and a sweep of every response *and* every stored payload. Twenty assertions. One clause is still owed to a human — what a Telegram *client* renders — and the procedure is written down in [`b4-privacy-gate.md`](b4-privacy-gate.md) §5 |

### Real gaps that are not blockers

- **`chat_message` is not partitioned.** The plan calls for monthly partitioning from day one; it is
  deferred because Postgres requires the partition key in every unique index, which would turn
  `UNIQUE (chat_id, seq)` into `UNIQUE (chat_id, seq, created_at)` and let a chat spanning a month
  boundary carry two messages with the same `seq`.
- **Edit propagation sends a new message rather than editing the delivered copy**, because nothing
  populates `chat_message.telegram_message_ids`. Delivering the correction late is honest; the column
  exists and is unused.
- **Killing a real worker mid-delivery is not tested** (criterion 27). The interruption is simulated.
- **429 retry *timing* is grammY's**, and is not asserted here (criterion 29).
- **The restore drill was measured at development scale only** — 2 s for a 144 kB dump.
- **`initData` replay refusal is exercised but not asserted** (criterion 13). The leak scan has to
  re-sign per call *because* the guard works, which is evidence and not a test.
- **Rate limiting is `⏳` in the threat model** but is implemented and integration-tested; the status
  column is stale there.
- **Media in chat is refused** — text only in MVP, deferred to v1.1 behind a flag with `copyMessage`.
- ~~**No bulk gift-code minting and no per-code analytics.**~~ **Both built in M19** (ADR-0016).
- **A moderation case cannot be claimed or escalated from the panel**, because the API cannot:
  `moderation_case.assigned_admin_id` is written by nothing and `decideCase` takes `APPROVED` or
  `REJECTED` only. Two moderators working one queue collide on the decision and get
  `INVALID_STATE_TRANSITION`, which is honest and not friendly.
- **Break-glass unseal and four-eyes role changes have no screen.** The API has both and both are
  tested; each is a workflow that deserves designing rather than a button, and the panel does not
  mock one up (`admin-panel.md` §6).
- **No CSV export** of the ledger or the audit trail. Both are paginated reads; an export is a
  decision about where a file of user records is allowed to go, and it belongs with a retention
  answer.

### Ambiguous or misleading, and worth fixing

- ~~**`ChatsView` still says identities stay hidden «تا زمانی که خودشان نخواهند».**~~ **Rewritten in
  M19.** The disclosure now names the three identifiers that are never shown, admits the display name
  and the activity title are, and states the consequence — a host with several activities can tell two
  requests came from one person (R8). It lives in `apps/miniapp/src/copy/privacy.ts` with assertions
  over it, including one that fails if the old sentence returns.
- **Migration numbering skips `0010`** (§4). Inert, but surprising.
- ~~**`referral.status` has a `REJECTED` value that nothing ever writes.**~~ **Wired in M19** as an
  administrative act with a reason code, a signature and an audit row (migration 0019). A referral
  whose qualifying attendance simply has not happened stays `PENDING`; a referral that has already
  paid cannot be rejected at all.
- **`CoinService.penalize` writing no row when it clamps to zero** is safe only because it is always
  called inside a terminal state transition. That is a real coupling, documented in the method, and it
  would become a bug the first time a penalty is charged outside one.

### Technically outdated

- Nothing is on an unsupported version. TypeScript is **pinned** to 5.9.3 on purpose (ADR-0013).
- `docs/implementation-plan.md` §4.6 still describes an `idempotency_key` table with `key` as the
  primary key; migration 0016 built `request_idempotency` scoped to `(user_id, key)` instead, because a
  client-chosen key is not globally unique and keying on it alone would hand one caller's stored
  response to another. **Reconciled in §17.**

---

## 17. Recommendations

**Done in M19** — the first four of the previous list, in order:

1. ~~Build the admin panel (B2).~~ `apps/admin`, twelve screens ([`admin-panel.md`](admin-panel.md)).
2. ~~Run the two-account privacy gate (B4).~~ Executed, automated, documented
   ([`b4-privacy-gate.md`](b4-privacy-gate.md)) — with one live-client capture left as a pre-launch
   recommendation rather than a blocker.
3. ~~Rewrite the `ChatsView` anonymity copy.~~ Rewritten, and pinned by assertions.
4. ~~Bulk gift-code minting and per-code analytics.~~ Built, along with the reclassification of a code
   as a bearer secret (ADR-0016).
5. ~~A `REJECTED` path for referrals.~~ Wired, as an administrative act with a reason code.

**Before launch, in order:**

1. **Perform the live-client half of the privacy gate** — two real Telegram accounts, one capture of
   what a client *renders*. `b4-privacy-gate.md` §5 is the procedure, written so somebody who did not
   write it can perform it.
2. **Name owners for R1–R8** in the threat model. Every accepted risk needs one.
3. **Create the production staff accounts and provision their TOTP.** There is no self-service
   sign-up and there is not going to be one; `admin-panel.md` §1 is the procedure.
4. **Decide the network control in front of the panel** — an IP allowlist or a VPN, *in addition to*
   the login rather than instead of it.

**Shortly after:**

5. Partition `chat_message`, with the composite unique index the partition key forces.
6. Populate `telegram_message_ids` so an edit edits and a deletion deletes.
7. Kill a real worker in a test, rather than simulating it.
8. Measure a restore at production scale and re-record the number.
9. Assert the `initData` replay refusal directly.

**Worth doing when the queue gets busy:**

10. **Claim/assign and escalate on a moderation case.** The column exists and nothing writes it; two
    moderators on one queue currently collide on the decision.
11. **Screens for break-glass unseal and four-eyes role changes.** Both APIs exist and are tested;
    each is a workflow that deserves designing rather than a button.
12. Consider surfacing the Trust Score on `EventCard` in discovery, not only on the detail page. The
    field is already on the wire.
13. Feed `event.view_count` from a batched job. It is deliberately not incremented on the read path,
    because that would take a row lock on the hottest read in the product.

---

## 18. What M19 changed

Six things, and both launch blockers.

| # | Feature | Layers touched |
|---|---|---|
| 1 | **The admin panel** (B2) | `apps/admin` — 12 screens, session + CSRF, permission-aware routing; `AdminInsightService` and 13 new endpoints behind them; `GET /me` now returns the CSRF token so a reload works |
| 2 | **The B4 privacy gate** | `privacy-gate.int.test.ts` — two signed-in accounts, five messages across both surfaces, a sweep of every response and every stored payload |
| 3 | **`ChatsView`'s privacy copy** | `apps/miniapp/src/copy/privacy.ts` + assertions; threat model T2.5/R8; ADR-0014's consequences |
| 4 | **Gift-code campaigns** (ADR-0016) | Migration 0018 — `public_id`, `campaign`, `batch_id`, an analytics index; bulk minting, masked reads, `perUserLimit = 1`, per-code and per-campaign analytics; durable refusal records |
| 5 | **`referral.status = REJECTED`** | Migration 0019 — a rejection enum, four columns and two CHECKs; a transition table; `ReferralAdminService`; one new permission; `WalletView`'s third branch |
| 6 | **Development gift-code seeding** | `tools/gift-code-fixtures.ts` + `make seed-gift-codes-dev`, behind an allowlist with no production escape hatch |

**Two findings the work produced rather than assumed.** The leak scan caught the admin user-detail
page returning a raw bio — a user who typed their number into it has not consented to hand it to
staff — and it is masked now with the same `sanitizeInbound` the chat relay uses. And the privacy
gate failed three times on its first run, each time because a naive sweep cannot tell a caller's own
data from a disclosure, or a disclosure from a consent.

**Permissions grew by one**: `referral.manage`. Everything else the panel needed already had a key,
which is the evidence ADR-0010's catalogue was the right shape.

---

## 19. What M18 changed

Five features, and the documentation reconciliation that came with them.

| # | Feature | Layers touched |
|---|---|---|
| 1 | Host's Trust Score on the event page | SQL projection → domain type → view → contract → `TrustBadge` |
| 2 | Requester's Trust Score in the host's queue | Batched query keyed by `user_id` → domain → view → contract → UI |
| 3 | Conversations titled «name — event» | Chat service, contract, view, Mini App, **and the Telegram relay** (ADR-0014) |
| 4 | Gift codes | New tables + migration, domain service, admin service, permission, two API surfaces, UI, rate limit, metric (ADR-0015) |
| 5 | Referral sharing and status | UI only — the backend has been complete since M9 |

Features 1 and 2 required **no migration**: `trust_score` has existed since M9. Feature 3 required none
either: `anonymous_chat.event_id` has existed since M8, and what was missing was that nothing carried it
to the surface. Only feature 4 added tables.

**Documentation reconciled in the same pass** — see the change summary at the end of the M18 work, and
§16's "Ambiguous" list for what was deliberately left for a human.
