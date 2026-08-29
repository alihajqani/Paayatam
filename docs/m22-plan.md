# M22 — Product, admin and mini-app upgrades

**Target release: `v0.3.0`. Branch: `feature/v0.3.0-product-and-admin-upgrades`.**

This is the plan the M22 work is executed against, written after auditing the tree at
`47c732a` (M21). It records what already exists, what is genuinely missing, and the safest
backward-compatible shape for each addition.

| Read this for | Go here instead for |
|---|---|
| What M22 adds and why | [`implementation-plan.md`](implementation-plan.md) — the original plan through M21 |
| The migration and the new tables | [`admin-panel.md`](admin-panel.md) — how the panel is built |
| The new permissions | [ADR-0010](adr/0010-admin-auth-rbac-and-break-glass.md) — why staff identity is separate |

---

## 1. Audit — what is already there

Everything below was read rather than assumed. It is the reason most of M22 is an
*extension* rather than a new subsystem.

### 1.1 Shape

A pnpm workspace, four applications and six packages.

| Where | What |
|---|---|
| `apps/api` | NestJS on Fastify. `/api/v1` (Bearer JWT), `/admin/v1` (cookie + CSRF), `/telegram/webhook/:secretPath`, `/health`, `/ready`, `/metrics` |
| `apps/worker` | NestJS standalone + BullMQ. **The only process that talks to Telegram** |
| `apps/miniapp` | Vue 3 + Vite + Pinia + Tailwind 4, RTL, themed entirely from `--tg-theme-*` |
| `apps/admin` | Vue 3 + Vite + Pinia + Tailwind 4, RTL, its own palette with a dark variant |
| `packages/domain` | Every business rule. Both apps and the bot call the same services |
| `packages/shared` | Zod contracts + the error catalogue, imported by backend *and* both frontends |
| `packages/platform` | Clock, logger + redactor, metrics, Redis, queues, rate limiter |
| `packages/db` | Prisma 7 schema, migrations, generated client |
| `packages/telegram` | Message templates, keyboards, escaping — no network calls |

### 1.2 What M22 can reuse instead of rebuilding

- **Coins.** `CoinService.apply` is already atomic, already idempotent on a UNIQUE
  `coin_ledger.idempotency_key`, already refuses an overdraft with `INSUFFICIENT_COINS`,
  and already joins a caller's transaction. Phase 5 needs three settings and three call
  sites, not a new ledger.
- **Settings.** `SETTING_DEFAULTS` in `catalog/settings.service.ts` is the runtime-tunable
  numbers table (`app_setting`), seeded create-only by `tools/seed-settings.ts`. The three
  new coin costs belong there.
- **Queues + rate limiting.** `telegram-send` already carries a global BullMQ limiter at
  25 msg/s, `DEFAULT_JOB_OPTIONS` already gives five attempts with exponential backoff, and
  `TelegramClient` already honours `retry_after` through `@grammyjs/auto-retry` and
  classifies 403 / "chat not found" as terminal. Phases 4 and 11 enqueue onto it.
- **Job failures.** `WorkerFactory` mirrors every exhausted job into `job_failure` and
  alerts once per throttle window.
- **Telegram alerting.** `TelegramLoggerService` already exists (M20) with per-key
  throttling, suppressed counts, `redact()` on every field, direct send (not through the
  queue), and a silent-disable when `MONITORING_CHAT_ID` is unset. Phase 7 extends it.
- **Policies and consent.** `policy_version` (versioned, `is_current` partial unique per
  type) and `consent` (append-only by trigger, `UNIQUE(user, version, context)`) already
  exist. Phase 8 adds the *authoring* half.
- **Geography.** `province` (31) and `city` (1,252) already exist with `is_active`,
  `sort_order` and `province_id`. Phase 9 adds the admin screen and the user's city change.
- **Audit.** `AuditService.record` writes an append-only trigger-protected row and takes a
  transaction client. Every new admin mutation uses it.
