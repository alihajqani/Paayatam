# PayeTam (پایه‌تَم) — Master Implementation Plan

> **Status:** APPROVED 2026-08-15. This document is the single source of truth for architecture,
> invariants and scope. Any deviation requires explicit user approval and an update to this file
> plus a new ADR in `docs/adr/`.
>
> **Anchoring rule for future sessions:** read this file and `docs/adr/` before writing code.
> Do not re-derive decisions that are recorded here. Do not drift from the invariants in §5 and §7.

---

## 0. Approved Decisions (frozen)

| # | Decision | Choice | Recorded in |
|---|---|---|---|
| D1 | Backend stack | TypeScript modular monolith — NestJS + Prisma + PostgreSQL 16 + Redis + BullMQ + grammY | ADR-0001, ADR-0002 |
| D2 | Frontend stack | **Vue 3 (Composition API) + Vite + Pinia + TailwindCSS** for both Mini App and Admin | ADR-0003 |
| D3 | Mini App design | **Telegram Native Design System** — bind to `WebApp.themeParams` CSS variables; RTL-first fa-IR; native, modern, clean, responsive | ADR-0003 |
| D4 | Age model | `birth_year` (INT) only; **18+ hard block** at onboarding | ADR-0009 |
| D5 | Chat data | Text-only relay; body AES-256-GCM encrypted; **90-day** retention after chat close | ADR-0009 |
| D6 | Hosting | Single foreign VPS (Hetzner/Contabo class), Docker Compose, direct Telegram API access | ADR-0001 |
| D7 | Blind reviews | **Strictly blind.** Neither party can see the other's review while submitting. Reveal only when **both have submitted** or the **review window deadline** passes. Purpose: prevent retaliatory ratings | ADR-0011 |
| D8 | Waitlist promotion | Promote `WAITLISTED → PENDING`; host decides within `min(12h, event−3h)`. **Both** the host and the promoted participant receive an immediate Telegram Bot notification | ADR-0011 |
| D9 | Host cancellation | Symmetrical time thresholds; **×1.5** coin penalty for the host; Trust −5 / −12; **100% automatic coin refund** to all accepted participants | ADR-0011 |
| D10 | Chat edit/delete | Propagate edits to the relayed copy; on sender-delete replace with «پیام حذف شد». Original retained in DB marked redacted (evidentiary record) | ADR-0009 |
| D11 | Admin auth | Email + password (argon2id) + **mandatory TOTP 2FA**; Redis sessions; 5-attempt lockout. Separate identity system from `user` | ADR-0010 |
| D12 | Timezone | `Asia/Tehran` (fixed +03:30, no DST since 2022); **UTC in the database**; server clock only | ADR-0008 |
| D13 | Day-one scope | Tehran only; **2 categories** (café & board games, light outdoor). A third is a config change, no deploy | — |

### Sub-decisions applied under D7/D9 (flagged for override)

- **D7a** — At the deadline with only one side submitted: the submitted review **is revealed**, marked
  `EXPIRED_PARTIAL` («بدون بازخورد متقابل»), and is **excluded from Trust Score**. Rationale: the reviewer's
  effort stays visible, but a party who never showed up to review cannot unilaterally move someone's score.
  *Override this by changing `review.partial_reveal_affects_trust` in `app_setting`.*
- **D9a** — In the MVP, joining an event costs a participant **zero coins**, so the "100% automatic refund"
  path currently reverses an empty set. It is implemented generically (reverse every `coin_ledger` row where
  `ref_type='event_participant'` and `ref_id ∈ event's participants`), fully tested with a synthetic charge, and
  becomes live the moment any participant-side coin cost is introduced. **This is a real gap between the
  policy as written and what it does today — stated explicitly rather than silently no-op'd.**

---

## 1. Product Summary

A two-sided Telegram marketplace connecting people for shared activities in Tehran. Three surfaces over one
backend: **Mini App** (discover, create, profile), **Bot** (onboarding, notifications, anonymous chat,
accept/reject), **Channel** (VIP/boosted/trending), plus an **Admin Panel** (moderation, economy, audit).

The six hard problems this architecture exists to solve:

1. Transactional capacity control under concurrency (no overbooking, ever).
2. An append-only coin ledger that can never double-grant or go negative.
3. An anonymous chat relay that never leaks Telegram identity.
4. Blind review reveal that cannot be gamed.
5. Persian-aware moderation that survives ي/ك, half-space and diacritic obfuscation.
6. Cancellation penalties computed on server time across `Asia/Tehran` boundaries.

Everything else is CRUD.

---

## 2. Assumptions

**Product**
1. Tehran-only at launch; other cities exist as rows with `is_active=false` behind a feature flag.
2. Two categories live at launch; a third is config-only.
3. No real money in MVP. Coins are earned, never purchased. No payment gateway, no Telegram Stars.
4. The **host accepts or rejects** each participant. No auto-accept mode.
5. Anonymous chat is created **at request time** (`PENDING`), not at acceptance — strangers talk *before*
   identity is exchanged. This is the product's differentiator.
6. One host per activity. No co-hosts.
7. Single-occurrence events. No recurrence.
8. Chat is 1:1 host↔participant. Group chat is out of scope.
9. Boost and VIP are the only coin sinks in MVP.
10. Persian (fa-IR) only, RTL. A message catalogue, not an i18n framework.

**Technical**

11. All timestamps `timestamptz` in UTC. Business timezone `Asia/Tehran` via IANA tz, never a hardcoded offset.
12. Telegram **webhook** mode, not polling.
13. Mini App auth: Telegram `initData` → server-validated → JWT access (15 min) + refresh (7 d) in Redis.
    `Authorization: Bearer`, no cookies (Telegram WebView cookie behaviour is unreliable).
14. Admin identity is entirely separate from user identity. An admin is never a `user` row.
15. Images: local disk + nginx behind an `IStorage` interface; S3-compatible is a config swap.
16. Search: PostgreSQL FTS + `pg_trgm` with a shared Persian normalizer. No Meilisearch in MVP.
17. Single Postgres instance, no read replicas, PITR via WAL archiving.
18. `accepted_count` is denormalized on `event`, mutated only inside the transaction that holds
    `SELECT … FOR UPDATE` on that event row.
19. Users must have started the bot to receive anything. `telegram_account.bot_blocked` tracks 403s;
    the Mini App shows a re-start banner.
20. Deletion = soft delete + anonymization job. Hard `DELETE` only in the retention purge job.

---

## 3. Architecture

### 3.1 Shape

**Modular monolith**, two runtime processes plus two static SPAs. Not microservices: the whole spec is one
transactional consistency domain (capacity ↔ participants ↔ ledger ↔ chat), and the Tehran MVP traffic
profile is a rounding error for one Postgres box.

```
                Telegram
                   │
   ┌───────────────┼──────────────────────────┐
   │ webhook       │ sendMessage/copyMessage  │
   ▼               │                          │
┌─────────────────────────────┐        ┌──────────────────────┐
│ apps/api  (NestJS, N=1..n)  │        │ apps/worker (BullMQ) │
│  • /telegram/webhook/:secret│        │  • telegram-send     │
│  • /api/v1/*   (Mini App)   │        │  • domain-events     │
│  • /admin/v1/* (Admin)      │        │  • scheduled/*       │
│  • stateless, JWT           │        │  • moderation        │
└─────────────┬───────────────┘        └──────────┬───────────┘
              │                                   │
              │   packages/domain — ONE code path for bot + Mini App
              ▼                                   ▼
      ┌───────────────┐                   ┌──────────────┐
      │ PostgreSQL 16 │◄──outbox relay────│  Redis 7     │
      │ + pg_trgm     │                   │ queues·cache │
      └───────────────┘                   │ ratelimit    │
                                          └──────────────┘
   apps/miniapp (Vue 3 + Vite)      apps/admin (Vue 3 + Vite)
        served by nginx                  served by nginx
```

**Why two processes:** an HTTP request must never block on a Telegram API call. Telegram's limit is ~30 msg/s
global and 1 msg/s per chat; a burst of waitlist promotions would otherwise stall request handling.