- **RBAC.** Permissions are strings in `packages/shared/contracts/permissions.ts`, granted
  to roles in `domain/adminaccess/permissions.ts`, asserted in the *service* layer
  (`access.assertPermission`), and re-checked by an RBAC matrix test.

### 1.3 What is genuinely missing

| Gap | Phase |
|---|---|
| No "edit profile" — `POST /onboarding/profile` is the only writer, and the Mini App exposes it once, during onboarding | 2 |
| No admin profile editing at all | 2 |
| Creating an event, posting to the channel and inviting people are all free | 5 |
| No channel/group membership requirement, and no place to configure the channel beyond `TELEGRAM_CHANNEL_ID` | 6 |
| No way to send a Telegram message from the panel | 4 |
| No targeted invitation mechanism; the channel publisher is the only outbound promotion | 11 |
| Policies are seed-only; no draft, no publish, no archive, no acceptance history screen | 8 |
| Cities are seed-only in the panel (`CatalogAdminService` covers categories and explicitly excludes cities); a user cannot change their city after onboarding | 9 |
| Telegram id/username invisible in the panel even to `SUPER_ADMIN` | 12 |
| No logo, no version display, no balance on the home screen, no home button | 10 |
| `GET /catalog` ships ~190 KiB of cities on every cold open; the Mini App refetches it per screen | 3 |

---

## 2. The migration

**One additive migration, `00000000000021_m22_product_upgrades`.** No column is dropped,
renamed or narrowed. No existing default changes. Everything new is nullable or has a
default, so the migration is safe against a populated production database and needs no
backfill.

### 2.1 New enums

| Enum | Values |
|---|---|
| `policy_status` | `DRAFT`, `PUBLISHED`, `ARCHIVED` |
| `admin_message_status` | `DRAFT`, `CONFIRMED`, `QUEUED`, `SENDING`, `COMPLETED`, `PARTIALLY_FAILED`, `FAILED`, `CANCELLED` |
| `admin_message_recipient_status` | `PENDING`, `SENT`, `RATE_LIMITED`, `BLOCKED`, `INVALID`, `FAILED`, `SKIPPED` |
| `event_invitation_status` | `PENDING`, `SENT`, `BLOCKED`, `INVALID`, `FAILED`, `SKIPPED` |

### 2.2 New columns

| Table | Column | Type | Why |
|---|---|---|---|
| `policy_version` | `status` | `policy_status` NOT NULL DEFAULT `'PUBLISHED'` | Every existing row *is* published; the default is what makes the migration a no-op for them |
| | `title_fa` | text NULL | A document has a title distinct from its type |
| | `change_summary_fa` | text NULL | "What changed in this version" |
| | `created_by_admin_id` | uuid NULL → `admin_user` ON DELETE SET NULL | Who drafted it |
| | `published_by_admin_id` | uuid NULL → `admin_user` ON DELETE SET NULL | Who signed for it |
| | `archived_at` | timestamptz NULL | |
| | `updated_at` | timestamptz NOT NULL DEFAULT now() | Drafts are edited |
| | `revision` | int NOT NULL DEFAULT 0 | Optimistic concurrency on a draft |
| `consent` | `policy_version_label` | text NULL | The exact version identifier, snapshotted — a legal record must not depend on a join to a row somebody could later archive |
| | `request_id` | text NULL | Correlation id |
| | `app_version` | text NULL | Safe client context |
| `telegram_account` | *(none)* | | Already carries `username_cached` and `bot_blocked` |

Two CHECKs are added to `policy_version`, both of which every existing row already
satisfies: a `PUBLISHED` row must have `published_at`, and `is_current = true` implies
`status = 'PUBLISHED'`. The existing partial unique index on `(type) WHERE is_current` keeps
enforcing "one active version per type".

### 2.3 New tables

**`admin_message_campaign`** — one send operation from the panel, whether to one user or
many.

```
id uuid pk, public_id uuid unique, idempotency_key text unique,
kind admin_message_kind ('DIRECT' | 'BROADCAST' | 'EVENT_INVITE'),
status admin_message_status default 'DRAFT',
body_text text,                    -- the message, needed to send it and to answer "what did we send?"
parse_mode text null,              -- 'HTML' only where the project already supports it
filter jsonb,                      -- the selection, as data (no raw PII)
estimated_recipients int,
counts jsonb default '{}',         -- queued/sent/rate_limited/blocked/invalid/failed
created_by_admin_id uuid → admin_user restrict,
confirmed_by_admin_id uuid null, cancelled_by_admin_id uuid null,
event_id uuid null → event set null,
dry_run boolean default false,
created_at, confirmed_at, started_at, finished_at, cancelled_at
```

**`admin_message_recipient`** — one row per intended delivery. `UNIQUE(campaign_id, user_id)`
is the duplicate guard; the row is the idempotency record for its own job.

```
id uuid pk, campaign_id → cascade, user_id → user restrict,
status admin_message_recipient_status default 'PENDING',
attempts int default 0, last_error text null,
telegram_message_id int null, sent_at timestamptz null,
created_at
UNIQUE(campaign_id, user_id); INDEX(campaign_id, status)
```

**`event_invitation`** — the top-20 mechanism's own record, separate from the campaign so
"has this person already been invited to this event?" is a unique index rather than a scan
of jsonb.

```
id uuid pk, event_id → event cascade, user_id → user restrict,
campaign_id → admin_message_campaign set null,
score int, score_breakdown jsonb,        -- explainable, non-sensitive
status event_invitation_status default 'PENDING',
created_at, sent_at
UNIQUE(event_id, user_id); INDEX(event_id, created_at)
```

**`event_channel_config`** — the channel/group users may be required to join. A singleton
row (`id` CHECK = `'default'`) rather than `app_setting`, because `SettingsService` is typed
`Record<string, number>` and bending it to hold a URL would weaken the one guarantee it has.

```
id text pk check (id = 'default'),
chat_identifier text null,      -- @username or -100…; never a token
public_username text null,
invite_url text null,           -- normalised https://t.me/… only
membership_required boolean default false,
required_actions text[] default '{}',   -- 'EVENT_CREATE','EVENT_JOIN','EVENT_CHANNEL_SEND','EVENT_INVITE'
verify_via_telegram boolean default true,
updated_by_admin_id uuid null, created_at, updated_at
```

`membership_required` defaults to **false**, so the migration cannot lock anybody out.

### 2.4 New indexes

| Index | For |
|---|---|
| `city_name_trgm_idx` GIN `gin_trgm_ops` on `city.name_fa` | Server-side search over 1,252 cities |
| `city_province_name_idx` on `(province_id, name_fa)` | The admin city list, ordered |
| `user_profile_city_idx` on `(city_id)` | Top-20 candidate selection by city |
| `event_participant_user_event_idx` on `(user_id, event_id)` | Participation-history term in the score |
| `admin_message_recipient_pending_idx` partial on `(campaign_id)` WHERE `status = 'PENDING'` | The dispatcher's claim query |
| `audit_log_action_idx` on `(action, created_at)` | Legal-audit filtering |

---

## 3. New permissions

Added to `packages/shared/contracts/permissions.ts` and granted in
`domain/adminaccess/permissions.ts`. Each is separate from the ones next to it for the
reason ADR-0010 keeps `coin.adjust` away from `SUPPORT` — the capability, not the job title.