### 3.2 Repository layout

```
payatam/
├─ apps/
│  ├─ api/            NestJS HTTP: MiniApp API, Admin API, TG webhook receiver
│  ├─ worker/         NestJS standalone app hosting BullMQ processors
│  ├─ miniapp/        Vue 3 + Vite + Pinia + Tailwind (RTL, Telegram-native)
│  └─ admin/          Vue 3 + Vite + Pinia + Tailwind
├─ packages/
│  ├─ db/             Prisma schema, migrations, seeds, PrismaService/PrismaModule
│  ├─ domain/         The 14 domain modules — imported by BOTH api and worker
│  ├─ telegram/       grammY composition, keyboards, fa message templates
│  ├─ shared/         zod schemas, DTO types, error catalogue — shared FE↔BE
│  ├─ platform/       Nest infrastructure shared by api + worker: ConfigModule,
│  │                  RedisModule, and later idempotency/rate-limit/outbox/clock
│  └─ config/         zod-validated env (framework-agnostic, no Nest imports)
├─ docker/            Dockerfiles, nginx.conf, compose files
├─ docs/              this plan, ADRs, threat model, runbooks
└─ tools/             seed-dev.ts, seed-launch.ts, anonymize.ts, backup/restore
```

pnpm workspaces + TypeScript project references. No Turborepo in MVP.

### 3.3 Domain modules

| Module | Owns | Invariant it defends |
|---|---|---|
| `identity` | User, TelegramAccount, Consent, sessions | Telegram ID never crosses the module boundary |
| `profile` | UserProfile, UserInterest | 18+ enforced at write |
| `catalog` | City, District, Category, Interest, FeatureFlag, AppSetting | All user-selectable lists are admin-managed |
| `events` | Event lifecycle, capacity, search, ranking | `accepted_count ≤ capacity` always |
| `participation` | EventParticipant, waitlist, promotion | One row per (event,user); transitions via state machine only |
| `chat` | AnonymousChat, ChatParticipant, ChatMessage, relay | No identity leaves the anonymity boundary |
| `economy` | CoinAccount, CoinLedger, TrustScore(+Ledger), Referral | Ledger append-only; balance never < 0 |
| `reviews` | Review, ReviewPair | No reveal before both-submitted or deadline |
| `moderation` | BlacklistTerm(+Version), ModerationCase, Report, PersianNormalizer | Suspicious content never reaches `PUBLISHED` |
| `notifications` | Notification, templates, dedupe | Exactly-once *effect* |
| `channel` | Telegram channel publishing | Publishes only what admin rules allow |
| `adminaccess` | AdminUser, Role, Permission, AuditLog | Deny by default |
| `platform` | Idempotency, rate limiting, outbox, request context, clock | Server clock is the only clock |
| `jobs` | Queue definitions, schedules, DLQ | Every job idempotent + retried |

`packages/domain` imports **no** HTTP and **no** grammY. Controllers and processors are thin adapters over
the same services — this is what makes "bot and Mini App behave identically" true by construction.

### 3.4 The two critical paths

**Join request (concurrency-critical)**

```
POST /api/v1/events/:id/join   (Idempotency-Key)
  └─ prisma.$transaction(ReadCommitted)
     1. SELECT * FROM event WHERE id=$1 FOR UPDATE          ← serializes all joiners
     2. assert PUBLISHED, starts_at > now(), eligibility, user != host
     3. INSERT event_participant … ON CONFLICT (event_id,user_id) DO NOTHING
        → 0 rows ⇒ 409 DUPLICATE_REQUEST
     4. accepted_count < capacity ? PENDING : WAITLISTED
     5. INSERT anonymous_chat + 2 chat_participants (aliases)
     6. INSERT outbox_event('participation.requested')
     COMMIT
  └─ 201 {status, waitlistRank?, chatPublicId}
```

Every operation that changes `accepted_count` — join, accept, cancel, promote, host-cancel — takes that same
event row lock **first**, and takes no other lock while holding it. Deadlock-free by lock ordering.

**Anonymous message relay (privacy-critical)**

```
Telegram → POST /telegram/webhook/<secret>   (X-Telegram-Bot-Api-Secret-Token verified)
  1. reject non-text (Persian refusal) — MVP is text-only
  2. normalize + scan: blacklist, phone / @username / t.me / email patterns
  3. strip ALL message entities (text_mention carries a raw user id)
  4. encrypt body (AES-256-GCM, key_version) → INSERT chat_message
  5. INSERT outbox_event('chat.message')
  → 200 always (never leak processing outcome via status code)

worker → bot.api.sendMessage(recipient, "«میهمان ۱»:\n" + text,
                             {link_preview_options:{is_disabled:true}})
```

**Never `forwardMessage`** — it carries `forward_from` with the origin user's id and name.

### 3.5 Jobs & notifications

| Queue | Purpose | Concurrency | Limiter |
|---|---|---|---|
| `telegram-send` | all outbound Telegram calls | 5 | 25/s global; per-chat 1/s |
| `domain-events` | outbox fan-out → notifications, trust, channel | 10 | — |
| `scheduled` | repeatable cron jobs | 2 | — |
| `moderation` | re-scan on blacklist version bump | 2 | — |

- **Transactional outbox** — domain events are inserted in the same transaction as the state change. A
  notification can never be lost by a crash between commit and enqueue, and never sent for a rolled-back tx.
- **Idempotency** — BullMQ `jobId` is deterministic (`notify:participant:{id}:accepted`) and
  `notification.dedupe_key` is UNIQUE. Duplicate delivery is a no-op at both layers.
- **Retries** — 5 attempts, exponential 5s→80s. Telegram 429 honours `retry_after` (`@grammyjs/auto-retry`);
  403 marks `bot_blocked` and stops.
- **DLQ** — exhausted jobs land in `job_failure`, visible and re-drivable from the admin panel.

Repeatable jobs: event lifecycle (1 min) · pending-request expiry (1 min) · waitlist promotion sweep (5 min) ·
outbox backstop (5 min) · review reminders + reveal (hourly) · no-show finalisation (daily 03:00) ·
retention purge (daily 04:00) · trust rehabilitation (daily 05:00).

### 3.6 Telegram privacy strategy — five independent layers

1. **Storage separation.** `telegram_user_id` lives only in `telegram_account`. `user.public_id` (UUID) is the
   only identifier that appears in any API response or URL.
2. **DTO allowlist.** Responses are built by explicit mappers, never by spreading an entity.
3. **Per-chat aliases.** `chat_participant.alias` is per-chat («میهمان ۱»), not per-user — the same person in
   two chats is two different aliases, so a curious host cannot correlate across chats.
4. **Entity stripping + PII redaction** on every relayed message.
5. **Automated leak test in CI** — walks every public endpoint response and fails on a Telegram-id-shaped
   integer, an `@username`, a `t.me/` link, or a phone pattern. This is the regression net for layers 1–3.

Contact exchange requires an `OPEN` chat, an explicit button, a confirmation step, and writes `consent` +
`chat_action`.

### 3.7 Frontend architecture (Vue 3)

Both SPAs: Vue 3 Composition API (`<script setup>`), Vite, Pinia, Vue Router, TailwindCSS, TanStack Query
(Vue) for server state, `vee-validate` + the shared zod schemas for forms.

**Mini App — Telegram Native Design System (non-negotiable):**

- All colour comes from Telegram `themeParams`, mapped once into CSS custom properties
  (`--tg-theme-bg-color`, `--tg-theme-text-color`, `--tg-theme-hint-color`, `--tg-theme-link-color`,
  `--tg-theme-button-color`, `--tg-theme-button-text-color`, `--tg-theme-secondary-bg-color`,
  `--tg-theme-header-bg-color`, `--tg-theme-accent-text-color`, `--tg-theme-destructive-text-color`).
  Tailwind consumes these via `theme.extend.colors`. **No hardcoded hex anywhere in components** —
  lint-enforced. The app therefore follows the user's Telegram theme instantly, light or dark.