| Key | Held by | Why its own permission |
|---|---|---|
| `user.profile.edit` | `SUPER_ADMIN` | Editing somebody's profile is a write; `user.read` is a read, and support holds the second |
| `message.send` | `SUPER_ADMIN` | Sending a Telegram message to a user is not user management |
| `message.broadcast` | `SUPER_ADMIN` | Reaching every user at once is a different blast radius from reaching one |
| `user.telegram.read` | `SUPER_ADMIN` | The highest-value PII in the product (ADR-0009) |
| `policy.read` | `SUPER_ADMIN`, `MODERATOR`, `SUPPORT` | Reading the terms is not publishing them |
| `policy.publish` | `SUPER_ADMIN` | Publishing is the legally significant act; `policy.manage` (existing) covers drafts |
| `policy.consent.read` | `SUPER_ADMIN` | Acceptance history is per-user evidence |
| `channel.manage` | `SUPER_ADMIN` | Turning on a membership requirement can lock out every user |

`policy.manage` already exists and keeps its meaning: create and edit drafts.
`catalog.manage` already exists and gains cities.

---

## 4. New API routes

### Mini App (`/api/v1`)

| Route | Notes |
|---|---|
| `PATCH /me/profile` | Partial profile update. Absent field = unchanged |
| `GET /me/policies` | Which current documents this user has and has not accepted |
| `POST /me/policies/accept` | Re-acceptance, `REACCEPT` context |
| `GET /cities?query=&provinceId=` | Server-side city search, public, cached |
| `GET /me/channel-membership` | Requirement state + this user's verified status |
| `POST /me/channel-membership/check` | Re-verify server-side (rate limited) |
| `GET /events/:publicId/invite-preview` | Candidate count, selected count, cost, balance |
| `POST /events/:publicId/invite-top` | Charge 10 and queue; `Idempotency-Key` honoured |
| `POST /events/:publicId/publish-to-channel` | Charge 15 and queue |
| `GET /version` | Public. Release string only |

### Admin (`/admin/v1`)

| Route | Permission |
|---|---|
| `PATCH /users/:publicId/profile` | `user.profile.edit` |
| `GET /users/:publicId/telegram` | `user.telegram.read` |
| `POST /messages/preview` | `message.send` (+ `message.broadcast` for a filter) |
| `POST /messages` | as above — creates a `DRAFT`/dry-run |
| `POST /messages/:publicId/confirm` | as above — the explicit confirmation |
| `POST /messages/:publicId/cancel` | as above |
| `GET /messages`, `GET /messages/:publicId` | `message.send` |
| `GET /policies`, `GET /policies/:id` | `policy.read` |
| `POST /policies`, `PATCH /policies/:id` | `policy.manage` |
| `POST /policies/:id/publish`, `POST /policies/:id/archive` | `policy.publish` |
| `GET /policies/:id/consents` | `policy.consent.read` |
| `GET /cities`, `POST /cities`, `PATCH /cities/:id`, `POST /cities/reorder` | `catalog.manage` |
| `GET /provinces`, `POST /provinces`, `PATCH /provinces/:id` | `catalog.manage` |
| `GET /channel-config`, `PUT /channel-config` | `channel.manage` |
| `GET /version` | any authenticated staff session |

---

## 5. New worker jobs

All on the existing `telegram-send` queue, so they share the one global 25/s limiter.

| Job | What it does |
|---|---|
| `admin-message-dispatch` (on `scheduled`) | Claims `PENDING` recipients of a `SENDING` campaign in batches and enqueues one send job each. Bounded per pass, so a 50k broadcast does not build a 50k-deep Redis queue in one go |
| `admin-message-send` | One recipient. Deterministic job id `msg-<campaignId>-<recipientId>`. Terminal on `BLOCKED`/`INVALID`; throws on retryable so BullMQ backs off |
| `event-invite-send` | One invitation. Same discipline, keyed on `invite-<eventId>-<userId>` |
| `event-channel-post` | One paid channel publication for a specific event, distinct from the existing `channel-sync` sweep |

**Circuit breaker.** A per-campaign consecutive-rate-limit counter in Redis; past a
threshold the campaign is paused (`status` stays `SENDING`, dispatch stops claiming) and one
alert fires. An admin resumes or cancels.

---

## 6. Decisions taken, and the ones that need product confirmation

### Taken