- Native chrome instead of custom chrome: `MainButton` for the primary action on every form,
  `BackButton` for navigation, `HapticFeedback` on state changes, `showConfirm`/`showPopup` for destructive
  confirmations, `expand()` + `disableVerticalSwipes()` on mount, `viewportStableHeight` for layout.
- **RTL-first**: `dir="rtl"` at the root, logical CSS properties only (`margin-inline-start`, never
  `margin-left`), Vazirmatn as the font, and Persian digits rendered via a formatter at the view layer while
  all internal values stay Latin.
- Human-friendly by default: every list has explicit loading / empty / error / retry states; every
  destructive action confirms; every form disables its submit button while in flight (double-submit
  prevention is also enforced server-side by `Idempotency-Key`).
- Safe-area insets respected; 44px minimum touch targets; `prefers-reduced-motion` honoured.

**Admin panel:** the same Vue stack but a conventional desktop-first LTR-capable layout (data tables,
filters, bulk actions). It deliberately does **not** use Telegram theming — it is not a Telegram surface.

### 3.8 Scaling

API is stateless → scale horizontally behind nginx, sessions in Redis. Worker scales per queue
(`telegram-send` stays at 1 replica because the rate limit is global). Postgres vertical first;
`audit_log` and `chat_message` are partitioned monthly from day one so growth never forces a rewrite.

---

## 4. Data Model

PostgreSQL 16 + Prisma. Conventions: `id` = UUIDv7 PK; `public_id` = separate random UUID for external
exposure; `created_at`/`updated_at` `timestamptz NOT NULL`; soft delete via `deleted_at` unless stated;
money in **integer Toman** (never float); native PG enums.

### 4.1 Identity & profile

- **`user`** — `id` PK · `public_id` UNIQUE · `status` enum(ACTIVE, SUSPENDED, BANNED, DELETED) · `locale`
  default `fa-IR` · `timezone` default `Asia/Tehran` · `onboarding_state` enum(NEW, TERMS_ACCEPTED,
  PROFILE_COMPLETE) · timestamps · `deleted_at?`
- **`telegram_account`** — `user_id` FK UNIQUE · **`telegram_user_id` BIGINT UNIQUE NOT NULL** 🔒 ·
  `username_cached?` 🔒 · `first_name_cached?` 🔒 · `language_code?` · `bot_blocked` bool · `first_seen_at` ·
  `last_seen_at`. **Never selected outside `identity`.**
- **`user_profile`** — `user_id` PK/FK · `display_name` (2–40, moderated) · `gender?` enum(MALE, FEMALE,
  PREFER_NOT_SAY) · **`birth_year?` INT** CHECK ≥18 years old · `city_id` FK · `district_id?` FK ·
  `bio?` (≤300, moderated) · `avatar_media_id?` · `completed_at?`
- **`consent`** — `user_id` · `policy_version_id` · `accepted_at` · `ip_hash` (HMAC, never raw IP) ·
  `user_agent_hash` · `context` enum(ONBOARDING, REACCEPT, CONTACT_SHARE).
  UNIQUE `(user_id, policy_version_id, context)`. **Append-only, never deleted.**
- **`policy_document`** / **`policy_version`** — versioned TERMS / PRIVACY / COMMUNITY;
  partial UNIQUE `(type) WHERE is_current`.

### 4.2 Catalog

`city` · `district` · `category` · `interest` · `user_interest` (PK `(user_id, interest_id)`) ·
`feature_flag` (`key` PK, audited) · `app_setting` (`key` PK, jsonb value, versioned, audited) +
`app_setting_history` (append-only). **Every policy number lives in `app_setting`, not in code.**

### 4.3 Events & participation

**`event`** — `id` · `public_id` UNIQUE · `host_user_id` · `title` (3–80) · `description` (10–2000) ·
`category_id` · `city_id` · `district_id?` · `starts_at` · `ends_at` · `capacity` CHECK 1..50 ·
**`accepted_count`** default 0 · `cost_type` enum(FREE, APPROX, FIXED, SPLIT) · `cost_amount?` ·
`cost_note?` · `rules?` · `gender_preference?` · `min_age?` · `max_age?` · `image_media_id?` ·
`external_link?` · `status` · `moderation_status` · `published_at?` · `boosted_until?` · `is_vip` ·
`view_count` · `request_count` · `search_vector` tsvector · `version` INT · timestamps · `deleted_at?`

Constraints: `ends_at > starts_at` · **`accepted_count <= capacity`** · cost_amount present iff
FIXED/APPROX · `max_age >= min_age`.
Indexes: `(status, starts_at)` · partial `(city_id, category_id, starts_at) WHERE status='PUBLISHED' AND
deleted_at IS NULL` · GIN `(search_vector)` · GIN `(title gin_trgm_ops)` · `(host_user_id, created_at)` ·
partial `(boosted_until) WHERE boosted_until > now()`.

**`event_participant`** — `event_id` · `user_id` · `status` · `requested_at` · `decided_at?` ·
`accepted_at?` · `cancelled_at?` · `grace_expires_at?` · `host_deadline_at?` · `promoted_at?` ·
`cancellation_reason?` · `cancellation_bucket?` enum(GRACE, GT_24H, H24_TO_H3, LT_3H, NO_SHOW) ·
`penalty_ledger_id?` · `attended?` · `version` INT.
**UNIQUE `(event_id, user_id)`** — the duplicate-request guard, enforced by the database.
Indexes: `(event_id, status)` · `(user_id, status)` · partial `(event_id, requested_at, id) WHERE
status='WAITLISTED'`.

> **Deviation from the proposed model:** no separate `WaitlistEntry` table. A waitlisted user *is* an
> `event_participant` with `status='WAITLISTED'`; order is `(requested_at, id)` via a window function.
> Two tables would be a dual-write race across promotion/cancellation for zero benefit. Admin visibility
> and auditability are preserved by the ordering index and `audit_log`.

### 4.4 Chat

- **`anonymous_chat`** — `public_id` UNIQUE · `event_id` · `participant_id` UNIQUE · `status` enum(ANONYMOUS,
  OPEN, CLOSED, BLOCKED) · `opened_at?` · `closed_at?` · `closed_by_user_id?` · `close_reason?` ·
  `retention_expires_at?`
- **`chat_participant`** — `chat_id` · `user_id` · `role` enum(HOST, GUEST) · `alias` · `alias_index` ·
  `contact_shared_at?` · `last_read_at?`. UNIQUE `(chat_id, user_id)`, UNIQUE `(chat_id, alias_index)`.
- **`chat_message`** — `chat_id` · `sender_participant_id?` · `seq` BIGINT · `kind` enum(TEXT, SYSTEM) ·
  **`body_ciphertext` BYTEA** 🔒 · `body_nonce` · `key_version` · `redactions` jsonb · `moderation_flags`
  jsonb · `telegram_message_ids` jsonb · `edited_at?` · `deleted_at?` · `retention_expires_at`.
  UNIQUE `(chat_id, seq)`. **Partitioned monthly.** Purged 90 days after chat close.
- **`chat_action`** — append-only ACCEPT / REJECT / CLOSE / SHARE_CONTACT / BLOCK log.

### 4.5 Economy

- **`coin_account`** — `user_id` PK · `balance` INT **CHECK (balance >= 0)** · `version` · `updated_at`.
  A cache; the ledger is the truth.
- **`coin_ledger`** — `user_id` · **`idempotency_key` UNIQUE** · `type` enum · `amount` signed ≠0 ·
  `balance_before` · `balance_after` · `reason_code` · `actor_type` · `actor_id?` · `ref_type?` · `ref_id?` ·
  `reverses_ledger_id?` · `metadata` jsonb · `created_at`.
  **Append-only, enforced by a BEFORE UPDATE OR DELETE trigger that raises.** Corrections are new `REVERSAL`
  rows.
- **`trust_score`** — `user_id` PK · `score` CHECK 0..100 · `algo_version` · `updated_at`.
- **`trust_score_ledger`** — same shape (`delta`, `score_before`, `score_after`, `reason_code`,
  `algo_version`, `idempotency_key` UNIQUE). **This is what makes the score explainable: the admin panel
  renders the ledger, not a number.**
- **`referral`** — `referrer_user_id` · **`referred_user_id` UNIQUE** · `code` · `status` · `qualified_at?` ·
  `reward_ledger_id?` · `fraud_signals` jsonb. CHECK `referrer ≠ referred`.

### 4.6 Reviews, moderation, ops

- **`review`** — `event_id` · `participant_id` · `reviewer_user_id` · `reviewee_user_id` · `rating` 1..5 ·
  `tags` TEXT[] · `comment?` (≤500) · `status` enum(SUBMITTED, REVEALED, HIDDEN) · `submitted_at` ·
  `revealed_at?` · `edit_deadline_at` · `moderation_status`.
  UNIQUE `(participant_id, reviewer_user_id)`. CHECK `reviewer ≠ reviewee`.
- **`review_pair`** — `participant_id` UNIQUE · `host_review_id?` · `guest_review_id?` · `opens_at`
  (event end +24 h) · `deadline_at` (+7 d) · `status` enum(PENDING, PARTIAL, REVEALED, EXPIRED_PARTIAL,
  EXPIRED_EMPTY) · `revealed_at?`.
- **`report`** — `target_type` enum(EVENT, USER, MESSAGE, REVIEW) · `target_id` · `reporter_user_id` ·
  `reason` · `description?` · `status` · `moderation_case_id?`.
  **UNIQUE `(target_type, target_id, reporter_user_id)`** — "can't report twice", in the database.
- **`moderation_case`** — `subject_type` · `subject_id` · `trigger` enum(AUTO_BLACKLIST, REPORT_THRESHOLD,
  MANUAL) · `status` enum(OPEN, IN_REVIEW, APPROVED, REJECTED, ESCALATED) · `assigned_admin_id?` ·
  `blacklist_version?` · `matched_terms` jsonb · `report_count` · `decision?` · `decision_note?` ·
  `decided_by?` · `decided_at?` · `false_positive?`
- **`blacklist_term`** — `term_raw` · **`term_normalized`** · `pattern_type` enum(EXACT, SUBSTRING, REGEX) ·
  `severity` enum(BLOCK, FLAG) · `category` · `is_active` · `created_by`. **`blacklist_version`** — every
  `moderation_case` stores the version that judged it.
- **`notification`** — `user_id` · `channel` · `template_key` · `payload` jsonb · **`dedupe_key` UNIQUE** ·
  `status` · `attempts` · `last_error?` · `telegram_message_id?`. Retention 6 months.
- **`outbox_event`** — `aggregate_type` · `aggregate_id` · `event_type` · `payload` · `processed_at?` ·
  `attempts`. Partial index `(created_at) WHERE processed_at IS NULL`.
- **`job_failure`** — DLQ mirror. **`media`** — sha256, mime, moderation_status.
  **`idempotency_key`** — `key` PK · `request_hash` · `response_status` · `response_body` · `expires_at` (24 h).

### 4.7 Admin & audit