1. **A charge is successful when its transaction commits.** Event creation charges inside
   the same transaction as the row, so a rejected event is never charged. Channel send and
   top-20 charge when the work is *accepted and durably queued*, not when Telegram confirms —
   because Telegram confirmation is per-recipient and partial by nature.
2. **Partial delivery is not refunded; zero delivery is.** If a queued campaign reaches zero
   recipients (everybody blocked, everybody ineligible), the charge is reversed through
   `CoinService.reverse`, which is idempotent by `reverses_ledger_id`. Anything above zero
   stands: the operation the user paid for was performed.
3. **Fewer than 20 eligible recipients sends to however many there are, and still costs 10.**
   Zero eligible recipients **does not charge** — the preview shows the count first, and the
   charge is skipped rather than reversed.
4. **Dry-run and preview never charge and never send.** They are `GET`-shaped work behind a
   `POST` and are recorded as `dry_run = true` campaigns so an operator can see what was
   rehearsed.
5. **Membership verification fails *open* on a Telegram outage** — `getChatMember` timing out
   does not lock a user out. It fails *closed* only on an authoritative "not a member".
6. **A user who accepted an older policy version keeps their access to everything except the
   actions the product gates**, and is shown the new document on next open. The gate is
   `TERMS_NOT_ACCEPTED` on the same guard that already enforces first acceptance.
7. **Admin profile editing exists, behind its own permission, and never touches
   `completed_at` or the onboarding state.**

### Need product confirmation

| Question | Assumption taken |
|---|---|
| Should the 15-coin channel send be charged to the host, or is channel publishing still automatic and free via `channel-sync`? | Both: the existing free `channel-sync` sweep (VIP/boost/trending) is unchanged, and the new *explicit* "send my event to the channel" action costs 15 |
| Which actions require channel membership? | Configurable, default empty, requirement off |
| Should broadcasts be available to `MODERATOR`? | No — `SUPER_ADMIN` only, until asked otherwise |
| Retention for `admin_message_campaign.body_text` | Kept; it is operational evidence, not user content. Not covered by the 90-day chat purge |

---

## 7. Environment and deployment

New variables, all optional, all documented in `.env.example` and
`.env.production.example` with placeholder values:

| Variable | Default | Purpose |
|---|---|---|
| `MONITORING_CHAT_ID` | *(exists)* | Operational alert group |
| `MONITORING_ALERT_COOLDOWN_SECONDS` | *(exists, 300)* | Alert throttle |
| `MONITORING_ENABLED` | `1` | Kill switch, separate from "is it configured" |
| `MONITORING_MIN_LEVEL` | `warn` | Floor on what is forwarded |
| `PAYETAM_VERSION` | `local` | *(exists)* Now also passed as a Docker build arg into both frontend builds so the version display is not hard-coded |

`docker/Dockerfile` gains `ARG PAYETAM_VERSION` in the build stage, exported as
`VITE_APP_VERSION`; `docker/docker-compose.prod.yml` passes it to the `web` target.

No secret is added to the database. `TELEGRAM_BOT_TOKEN` stays environment-only, is never
selected into any response, and is never written to `event_channel_config`.

---

## 8. Tests

New suites, in the projects that already exist:

| Project | Added |
|---|---|
| `unit` | Score calculation and tie-breaking, message-length/format validation, invite-link normalisation, version resolution, policy state machine |
| `integration` | Profile partial update + authorisation, admin profile edit + audit, coin charges (success / insufficient / retry / concurrent / zero-recipient reversal), campaign lifecycle + permissions + idempotency, invitation selection + eligibility + 20-cap, policy publish/immutability/acceptance/API bypass, city CRUD + references + duplicate slug, channel membership states |
| `miniapp` | Edit-profile form validation, wallet balance states, home button, city picker search |
| `admin` | New route permissions in the router guard |

**No test sends a real Telegram message.** A `FakeTelegramGateway` is injected in place of
`TelegramClient`, and the worker tests assert against its recorded calls.