`admin_user` (email CITEXT UNIQUE, argon2id `password_hash`, `totp_secret_enc` 🔒, lockout fields —
**never linked to `user`**) · `role` (SUPER_ADMIN, MODERATOR, SUPPORT, ANALYST) · `permission`
(`event.moderate`, `coin.adjust`, `chat.read`, …) · `role_permission` · `admin_user_role` ·
**`audit_log`** (`actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `before`, `after`,
`ip_hash`, `request_id` — **append-only, partitioned monthly, 24-month retention**).

### 4.8 Entities added / removed vs. the original proposal

| Change | Reason |
|---|---|
| **+** `telegram_account` | Isolates the highest-value PII in one table with one access path |
| **+** `coin_account` | O(1) balance reads; ledger stays authoritative |
| **+** `outbox_event` | The only way to guarantee "state changed ⇒ notification sent" across a crash |
| **+** `idempotency_key` | Required by the idempotency mandate for mutating HTTP endpoints |
| **+** `media`, `policy_version`, `blacklist_version`, `job_failure`, `app_setting_history`, `permission`, `chat_action` | Each implied by a spec requirement (uploads, terms versioning, decision provenance, DLQ, config audit, RBAC granularity, chat audit) |
| **−** `WaitlistEntry` | Merged into `event_participant` (§4.3) |
| **−** `ReviewReveal` | Merged into `review_pair` — one row holds both sides and the deadline |
| **−** `ScheduledJob` | BullMQ repeatable jobs are the scheduler; a DB job table would be a second source of truth |

---

## 5. Invariants (never violate)

1. `accepted_count <= capacity` — DB CHECK **and** row lock. No code path may increment without the lock.
2. `coin_account.balance >= 0` — DB CHECK. Every mutation goes through `CoinService` inside a transaction.
3. `coin_ledger` and `trust_score_ledger` are **append-only**. UPDATE/DELETE raise at the trigger level.
4. One `event_participant` per `(event_id, user_id)` — DB UNIQUE, not an application check.
5. One `report` per `(target, reporter)` — DB UNIQUE.
6. One `review` per `(participant_id, reviewer)` — DB UNIQUE.
7. `telegram_user_id` never appears in an API response, a log line, or a frontend bundle.
8. No review is readable by the counterparty before `review_pair.status ∈ {REVEALED, EXPIRED_PARTIAL}` —
   enforced at the **API layer**, not the UI.
9. All time comparisons use the server clock. No endpoint accepts a client-supplied timestamp for policy.
10. Every state transition goes through `assertTransition()` and writes `audit_log`.
11. Every outbound Telegram call goes through the `telegram-send` queue, never inline in a request.
12. Every mutating admin action requires a permission check **in the service layer** and writes `audit_log`.

---

## 6. APIs

Base: `/api/v1` (Mini App, Bearer JWT) · `/admin/v1` (Admin, session + CSRF) ·
`/telegram/webhook/:secret` (Telegram only).
Error envelope: `{ error: { code, messageFa, details? } }` — `code` stable and machine-readable,
`messageFa` user-facing Persian. Mutating endpoints accept `Idempotency-Key`; replay returns the stored
response with `Idempotency-Replayed: true`.

**Auth/onboarding** — `POST /auth/telegram` · `POST /auth/refresh` · `GET /policies/current` ·
`POST /onboarding/consent` · `POST /onboarding/profile` · `GET /me`
**Discovery** — `GET /catalog` · `GET /events` (q, cityId, districtId, categoryId, dateFrom/To, timeOfDay,
hasCapacity, costType, costMax, genderPreference, ageFits, sort, cursor≤50 — keyset pagination) ·
`GET /events/:publicId` · `GET /events/:publicId/explain-rank`
**Events** — `POST /events` · `PATCH /events/:publicId` · `POST /events/:publicId/cancel` ·
`GET /events/:publicId/participants` · `POST /events/:publicId/boost` · `POST /events/:publicId/report`
**Participation** — `POST /events/:publicId/join` · `POST /participants/:id/accept` ·
`POST /participants/:id/reject` · `POST /participants/:id/cancel` (+`?dryRun=true` to power the
confirmation dialog) · `GET /me/participations`
**Chat** — `GET /chats` · `GET /chats/:publicId/messages` · `POST /chats/:publicId/messages` ·
`POST /chats/:publicId/close` · `POST /chats/:publicId/share-contact`
**Reviews/economy** — `GET /me/reviews/pending` · `POST /participants/:id/review` ·
`GET /users/:publicId/reviews` · `GET /me/coins` · `GET /me/trust` · `GET /me/referral` ·
`POST /referrals/claim`
**Bot** — `/start [payload]` · `callback_query: chat:accept|reject|close:<id>` · `message:text` relay ·
`edited_message` propagation · `my_chat_member` block detection
**Admin** — login (email+password+TOTP) · dashboard · users · events + moderation queue · reports ·
blacklist · catalog · policies · settings · coin ledger + `POST /admin/v1/coins/adjust` · trust ledger ·
audit log · roles · **`POST /admin/v1/chats/:id/unseal`** (break-glass, see §8)

---

## 7. State Machines

Transitions are declared as tables in `packages/domain/<module>/state-machine.ts` and enforced by a single
`assertTransition()`. Illegal transition ⇒ 409. Every transition writes `audit_log`.

**Event**
```
 DRAFT ─► PENDING_MODERATION ─► PUBLISHED ─┬─► HIDDEN ─► PUBLISHED | REJECTED
              └─► REJECTED                 ├─► CANCELLED_BY_HOST
                                           ├─► ONGOING ─► COMPLETED
                                           └─► EXPIRED     (start passed, 0 accepted)
 any ─► DELETED (soft)
```
Sensitive edit while PUBLISHED → back to PENDING_MODERATION. 3rd distinct report → HIDDEN + case.

**EventParticipant**
```
 (none) ─► PENDING ──────► ACCEPTED ─► COMPLETED
    │        │ │ │             │ └──► NO_SHOW
    │        │ │ │             └────► CANCELLED_BY_HOST | CANCELLED_BY_PARTICIPANT
    │        │ │ └► EXPIRED (host_deadline_at passed)
    │        │ └──► CANCELLED_BY_PARTICIPANT
    │        └────► REJECTED
    └─► WAITLISTED ─► PENDING   (promotion; sets host_deadline_at; notifies BOTH parties)
             └─────► CANCELLED_BY_PARTICIPANT | EXPIRED
```
`ACCEPTED → CANCELLED_BY_PARTICIPANT` inside `grace_expires_at` ⇒ bucket `GRACE`, zero penalty.

**AnonymousChat**
```
 ANONYMOUS ─► OPEN ─► CLOSED        (OPEN on host accept)
     └──────────────► CLOSED        (reject / cancel / either party closes)
 any ─► BLOCKED                     (moderation)
```
CLOSED and BLOCKED are terminal; both set `retention_expires_at = now() + 90d`.

**ModerationCase**
```
 OPEN ─► IN_REVIEW ─► APPROVED | REJECTED
            │ ▲
            └─┴── ESCALATED ─► IN_REVIEW
```
Terminal states require `decided_by` + `decision_note`.

**Review / ReviewPair**
```
 ReviewPair: PENDING ─► PARTIAL ─► REVEALED
                 │          └────► EXPIRED_PARTIAL   (deadline, one side — D7a)
                 └───────────────► EXPIRED_EMPTY     (deadline, neither side)
 Review:     SUBMITTED ─► REVEALED ─► HIDDEN         (moderation)
```
Edit allowed only while SUBMITTED and before `edit_deadline_at` (1 h). **No read path exposes a
counterparty review before reveal.**

---

## 8. Security & Privacy

### Threat model

| # | Threat | Control |
|---|---|---|
| T1 | Forged `initData` | HMAC-SHA256 with key `HMAC("WebAppData", botToken)`, constant-time compare; `auth_date` ≤5 min; hash cached in Redis as a one-time nonce (replay defence) |
| T2 | Telegram identity leak | The five layers of §3.6 + CI leak test |
| T3 | IDOR | Every query filtered by actor; random `public_id` in URLs; ownership asserted in the service |
| T4 | Overbooking | `SELECT … FOR UPDATE` + `CHECK (accepted_count <= capacity)` |
| T5 | Coin duplication | `idempotency_key` UNIQUE + `CHECK (balance >= 0)` + append-only trigger + single transaction |
| T6 | Referral farming | One referrer per user (UNIQUE); reward only after the referred user completes onboarding **and attends one event**; velocity limits; `fraud_signals` for admin review |
| T7 | Webhook forgery | Secret path + `X-Telegram-Bot-Api-Secret-Token` constant-time compare + optional CIDR allowlist |
| T8 | Admin privilege escalation | Deny-by-default RBAC checked in the service layer; four-eyes on role changes; everything audited |
| T9 | XSS | Vue escapes by default; **`v-html` banned repo-wide (lint-enforced)**; bot HTML templates pass every user value through a unit-tested `escapeHtml()` |
| T10 | SQL injection | Prisma parameterises; raw SQL only via tagged `$queryRaw`; CI grep for concatenated SQL |
| T11 | SSRF | `external_link` is stored and displayed, **never fetched server-side**; https-only; no link-preview fetching |
| T12 | Spam / abuse | Redis token buckets per user + IP + endpoint class; events 5/day; joins 20/day; messages 30/min; reports 10/day |
| T13 | Malicious upload | Magic-byte sniffing, ≤5 MB, dimension caps, **re-encode with sharp**, **SVG rejected**, random storage key, strict CSP |
| T14 | Admin reading chats | Break-glass: `chat.read` **+** an open `moderation_case` **+** a written reason ⇒ 15-minute grant; every message read audited individually; weekly digest to SUPER_ADMIN |
| T15 | Secrets in logs | pino with a redaction allowlist; `telegram_user_id`, tokens, `initData`, phone, message bodies never logged; CI test asserts the redactor |
| T16 | Backup exfiltration | Backups encrypted (age/gpg), stored off-box, restore drill rehearsed in M16 |

### Encryption

TLS 1.3 everywhere. LUKS full-disk on the VPS **plus** application-level AES-256-GCM for chat bodies and
TOTP secrets, key from `CHAT_ENCRYPTION_KEY` (32-byte base64, env-injected, never in the repo),
`key_version` column for rotation.

> **Honest limitation (do not overclaim to users):** application-level encryption protects **database dumps,
> backups and a stolen disk**. It does **not** protect against a compromised application server, which by
> design holds the key.

### Sensitive data & retention

| Data | Protection | Retention |
|---|---|---|
| `telegram_user_id`, username | Module-isolated, never serialized, never logged | Purged on deletion |
| Chat message bodies | AES-256-GCM, versioned key | **90 d after chat close** → hard purge |
| `birth_year` | Year only; exposed as an age *band* | Life of account |
| Phone number | **Never stored** — relayed in-chat after explicit consent only | n/a |
| IP address | **Never stored raw** — HMAC-hashed with a server pepper | 24 months |
| Audit log | Append-only, partitioned | 24 months |

### Legal risks requiring human review (flags, not legal advice)

1. Storing private interpersonal messages of Iranian users; lawful basis and disclosure obligations.
2. Platform liability for offline harm arising from in-person meetings between strangers.
3. **18+ is self-declared, not verified.** Residual risk of a minor on the platform is real and must be a
   documented, accepted decision.
4. Gender-based filtering — a safety feature here, a discrimination concern elsewhere. Optional, never
   mandatory, never in public DTOs.
5. Data-subject deletion/anonymization must be **built** (M15), not promised.
6. **Telegram ToS** on relaying user messages and channel automation. A violation means instant bot
   termination — a total product outage. Needs a human read of current terms before launch.
7. A defined escalation path for illegal content (including CSAM) must exist before chat goes public.

---

## 9. Milestones

Complexity: **S** ≈ ½–1 d · **M** ≈ 2–3 d · **L** ≈ 4–6 d · **XL** ≈ 7–10 d.
Every milestone ends with: tests green, `pnpm typecheck` clean, docs updated, report in the required template.

| M | Name | Cx | Depends on |
|---|---|---|---|
| 0 | Architecture decisions & preparation | S | — |
| 1 | Skeleton & configuration | M | 0 |
| 2 | Authentication & onboarding | L | 1 |
| 3 | Profiles, interests & ledger primitives | M | 2 |
| 4 | Event creation & auto-moderation | L | 3 |
| 5 | Discovery & search | L | 4 |
| 6 | **Participation & capacity** | XL | 5 |
| 7 | Waitlist | M | 6 |
| 8 | **Anonymous chat** | XL | 6 |
| 9 | Coins & Trust Score | L | 3, 6 |
| 10 | Cancellation & penalties | L | 9 |
| 11 | Blind reviews | M | 10 |
| 12 | Reports & admin moderation | L | 4, 8 |
| 13 | Notification jobs | M | 6, 7, 11 |
| 14 | Telegram Channel integration | S | 9, 12 |
| 15 | Security hardening | L | all |
| 16 | Observability, deployment, backups | L | 15 |
| 17 | Seed data & launch checklist | M | 16 |

**Critical path:** M1→M2→M3→M4→M6→M8→M9→M10. **M6 (capacity) and M8 (anonymous chat) must not be rushed.**
Rough total ≈ 55–70 working days for one engineer.

### Milestone detail

**M0 — Architecture decisions & preparation** · *S*
Goal: freeze decisions before any code. Files: `docs/implementation-plan.md`, `docs/adr/0001…0012` +
`docs/adr/README.md`, `docs/threat-model.md`, `docs/glossary-fa.md`, `README.md`. Migrations: none.
Tests: none (documentation milestone; verification is a link-integrity and completeness check).
Acceptance: every decision in §0 has an ADR; all four originally-open questions resolved; every internal
doc link resolves. Rollback: `git revert`. Risks: none.

Add **ADR-0012 (Persian normalization and search)**, which owns the shared normalization pipeline used
identically by moderation (M4) and search (M5).

**M1 — Skeleton & configuration** · *M*
Goal: the repo boots end-to-end with no features in it. Files: `pnpm-workspace.yaml`, root `package.json`,
`tsconfig.base.json`, `apps/api` (NestJS bootstrap, health, global filter/interceptor/pipe), `apps/worker`,
`packages/config` (zod env schema, **fails fast on missing vars**), `packages/db` (PrismaService),
`packages/shared`, `docker-compose.yml`, `.env.example` (**placeholders only**), `Makefile`, ESLint/Prettier,
Vitest, CI workflow.
Migration `0001_init`: extensions `pg_trgm`/`unaccent`; `app_setting`, `feature_flag`, `audit_log`.
APIs: `GET /health` (liveness), `GET /ready` (readiness — checks Postgres + Redis).
Tests: health/readiness logic; config rejects a bad environment; error catalogue is total over its codes.
Acceptance: `docker compose up` → both processes healthy; `pnpm check` passes.
Rollback: `git revert` + drop the dev volume.

**Deviations from this plan, decided during M1:**

- **`packages/platform` added** to the layout. `ConfigModule` and `RedisModule` are needed identically by
  `apps/api` and `apps/worker`; putting them in either app would have meant duplicating them in the other.
- **`audit_log` monthly partitioning deferred to M15**, where the retention jobs live. Prisma cannot express
  partitioning, so it needs hand-written SQL that Prisma's schema diffing then reports as drift on every
  subsequent migration. The table holds zero rows until M2 and little until M12, so converting it later is
  cheap — whereas fighting the diff engine from M1 onward is not.
- **No `ValidationPipe`.** Nest's pipe requires class-validator, which would be a second validation system
  alongside the zod schemas that ADR-0003 makes the single source of truth for FE↔BE contracts. A zod-based
  pipe over `@payetam/shared` arrives in M2 with the first DTO.
- **TypeScript pinned to 5.9.3, not 7.x.** TS 7 was verified to emit `design:paramtypes` correctly, so
  NestJS DI would work — but `typescript-eslint@8` declares `typescript >=4.8.4 <6.1.0`, and the lint layer
  enforces real architectural invariants (module boundaries, no floating promises). Revisit when
  typescript-eslint supports TS 7.

**M2 — Authentication & onboarding** · *L*
Files: `packages/domain/identity/*` (`InitDataValidator`, `SessionService`, `ConsentService`),
`packages/telegram/*`, webhook + auth controllers. Migration `0002_identity`: `user`, `telegram_account`,
`policy_document`, `policy_version`, `consent`.
Tests: valid initData accepted; **tampered hash rejected; expired `auth_date` rejected; replayed hash
rejected**; consent idempotent under 10 concurrent calls; banned user blocked; webhook rejects a wrong
secret token. Acceptance: `/start` creates exactly one user; the terms gate blocks every other endpoint.

**Deviations from this plan, decided during M2:**

- **`policy_document` merged into `policy_version`.** A document row would have held
  nothing but a type. "Exactly one current version per type" is instead a partial
  unique index — a stronger guarantee than a parent row would have provided.
- **Partial unique index is invisible to Prisma.** `@@unique([type], where: …)` is
  rejected by the schema parser (`@@index` accepts `where`, `@@unique` does not), so
  `migrate diff` reports it as drift and `migrate dev` would drop it. Kept anyway —
  it is the only race-proof enforcement — and CI now fails if it or either
  append-only trigger goes missing from a freshly migrated database.
- **`consent` is append-only by trigger** and its FK to `user` is RESTRICT, not
  CASCADE: account deletion anonymises (M15); it must not erase the record that
  consent was given.
- **Replay defence is separate from signature checking.** `InitDataValidator` is
  pure (no Redis, no DI), so the cryptography is unit-testable with no
  infrastructure; `InitDataReplayGuard` owns the Redis one-time-use claim.
- **`packages/domain` added** to the workspace, plus `Clock` in `packages/platform`
  (ADR-0008) so time-dependent policy is testable without sleeping.

**M3 — Profiles, interests & ledger primitives** · *M*
Files: `packages/domain/profile/*`, `catalog/*`, minimal `apps/miniapp` (Vue onboarding wizard, RTL,
Telegram theming). Migration `0003_profile_catalog` + a minimal ledger slice (`coin_account`, `coin_ledger`)
— **moved forward from M9 because the onboarding reward cannot be idempotent without it**.
Tests: 18+ block; interest outside the admin list rejected; **concurrent double profile-completion grants
exactly one reward**; inactive city rejected.

**Deviations from this plan, decided during M3:**

- **The 18+ rule is a service-layer check, not a DB CHECK.** §4.1 asks for `birth_year` with a
  CHECK for being ≥18 years old. Postgres refuses non-IMMUTABLE functions in a CHECK constraint, so
  `now()` cannot appear in one — the rule is inherently a question about today. It is enforced in
  `ProfileService` against the injected `Clock` (ADR-0008), which is also what makes the boundary
  testable without waiting a year. The table keeps a plausibility CHECK (`1900..2200`) that catches a
  Jalali year submitted where a Gregorian one was expected.
- **Year granularity rounds in the admitting direction.** With a birth *year* and no date, someone
  whose birthday has not yet arrived counts as a year older. Collecting a full birth date is the only
  way to do better and is more personal data than the question needs (ADR-0009). The Mini App's
  Jalali→Gregorian year label leans the same way, so client and server never disagree at the boundary.
- **`user_profile.avatar_media_id` deferred.** The `media` table it references does not exist until
  uploads land. A column with no foreign key would be an invitation to write an unvalidated id into it.
- **`coin_ledger` is stricter than §4.5 requires.** Three CHECKs were added because each is free at
  write time and expensive to discover later: `balance_after = balance_before + amount`,
  `(type = 'REVERSAL') = (reverses_ledger_id IS NOT NULL)`, and UNIQUE on `reverses_ledger_id` — which,
  because Postgres treats NULLs as distinct, reads as "a row can be reversed at most once". Its
  append-only trigger has **no retention escape hatch**, unlike `audit_log` and `consent`: deleting a
  ledger row would break reconciliation permanently.
- **`AuditService` added** (`packages/domain/audit`), global module. Invariant 10 applies to every
  module, so the writer is available everywhere rather than being a reason to skip the audit row.
- **`INVALID_DISTRICT` added to the error catalogue.** A district that belongs to another city is a
  distinct, actionable mistake; folding it into `VALIDATION_FAILED` would tell the user nothing.
- **Integration-test harness added** (`test/integration/`), and CI's integration job now builds the
  workspace first. The suite TRUNCATEs every table, so it honours `TEST_DATABASE_URL` (`make db-test`)
  and only falls back to `DATABASE_URL` — loudly — when that is unset.
- **Mini App ships without TanStack Query and vee-validate.** ADR-0003 names both, and both stay in the
  plan. Neither earns its bytes on a two-screen wizard with one form: validation is
  `completeProfileRequest.safeParse` against the same shared schema the API uses, which is the property
  the ADR actually cares about. They arrive with the first list screen (M5), which is where caching,
  retries and field-level async validation start paying.
- **T5.1's `v-html` ban is enforced by CI grep, not ESLint.** It lands here rather than later because
  this is the milestone that introduces `.vue` files — a ban that arrives after the components it
  governs protects nothing. ESLint does not parse `.vue` files in this repo, so a lint rule would have
  silently covered nothing.
- **A pre-existing CI bug was fixed here:** the "reject string-concatenated SQL" step matched Prisma's
  own generated client, which the same job generates two steps earlier — so the check had been failing
  since M1 on code nobody wrote. It now matches call sites and skips generated output.

**M4 — Event creation & auto-moderation** · *L*
Persian normalizer rules, each a pure function with its own test table: Arabic ي/ك → Persian ی/ک · ZWNJ
(نیم‌فاصله) folding · diacritic removal · Arabic-Indic → Latin digits · whitespace collapse · repetition
collapse (سسسلام → سلام) · homoglyph mapping.
Tests: **~40 Persian strings** (clean / dirty / obfuscated / false-positive-prone) → expected verdict;
a flagged event never publishes; the decision records the blacklist version.
Risk: **false positives block legitimate hosts** → `severity=FLAG` (queue, don't block) is the default for
ambiguous terms; `moderation_case.false_positive` tracks the rate.

**Deviations from this plan, decided during M4:**

- **"A flagged event never publishes" above contradicts ADR-0012, and the ADR wins.** ADR-0012 defines
  `FLAG` as "publishes, but opens a moderation case" and `BLOCK` as "never publishes, straight to
  `PENDING_MODERATION`". The ADR owns this decision, states it twice, and gives the reasoning — a false
  positive that blocks a legitimate host is worse than a queue entry — which is also what this section's
  own Risk line argues ("queue, don't block"). Implemented as the ADR specifies. **The sentence above is
  the one to change if that reading is wrong**, because reversing it means FLAG stops publishing.
- **`assertTransition` is a shared helper** in `packages/domain/state-machine.ts`, with per-module
  transition tables as §7 describes. Staying in a state is not a transition and is not asserted — a table
  with self-loops could no longer answer "is this state terminal".
- **A tenth normalization rule.** ADR-0012 lists nine; `foldCase` was added, because without it a
  Latin-script blacklist term matches only the casing a moderator happened to type.
- **The homoglyph rule was reinterpreted.** ADR-0012 asks for "confusable Latin/Cyrillic characters →
  their Persian equivalents". Perso-Arabic shares no glyph shapes with Latin or Cyrillic, so every such
  mapping would be invented, and a wrong one corrupts legitimate mixed-script titles. The rule instead
  folds the genuine confusables — Urdu, Kurdish and Pashto letterforms — and a companion rule strips
  Latin/Cyrillic characters *inserted* inside a Perso-Arabic word. **Substitution** (`مشrوب`, where `r`
  stands in for `ر`) is a documented gap, pinned in the verdict table.
- **`event.search_vector` and the GIN/trigram indexes are M5**, not here. They need the tsvector column
  and belong to discovery. M4 adds `title_normalized` / `description_normalized`, which the M5 trigger
  reads — the alternative was re-implementing ADR-0012's normalizer in PL/pgSQL, i.e. the exact
  duplication the ADR exists to prevent.
- **`event.image_media_id` deferred**, as `user_profile.avatar_media_id` was in M3: the `media` table it
  references does not exist yet.
- **§4.3's `WHERE boosted_until > now()` partial index is not expressible.** Postgres requires an index
  predicate to be IMMUTABLE. Built as `WHERE boosted_until IS NOT NULL`, which prunes to the same rows;
  the freshness comparison moves into the query.
- **`event.created_at` is written from the injected `Clock`, not the column default.** The daily quota
  filters `created_at` against a window derived from `Clock`; leaving the column to the database's
  `now()` meant the filter and the rows it filtered came from two different sources of time, which the
  Tehran-midnight boundary test caught (ADR-0008).
- **`moderation_case.matched_terms` never contains the scanned text** — only the rules that fired. The
  case points at its subject, and the subject is where the text lives (ADR-0009).
- **REGEX blacklist patterns carry a ReDoS risk with no clean mitigation.** JavaScript has no regex
  timeout. Bounded by a 200-character pattern cap (CHECK), a 4000-character subject cap, and per-call
  compilation with an invalid pattern logged and skipped rather than failing event creation. **M12's
  admin UI must validate patterns before storing them.**
- **No Mini App work.** M4's file list is backend only; the event-authoring screen is not built.

**M5 — Discovery & search** · *L*
Tests: each filter independently; keyset pagination has **no duplicates and no gaps** while rows are
inserted mid-scan; a Persian query with ي/ك and half-space variants matches; **the CI response-leak scan
lands here**; a brand-new host with default trust still reaches page 1 for a matching query.
Acceptance: p95 < 200 ms on 10k seeded events.

**M6 — Participation & capacity** · *XL*
Tests (the heart of the suite): **20 concurrent joins on capacity=5 ⇒ exactly 5 accepted, 15 waitlisted,
`accepted_count=5`**, against real Postgres via Testcontainers, repeated 50×; duplicate ⇒ 409; host cannot
join own event; accept after the last seat vanished ⇒ `CAPACITY_EXCEEDED`; illegal transitions ⇒ 409.

**M7 — Waitlist** · *M*
Tests: FIFO by `(requested_at, id)`; **two concurrent cancellations promote two distinct people, never the
same person twice**; promotion idempotent on job retry; expired promotion moves to the next.
**Per D8: both host and promoted participant are notified immediately** — asserted in tests.

**M8 — Anonymous chat** · *XL*
Tests: relayed message contains no username/phone/telegram-id and **no `forward_from`**; entities stripped
(a `text_mention` carrying a user id must not survive); phone/username/t.me patterns masked; **aliases differ
for the same user across two chats**; non-member 403; closed chat rejects sends; encryption round-trips and
the raw column is unreadable; edit propagation (D10); a blocked bot marks `bot_blocked` without retry storms.
Acceptance: two dev Telegram accounts converse with zero leakage, verified against raw Telegram payloads.
**Highest-risk milestone** — leak tests are written *before* the relay; manual verification is a release gate.

**M9 — Coins & Trust Score** · *L*
Tests: balance never negative; **concurrent spends of the last coins ⇒ exactly one succeeds**; ledger rows
immutable (UPDATE/DELETE raise); reversal restores the balance exactly; referral requires attendance;
self-referral rejected; trust clamps to [0,100]; **sum of ledger deltas = current score**.
Acceptance: a reconciliation test over 1000 random operations proves `balance == SUM(amount)`.

**M10 — Cancellation & penalties** · *L*
Tests: a **parameterised table across every threshold** — inside grace, 25 h, 23 h, 3 h 01 m, 2 h 59 m,
no-show — each asserting exact coin + trust deltas; **`Asia/Tehran` boundary tests**; a manipulated client
clock has zero effect (the endpoint accepts no client timestamp); **host cancellation refunds 100% and
notifies everyone (D9)**. Rollback: set penalties to 0 in `app_setting` — no deploy needed.

**M11 — Blind reviews** · *M*
Tests: **the counterparty review is unreadable before reveal — asserted at the API layer, not the UI (D7)**;
both submitted ⇒ immediate reveal; deadline with one side ⇒ `EXPIRED_PARTIAL` (D7a); duplicate ⇒ 409;
editing after reveal ⇒ 409; the T+24 h notification fires once even if the job runs twice.

**M12 — Reports & admin moderation** · *L*
Tests: the same user cannot report twice (DB-enforced); the **3rd distinct** reporter hides the event and
opens a case (threshold read from config, also tested at 2 and 4); the owner is notified **without any
reporter identity**; **an RBAC matrix test — every role × every admin endpoint**; SUPPORT cannot adjust
coins; chat unseal without an open case is denied.

**M13 — Notification jobs** · *M*
Tests: a crash between commit and enqueue still delivers (kill the relay mid-flight, restart, assert
delivery); duplicate job ids ⇒ one message; 429 honours `retry_after`; 403 marks `bot_blocked` and stops;
exhausted retries land in `job_failure` and are re-drivable.

**M14 — Telegram Channel** · *S* — only PUBLISHED + approved events publish; no duplicate post per event
per kind; a hidden event's post is deleted; the post body contains no host identity.

**M15 — Security hardening** · *L* — rate limits, helmet/CSP, log redactor, anonymization + retention jobs.
Tests: the redactor asserted against every sensitive field name; the response-leak scan across every
endpoint; upload rejects a polyglot and an SVG; anonymization leaves no PII and no dangling FKs; the purge
deletes exactly the expired rows and nothing else.

**M16 — Observability, deployment, backups** · *L* — pino + request ids; `/metrics` (queue depth, job
failures, p95, join-conflict rate); nightly `pg_dump` + WAL archiving with **an actually-rehearsed restore
recorded with a real duration**; graceful shutdown draining in-flight jobs.

**M17 — Seed data & launch checklist** · *M* — 20–30 founding-team events; **the seed script refuses to run
when `NODE_ENV=production` unless `ALLOW_PROD_SEED=1` AND an interactive typed confirmation is given, and it
writes an audit row**; feature flags set to Tehran + 2 categories; the Launch Readiness Report.

---

## 10. MVP Acceptance Criteria

**Successful flows** — (1) onboarding grants coins **exactly once**; (2) a clean event publishes and appears
in discovery within 5 s; (3) a Persian keyword search with ي/ك and half-space variants finds it; (4) host and
guest exchange ≥5 messages with **zero identity leakage, verified against raw Telegram payloads**;
(5) acceptance opens the chat and increments `accepted_count`; (6) contact sharing requires explicit
confirmation and writes `consent`; (7) T+24 h reviews reveal simultaneously.

**Error flows** — (8) a blacklisted title never publishes and the case records the blacklist version;
(9) a full event returns `WAITLISTED` with a correct rank; (10) under-18 refused with a clear Persian
message; (11) media in chat gets a Persian refusal and stores nothing; (12) every error carries a stable
`code` and a Persian `messageFa`.

**Unauthorized** — (13) tampered/expired/replayed initData ⇒ 401; user A cannot read B's chat,
participations, coins or reviews; (14) a non-host cannot accept/reject/cancel/edit; (15) the RBAC matrix
matches exactly; (16) a wrong webhook secret is rejected without processing.

**Duplicates** — (17) two joins ⇒ one row + 409; (18) two consents ⇒ one row; (19) two reports ⇒ one row +
409; (20) two reviews ⇒ one row; (21) a replayed `Idempotency-Key` returns the identical stored response
with no second side-effect.

**Concurrency** — (22) 20 concurrent joins on capacity=5 ⇒ exactly 5/15/`accepted_count=5`, 50× with zero
failures; (23) two concurrent accepts for the last seat ⇒ one `CAPACITY_EXCEEDED`; (24) two concurrent
cancellations ⇒ two **distinct** promotions; (25) concurrent spends of the last coins ⇒ exactly one succeeds;
(26) concurrent profile completions ⇒ exactly one reward.

**Recovery** — (27) killing the worker mid-delivery and restarting delivers exactly once; (28) a crash
between commit and enqueue still delivers via the outbox; (29) 429 retried per `retry_after`, 403 stops;
(30) exhausted retries are visible and re-drivable; (31) a restore from last night's backup reproduces a
working system, timed and documented; (32) every job produces the same end state when run twice.

---

## 11. Policy Defaults (all in `app_setting`, runtime-changeable)

| Setting | Default |
|---|---|
| Onboarding reward | **+50** coins |
| Referral | **+30** referrer / **+10** referred, **after the referred user attends 1 event** |
| Completed review | **+10** coins |
| Boost 24 h | **−40** coins · VIP placement **−100** |
| Cancel 24–3 h | **−15** coins, trust **−3** |
| Cancel <3 h | **−40** coins, trust **−8** |
| No-show | **−60** coins, trust **−15** |
| Host cancellation | participant penalties **×1.5**, trust **−5** (>24 h) / **−12** (<24 h), **100% refund to accepted participants (D9/D9a)** |
| Grace period | **15 min** after acceptance, zero penalty |
| Trust start / range | **50** / 0–100 |
| Trust: profile complete | **+5** · attendance **+2** (cap +2/day) |
| Trust: reviews | 5★ **+3** · 4★ **+1** · 3★ **0** · 2★ **−2** · 1★ **−5** |
| Trust: moderation warning | **−10** |
| Trust: rehabilitation | **+1 per 30 clean days** toward 50 — nothing is permanent |
| Ranking weights | time-proximity .35 · popularity .20 · recency .15 · boost .15 · **trust .10 (capped)** · interest-match .05; new hosts get a neutral bucket, never excluded |
| Report threshold | **3** distinct users → auto-hide |
| Event quota | 5/day/user, 3 concurrent active |
| Host response deadline | `min(24h, event−3h)` → `EXPIRED` |
| Waitlist promotion deadline | `min(12h, event−3h)` |
| Review window | opens T+24 h, deadline T+7 d, edit window 1 h |

---

## 12. Known Conflicts Between Spec and Reality

1. **"Encryption at rest" + "admins can read messages"** — resolved by scoping the claim honestly (§8).
2. **"Trust Score in ranking" vs "no unfair discrimination"** — resolved by capping trust at 10% of the
   ranking score and giving new users a neutral bucket.
3. **"Reveal reviews at the deadline" vs blind-review fairness** — resolved by D7/D7a.
4. **"Store messages for moderation" vs data minimisation** — resolved at 90 days. Trade-off: abuse reported
   after 90 days has no evidence.
5. **Telegram Bot API limits** (~30 msg/s global, 1 msg/s per chat) make "notify everyone instantly"
   impossible at scale. The queue limiter makes it *eventually and reliably* instead.
6. **A user who blocks the bot cannot be notified at all.** No backend fix exists; the Mini App shows a
   re-start banner.
7. **18+ is self-declared, not verified.** Accepted residual risk, consciously documented.
8. **Telegram ToS risk** on message relaying and channel automation — a violation means total outage.
9. **D9a** — the "100% refund" currently reverses an empty set because joining costs nothing in MVP.

---

## 13. Infrastructure Cost (MVP, ≤5k MAU, ≤500 events/week)

Production VPS 4 vCPU/8 GB ≈ **€14–16/mo** · off-box encrypted backups ≈ **€4/mo** · staging VPS ≈ **€5/mo** ·
domain ≈ **$12/yr** · TLS free (Let's Encrypt) · error tracking free tier.
**Total ≈ €25/month (~$28).** Growth step (separate DB host + 2 API replicas) ≈ €45–55/mo.
Caveat: sanctions may complicate signup and payment with foreign providers — an operational, not technical,
blocker.

---

## 14. Verification Strategy

- **Per milestone:** `pnpm typecheck && pnpm lint && pnpm test` (Vitest unit) and `pnpm test:integration`
  (Testcontainers Postgres + Redis — **real DB, real locks; nothing transactional is ever mocked**).
- **Concurrency (M6/M7/M9):** the 20-concurrent-joins and concurrent-promotion/spend tests run 50 iterations
  in CI. **These must never be quarantined or retried-until-green.**
- **Privacy (M5/M8/M15):** the automated response-leak scan runs on every endpoint in CI from M5 onward,
  plus a manual two-real-accounts chat test with raw payload inspection as the M8 release gate.
- **Time policy (M10):** parameterised threshold + `Asia/Tehran` boundary tables with an injected fake clock.
- **E2E (M17):** Playwright drives the Vue Mini App against a seeded stack through
  onboarding → create → discover → join → chat → accept → cancel → review.
- **Pre-launch manual gate:** full happy path with two real dev Telegram accounts on staging, then the
  backup restore drill with its real duration recorded in `docs/disaster-recovery.md`.
