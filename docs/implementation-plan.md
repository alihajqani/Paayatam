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

**Deviations from this plan, decided during M5:**

- **The search seam is an interface, not a direct Postgres call.** ADR-0012 keeps a Meilisearch swap cheap;
  what that buys concretely is that `DiscoveryService` decides *what a viewer may see* and knows nothing
  about tsvectors, trigrams or keyset SQL. A second provider satisfies `SearchProvider` and nothing else.
- **The ranking score is defined once**, in `scoreSql`, and used by both `search` and `explain-rank`. A
  second copy for the explain endpoint would be a formula that drifts from the one that actually ranks,
  which makes "explain" a lie.
- **The trust term is in the formula from day one as a constant 0.5**, rather than added in M9. The weight
  is therefore real, configurable and visible in `explain-rank` immediately, and M9's change is a constant
  becoming a column read rather than a re-derivation of the ranking. A constant is also exactly the
  "neutral bucket" §11 requires for new hosts.
- **`view_count` is deliberately not part of popularity.** Incrementing it on every detail read would take
  a row lock on `event` — the same row M6 locks for capacity — and putting a write on the hottest read
  path to feed a ranking signal is a bad trade. A batched job can feed it later.
- **Cursors carry a frozen `epoch` and are not signed.** The epoch is the subtle part: relevance depends on
  `now()`, so without freezing it at the first page every later page re-ranks against a slightly later
  clock and the total order shifts underneath the cursor. Signing is unnecessary — a tampered cursor can
  only produce a wrong page of data the caller is already allowed to see.
- **A cursor whose sort disagrees with the request is rejected**, not silently restarted. Changing sort
  mid-pagination makes the key meaningless (a score compared against a timestamp), and starting over
  quietly would look exactly like the duplicate-rows bug keyset pagination exists to prevent.
- **Text relevance is `GREATEST(ts_rank, similarity)`, not a sum**, and the query runs through
  `plainto_tsquery('simple', …)`. Postgres has no Persian stemmer, so `simple` plus trigram similarity
  covers what stemming would have; `GREATEST` stops an exact phrase match being beaten by a document that
  scores mediocrely on both measures.
- **The response-leak scan lives in `apps/api/src`, not `test/`.** It boots the real application, so it
  needs the API's own `@nestjs/platform-fastify`, which the workspace root does not carry. It imports the
  **compiled** `dist/app.module.js` because NestJS DI reads `design:paramtypes`, which `tsc` emits and the
  test runner's esbuild transform does not — importing the source leaves every constructor parameter
  unresolvable.
- **The leak scan authenticates as a different user from the one carrying the identifiers.** Signing in as
  the leaky user makes `GET /me` return that user's own bio and phone, and the scan then fails on data the
  caller wrote about themselves. That is not a leak, and a test that calls it one gets silenced rather than
  fixed. Every response the scan reads is now what a stranger sees of somebody else.
- **`test/integration/setup.ts` now points `DATABASE_URL` at the test database** when `TEST_DATABASE_URL`
  is set. `createTestPrisma` already preferred the test URL, but the booted application builds its client
  from `DATABASE_URL` like any other process — without this, that one test would truncate and re-seed a
  developer's development database while every other test used the test one.
- **A real bug the projection test caught:** `toDiscoveredEvent` spread the SQL row, which carried the
  internal ranking `score` onto an object whose type does not declare it — a spread defeats TypeScript's
  excess-property check. The wire mapper maps field by field and would not have passed it on, which is
  exactly why it was worth removing at the source: a leak that only one layer stops is one layer from being
  a leak. The test asserts the projection as an **exact set**, because `not.toHaveProperty(…)` keeps
  passing when a new column arrives, and the next leak is always a column nobody thought about.
- **The p95 test is a regression guard, not a benchmark.** It catches the class of change that turns a
  query into a sequential scan — a dropped index, a predicate wrapped in a function so the index no longer
  applies — which shows up as a jump from tens to hundreds of milliseconds on any hardware. Measured
  locally at **57 ms** for a mixed browse/filter/search set over 10k events, and **14 ms** for page 20,
  against the 200 ms budget. It runs `ANALYZE` after seeding, or the planner would be choosing from
  guesses and the test would be measuring the missing statistics rather than the indexes.
- **No Mini App work.** The list and detail screens are not built; M5 is the API and its provider.

**M6 — Participation & capacity** · *XL*
Tests (the heart of the suite): **20 concurrent joins on capacity=5 ⇒ exactly 5 accepted, 15 waitlisted,
`accepted_count=5`**, against real Postgres via Testcontainers, repeated 50×; duplicate ⇒ 409; host cannot
join own event; accept after the last seat vanished ⇒ `CAPACITY_EXCEEDED`; illegal transitions ⇒ 409.

**Deviations from this plan, decided during M6:**

- **`accepted_count` counts seats *held*, which means PENDING and ACCEPTED.** The column name reads as
  "people accepted", but two independent parts of this plan force the wider meaning: the join flow in §5
  admits a request as PENDING only while `accepted_count < capacity` and waitlists it otherwise, and
  ADR-0011 has a cancellation free a seat that promotion then fills with a **PENDING** row. If a pending
  request held no seat, the first rule would admit everybody and the second would have nothing to free.
  The consequence worth stating: an undecided request keeps a seat out of circulation, which is what makes
  `host_deadline_at` load-bearing rather than a nicety.
- **"Accept after the last seat vanished ⇒ `CAPACITY_EXCEEDED`" is unreachable, by construction.** Given
  the rule above, a PENDING request has held its seat since it was made, so accepting one cannot overbook;
  and `WAITLISTED → ACCEPTED` is not a legal transition, so there is no path that accepts a row holding no
  seat. The property the line is protecting is real and is enforced where it *is* reachable — at join,
  which is what the 20-concurrent-joins test proves, and by the `CHECK` constraint, which has its own test.
  The guard remains in `accept()` for the day a future path accepts something that holds no seat.
- **`WAITLISTED → ACCEPTED` is deliberately absent from the state machine.** A host looking at a waitlist
  would plausibly expect to pick someone off it, and allowing that would quietly undo ADR-0011's FIFO
  promotion — being third in the queue would stop meaning anything. A host who wants a particular person
  gets them when the queue reaches them.
- **`event_participant.public_id` added.** §4.3's field list omits it, but §6 puts participant ids in URLs
  (`POST /participants/:id/accept`) and §4's own conventions say anything exposed externally carries a
  separate random UUID. The internal id stays time-ordered and behind the backend (invariant 7).
- **The lock helper is shared, and it is the only `FOR UPDATE` in the product.** ADR-0006 asks for exactly
  one documented helper; `packages/domain/events/event-lock.ts` is it. Reaching the lock from a participant
  id uses `FOR UPDATE OF e`, which locks the event row and only the event row even though the query joins
  through `event_participant` — so rule 2 (one lock, never a second) holds on every path.
- **`EventService.update` now takes the event lock when `capacity` changes.** M4 left this to M6 in a
  comment, and M6 is what makes it reachable: lowering capacity reads `accepted_count` to validate against,
  and a join committing in that window could leave `accepted_count > capacity`. The CHECK would turn that
  race into a 500 rather than into overbooking — better, but still wrong. The lock is conditional because
  an edit that leaves capacity alone cannot move either side of the comparison.
- **The exception filter moved from `main.ts` into `AppModule` (`APP_FILTER`).** It was registered in
  `bootstrap()`, so anything else composing `AppModule` — specifically M5's response-leak scan — ran without
  it and got Nest's generic 500 in place of the error catalogue. The scan had therefore been reading
  generic error bodies rather than the product's own envelope since M5. The guard was already wired through
  `APP_GUARD` in the module; the filter now sits beside it.
- **`EVENT_FULL_NO_WAITLIST` is still unused.** The join flow always waitlists a full event, so nothing
  raises it. It stays in the catalogue for a host-level waitlist toggle, which is not in this plan.
- **Penalties are recorded but not charged.** `cancellation_bucket` is written at cancellation time, so
  M10 judges a penalty against the thresholds that applied when the participant cancelled rather than
  whatever `app_setting` holds when the job runs. A request that never held a seat gets no bucket:
  withdrawing from a queue costs nothing.
- **Expiry is implemented as a domain method, not a job.** `expireOverdue` sweeps each event in its own
  transaction under its own lock — sweeping many in one transaction would hold several event locks at once,
  which is exactly what rule 2 forbids. Scheduling it is M13's repeatable job.
- **No chat, no outbox, no notifications.** §5's join flow lists both; `anonymous_chat` is M8 and the
  outbox is not in the schema yet. The join path is otherwise as drawn.

**M7 — Waitlist** · *M*
Tests: FIFO by `(requested_at, id)`; **two concurrent cancellations promote two distinct people, never the
same person twice**; promotion idempotent on job retry; expired promotion moves to the next.
**Per D8: both host and promoted participant are notified immediately** — asserted in tests.

**Deviations from this plan, decided during M7:**

- **The transactional outbox lands here, not in M13.** M7's own test list requires both parties to be
  notified, and ADR-0005 says a notification is only safe if it commits with the state change that caused
  it. Migration 0007 therefore adds `outbox_event` and promotion writes to it inside the promoting
  transaction. This is the **producer** half only: the relay, the BullMQ queues, `notification.dedupe_key`
  and delivery remain M13. What M7 buys is the half that cannot be retrofitted — the row being there,
  exactly when the change is.
- **One domain event per promotion, naming both parties**, rather than two rows. `outbox_event` is shaped
  as a domain-event log (`aggregate_type`/`aggregate_id`/`event_type`), and §3.5 describes the
  `domain-events` queue as an *outbox fan-out → notifications*. One row makes ADR-0011's "a crash cannot
  deliver one and lose the other" true by construction; splitting it into two notifications is the
  consumer's job, and `notification.dedupe_key` is what makes each exactly-once.
- **Promotion runs inside the transaction that freed the seat, under the lock it already holds.** That
  placement *is* the safety argument for "two concurrent cancellations promote two different people": the
  second cancellation cannot see a stale queue because it waits for the first. It also means promotion
  takes no lock of its own, which is what keeps ADR-0006's rule 2 (one lock, never a second) true.
- **Every seat release promotes, not only a cancellation.** ADR-0011 describes the cancellation case;
  rejection and expiry free a seat just as much, and a queue that only moves for one of the three would
  leave seats empty for no reason a user could understand. Expiry promoting is also what makes the plan's
  own "expired promotion moves to the next" work.
- **A promoted request gets `min(now + 12h, starts_at − 3h)`**, from the new `waitlist.*` settings, rather
  than the 24 hours a fresh request gets. Kept as separate keys from `participation.*` even though the
  second number matches today, because ADR-0011 names them separately and they are tuned against
  different things.
- **`participation.requested/accepted/rejected` outbox events added**, closing the M6 deviation that
  deferred §5's `INSERT outbox_event('participation.requested')` for want of a table.
- **Test files were not typechecked, and now are.** `tsc -b` exists to emit `dist`, so every package
  tsconfig excludes `*.test.ts` — correct for the build, but it meant test files were never typechecked at
  all. That is how a test calling this milestone's changed constructor with the old arity survived
  `pnpm typecheck`; the suite caught it, but at runtime and a step later than it should have.
  `tsconfig.typecheck.json` now covers them and runs as part of `pnpm typecheck`, and therefore in CI.
  It is separate from `tsconfig.eslint.json` because that project sets `allowJs` and includes `*.mjs` so
  typed linting can see `eslint.config.mjs` — running `tsc` over an ESM config file under this repo's
  CommonJS module setting reports `import.meta` errors that are not real. Six pre-existing errors were
  fixed to turn it on: `exactOptionalPropertyTypes` distinguishes "absent" from "present and undefined", so
  the tests that pair a city with no district now omit the key through an `inputWithoutDistrict` helper
  rather than passing `districtId: undefined`; a vitest `it.each` case tuple is stated explicitly because
  `it.each` infers it from the callback, which ignored the third element; and the leak scan's optional
  `body` is a record rather than `unknown`, since narrowing `unknown` leaves `null`, which `inject` will
  not take.

**M8 — Anonymous chat** · *XL*
Tests: relayed message contains no username/phone/telegram-id and **no `forward_from`**; entities stripped
(a `text_mention` carrying a user id must not survive); phone/username/t.me patterns masked; **aliases differ
for the same user across two chats**; non-member 403; closed chat rejects sends; encryption round-trips and
the raw column is unreadable; edit propagation (D10); a blocked bot marks `bot_blocked` without retry storms.
Acceptance: two dev Telegram accounts converse with zero leakage, verified against raw Telegram payloads.
**Highest-risk milestone** — leak tests are written *before* the relay; manual verification is a release gate.

**Deviations from this plan, decided during M8:**

- **`chat_message` is not partitioned, though §4.4 and §3.8 both ask for monthly partitioning from day
  one.** Postgres requires the partition key to appear in every unique index on a partitioned table, so
  `UNIQUE (chat_id, seq)` would become `UNIQUE (chat_id, seq, created_at)` — and a conversation spanning a
  month boundary could then hold two messages with the same `seq`, which is the property that makes
  "everything after seq N" a correct incremental read. Retention is keyed on **chat close**, not on message
  age, so monthly partitions could never be dropped wholesale anyway; the purge is an indexed DELETE on
  `retention_expires_at` either way. Deferred to M15 with the retention jobs, where `audit_log`'s
  partitioning already waits for the reason M1 gave.
- **`anonymous_chat.next_seq` added to §4.4's field list.** It is the `seq` allocator:
  `UPDATE … SET next_seq = next_seq + 1 RETURNING` is one statement, so two senders serialise on the row's
  implicit write lock. `MAX(seq) + 1` races under READ COMMITTED and needs a retry loop, and an explicit
  `SELECT … FOR UPDATE` would have been the second one in a product that has exactly one on purpose
  (ADR-0006, and M6's "the only `FOR UPDATE` in the product").
- **`chat_message.source_telegram_message_id` added.** §4.4 gives `telegram_message_ids`, which maps our
  message to the *outbound* per-recipient copies; D10's edit path needs the opposite direction — an
  `edited_message` update names a message in the sender's own conversation with the bot. A partial index on
  `(sender, source id)` makes that a lookup rather than a scan.
- **The lock ordering is event → chat, never the reverse**, and it is what keeps ADR-0006's rule 2 true.
  `createForParticipant`, `openForParticipant` and `closeForParticipant` run inside the transaction that
  already holds the event lock and take none of their own; chat transactions take no event lock at all.
  Creating the chat under the event lock is also what makes alias numbering safe without any locking of its
  own — every joiner of an event serialises there, so two simultaneous requests cannot both become «میهمان ۳».
- **An alias is scoped to the *event*, not to the chat's two seats.** §4.4's `UNIQUE (chat_id, alias_index)`
  is satisfied by host 0 / guest 1, but that would name every guest «میهمان ۱» — and the host receives every
  relayed message in one Telegram conversation, so they could not tell five guests apart. The guest index is
  the position of their chat within the event. ADR-0009's anti-correlation property is *stronger* under this
  reading, not weaker: the alias is a function of (event, arrival order) and of nothing about the person, so
  every event's first guest is «میهمان ۱» and the number carries no information about who it is.
- **A non-member gets 404, not the 403 this section's test list names.** A 403 confirms that a chat with
  that id exists, and confirming the existence of a private conversation to somebody outside it is itself a
  disclosure. It is the same call T3.3 already forced on events and participants, and the test asserts the
  404.
- **`chat_message.redactions` stores kinds and counts, never the removed text.** §8 says phone numbers are
  never stored, and the sanitizer runs *before* the cipher — so what is encrypted is what the recipient saw,
  and the masked original exists nowhere. This follows M4's precedent that `moderation_case.matched_terms`
  records the rules that fired rather than the scanned subject. The consequence to state plainly: moderation
  can see that a contact exchange was attempted and how often, but not what the number was.
- **Masking is switched off per sender once they complete the contact-sharing consent.** ADR-0009 masks
  "during the anonymous stage" and puts exchange behind "an explicit button, a confirmation step, and writes
  `consent` + `chat_action`" — so continuing to mask afterwards would be the platform overriding a consent it
  had just recorded. **Entities are dropped unconditionally regardless**, because a `text_mention` carries a
  *third party's* raw Telegram id and consenting to share your own details is not consent to hand over
  somebody else's.
- **`share-contact` reveals nothing by itself.** The platform holds no phone number and does not surrender a
  Telegram username (invariant 7); what the endpoint changes is that the caller's own messages stop being
  masked, so the disclosure stays the user's act. That is the reading §8's "never stored — relayed in-chat
  after explicit consent only" requires.
- **The `consent` row is per user per policy version, not per chat.** `UNIQUE (user_id, policy_version_id,
  context)` makes a per-chat consent row impossible, so the division is: `consent` records that the user
  accepted the terms under which contact details may be exchanged, and `chat_action` records each individual
  act of doing so. ADR-0009 asks for both and this is the shape the schema permits.
- **The outbox payload carries ids and an alias, never the message body.** `outbox_event.payload` is plain
  jsonb — the one part of this feature that is not encrypted — so putting the text in it would undo the
  column beside it. M13's relay decrypts the row the payload points at. There is a test that serialises the
  payload and looks for the message.
- **System messages are stored rows, not rendered at read time.** The anonymous intro, the open notice, the
  close notice and the contact-share notice are `kind = 'SYSTEM'` messages, encrypted and sequenced like any
  other. Rendering them from a status at read time would make a conversation's history change when the copy
  is edited, and show a user a notice they were never sent.
- **`CHAT_MESSAGE_EMPTY` added to the error catalogue.** A message that was nothing but a phone number
  leaves nothing to relay; sending a lone «حذف شد» reads like a bug in the product rather than a rule of it,
  and `VALIDATION_FAILED` would tell the user nothing about why.
- **A real bug the tests caught:** the unread count used `senderParticipantId: { not: me }`, which is SQL's
  `<> $1` — NULL, not true, for a SYSTEM row. Every system message was therefore silently excluded from the
  badge, including «the other side shared their contact details», which is one of the few notices in this
  product that genuinely needs to be noticed. Stated as an explicit `OR` now.
- **The bot is still not built, so this milestone's release gate cannot be run.** §9's acceptance —
  "two dev Telegram accounts converse with zero leakage, verified against raw Telegram payloads" — needs
  `packages/telegram` and the grammY handlers, which have been outstanding since M2 and are scheduled with
  the delivery relay in M13. What M8 delivers is the whole domain and API side: the relay pipeline, the
  encryption, the aliases, the lifecycle, the outbox instructions a sender will execute, and the leak tests.
  **The manual verification remains a genuine, unclosed gate** and must be run before chat goes public, as
  must the escalation path for illegal content that §8's legal-risk item 7 requires.
- **"A blocked bot marks `bot_blocked` without retry storms" is not implemented here** for the same reason:
  it is behaviour of the Telegram client and the `telegram-send` queue, both M13. `telegram_account.bot_blocked`
  exists from M2 and nothing in M8 writes it.
- **No Mini App work.** The chat screens are not built; M8 is the domain, the API and the leak tests.
- **Rate limiting (T12: messages 30/min) is not here.** It is M15's, applied across every endpoint class at
  once rather than invented per-feature.
- **A note M10 must not miss:** rejection, participant cancellation and expiry all close their chat, because
  those are the three ways a request ends today. **Host cancellation of an event does not exist yet** — there
  is no `POST /events/:publicId/cancel` — and when M10 builds it, it has to close the chat of every
  participant it cancels, through `ChatService.closeForParticipant` inside the same transaction. A chat left
  open after its event was cancelled is two strangers messaging each other about a meeting that is not
  happening. M12's moderation `BLOCKED` transition is likewise declared in the state machine and reachable by
  nothing yet.

**M9 — Coins & Trust Score** · *L*
Tests: balance never negative; **concurrent spends of the last coins ⇒ exactly one succeeds**; ledger rows
immutable (UPDATE/DELETE raise); reversal restores the balance exactly; referral requires attendance;
self-referral rejected; trust clamps to [0,100]; **sum of ledger deltas = current score**.
Acceptance: a reconciliation test over 1000 random operations proves `balance == SUM(amount)`.

**Deviations from this plan, decided during M9:**

- **The starting Trust Score is a ledger row, not a column default.** §11 gives "Trust start 50", and the
  obvious implementation seeds `trust_score.score = 50` — which makes `score = SUM(delta)` false for every
  user from the moment they exist, repairable only by a "plus fifty" fudge factor in the reconciliation.
  Instead an `INITIAL` entry is written lazily on the first movement, so the identity holds from the first
  row with nothing added on the side. Lazy rather than at signup so a user who never does anything costs no
  rows, and keyed so it happens at most once.
- **`trust_score_ledger.delta` stores the *effective* movement, and the requested one goes in `metadata`.**
  A rule worth +3 against somebody at 99 stores +1. Storing what the policy asked for would break
  `score = SUM(delta)` the first time anybody reached a bound, and that sum is what ADR-0007's reconciliation
  exists to check. ADR-0007 rule 5 writes the identity as `score == clamp(SUM(delta))`; under this reading
  the clamp is a no-op, which is the stronger of the two statements and the one the CHECK enforces.
- **A trust movement clamped to nothing still writes a row**, where a zero *coin* movement is rejected as a
  bug. The row is what consumes the idempotency key: without it, a redelivered job would find the key unused
  and pay out for real the moment the score dropped enough to have room. It is also the honest answer to
  "why didn't my score go up?" — the rule fired and the cap ate it.
- **`user.referral_code` added** to §4.5's field list. `referral.code` snapshots the code a referral *used*;
  the referrer still needs somewhere to keep the one they hand out. Generated on first read, so it costs
  nothing for the users who never open the invite screen.
- **T6's velocity limits are recorded, not enforced.** T6 asks for both velocity limits and `fraud_signals`
  for admin review, and the order matters: a wrong automatic rejection silently steals a real user's reward
  and nobody ever finds out. The signals go in front of a human; the hard limits are M15's rate limiting.
  The control that actually does the work is the one §11 already specifies — the reward requires an attended
  event, which does not scale to a farm.
- **`ReferralService.qualifyForAttendance` has no production caller.** The payout is complete, tested and
  idempotent, but the condition it checks is `event_participant.status = 'COMPLETED'` — and **nothing in the
  product writes that status yet**. `ACCEPTED → COMPLETED` belongs to the event-lifecycle sweep, which is
  M13's repeatable job, with no-show finalisation in M10. So the referral programme is reachable up to the
  claim and pays out only in tests. **This is a real gap between what §11 promises and what runs today**,
  stated rather than left for somebody to discover when the first invite fails to pay. Whichever milestone
  first writes `COMPLETED` must call this, and it decides the attendance question for itself rather than
  trusting the caller.
- **Boost cannot be made idempotent here, and VIP is idempotent for free.** VIP's key is the event, so buying
  it twice is structurally impossible. A second *boost* is a second purchase of a second window, which a host
  may legitimately want, so the key is derived from the window the purchase produces — deterministic enough
  that a replay arriving before the first commit collides, and no help at all for one arriving after. §6's
  `Idempotency-Key` header is what separates "asked twice" from "arrived twice" and is not built. Until it
  is, double-charge protection for boost is the Mini App's in-flight disable (§3.7). **Boost is the first
  endpoint where that missing header is visible in a user's wallet.**
- **A second boost extends the live window rather than replacing it.** Overwriting would sell the second
  window at a silent discount of however much of the first was left. A host who pays twice gets twice.
- **Boost sets the lock ordering for the rest of the product: event → user → coin account.** ADR-0006 keeps
  the event row as the single lock of every *capacity* path and boost is not one — it never touches
  `accepted_count` — but it is the first operation to hold two locks at once. M10's host cancellation needs
  exactly this pair to refund participants, and taking them in the other order there would deadlock against
  this method.
- **`CoinService.reverse` refuses to reverse a credit the user has already spent**, with `INSUFFICIENT_COINS`
  rather than a silent overdraft. The coins are gone; an admin adjustment — a decision somebody signs their
  name to — is the way to settle it. A `REVERSAL` also cannot itself be reversed: undoing an undo is a
  forward movement with its own reason, and allowing the chain would make "has this been reversed?" a graph
  walk rather than a column.
- **`EventDetail` and `EventView` gained `boostedUntil` and `isVip`.** The boost endpoint returns the event
  so the host can see what they bought, and the shape had no field capable of showing it — the response
  agreed with itself and told the buyer nothing. Discovery keeps its own narrower mapper, which reduces the
  same column to a boolean `isBoosted`: when somebody else's promotion lapses is not a stranger's business.
- **`POST /onboarding/profile` now reports the new trust score beside the coins.** Completing a profile moves
  both (§11: +50 coins, +5 trust), and a response naming one half reads as though the other did not happen.
  The full explanation stays at `GET /me/trust`.
- **The ranking's trust term became a column read, and the neutral score travels with the weights.** M5 kept
  the term as a constant `0.5` precisely so this milestone would change a constant rather than re-derive the
  ranking. `COALESCE(ts.score, trust.initial_score)` is the fairness half: a host with no row has not been
  judged, not been judged badly, and reading a missing row as zero would bury every new host — the exact
  outcome §12's resolution exists to prevent. The neutral value is carried through `RankingWeights` rather
  than hardcoded in the SQL, because two copies of `trust.initial_score` would eventually disagree.
- **The trust deltas §11 lists for attendance, reviews, cancellation, no-show and rehabilitation are not
  written here.** M9 builds the ledger and writes `INITIAL` and `PROFILE_COMPLETE`; the rest belong to the
  milestones that own the events causing them — M10 (cancellation, no-show), M11 (reviews), M13 (the
  rehabilitation job). `TrustLedgerType` declares all of them now, so those milestones add rows rather than
  migrations.
- **A latent M7 bug, found by M9's concurrency tests.** `SettingsService` read on the base Prisma client, so
  a caller inside a transaction borrowed a *second* pool connection while still holding the first; enough
  concurrent callers exhausted the pool and waited on each other forever. It surfaced as "Unable to start a
  transaction in the given time", a message that describes the symptom and hides the cause completely.
  `getInt`/`getNumber`/`getNumbers` now take an optional `tx`, and the three in-transaction call sites —
  waitlist promotion (M7), the event quota (M4) and the trust seed — pass it.
- **The leak scan's coverage guard was a magic number and did not work.** `expect(ENDPOINTS).toHaveLength(22)`
  claimed to fail when a route was added without being listed, and M9 added five endpoints while it stayed
  green — a scan reporting clean about a surface it had stopped covering, which is worse than no scan. It now
  derives the list from the routes the application actually registers with Fastify, with the webhook excluded
  by name and for a stated reason.
- **That guard immediately found six endpoints the scan had never covered**, dating to M2 and M4:
  `POST /auth/telegram`, `POST /auth/refresh`, `POST /onboarding/consent`, `POST /onboarding/profile`,
  `POST /events` and `PATCH /events/:publicId` — every one of them a write. `POST /auth/telegram` is the
  worst of the six to have missed: it is the only endpoint in the product that takes a raw
  `telegram_user_id` as input, so it is the likeliest place for one to come straight back out. It is now
  scanned with **validly signed** `initData` for the leaky fixture account, re-signed per pass because the
  replay guard claims each hash once.
- **Two ways the scan could have passed for the wrong reason are now asserted against.** A regex matching
  nothing was already covered; a *session* that quietly stopped working was not — every authenticated
  endpoint would answer 401 and four clean passes over thirty-three error envelopes would report green
  having scanned none of the projections. The scan now records every status it saw and fails if a read never
  answered below 400, or if `POST /auth/telegram` never reached 200.
- **CI's hand-written-guarantee check gained the M9 objects**: the `trust_score_ledger` append-only trigger
  and its three CHECKs, both unique indexes, and the referral constraints that make one-referrer-per-person
  and no-self-referral database facts rather than service checks.
- **No admin surface.** `ADMIN_ADJUSTMENT` exists in both ledgers and both services accept it, but
  `POST /admin/v1/coins/adjust` and the trust-ledger views are M12. Nothing outside a test writes an admin
  movement yet.
- **No Mini App work**, as in M4, M5 and M8. The coins, trust and invite screens are not built; M9 is the
  domain, the API and the reconciliation.

**M10 — Cancellation & penalties** · *L*
Tests: a **parameterised table across every threshold** — inside grace, 25 h, 23 h, 3 h 01 m, 2 h 59 m,
no-show — each asserting exact coin + trust deltas; **`Asia/Tehran` boundary tests**; a manipulated client
clock has zero effect (the endpoint accepts no client timestamp); **host cancellation refunds 100% and
notifies everyone (D9)**. Rollback: set penalties to 0 in `app_setting` — no deploy needed.

**Deviations from this plan, decided during M10:**

- **No migration.** M6 already put `cancellation_bucket`, `penalty_ledger_id` and `attended` on
  `event_participant`, with the CHECK that a penalty must name a bucket. Everything M10 adds is policy
  numbers, and every policy number lives in `app_setting` (§4.2) — so this milestone is entirely code and
  configuration, which is what §11's "rollback: set penalties to 0, no deploy needed" is claiming when it
  says the numbers are not in the code.
- **Penalties are charged in the transaction that records the cancellation**, not by a later job. M6
  deferred the charge and wrote the bucket early so "the penalty is judged against the thresholds that
  applied when the participant cancelled" — charging synchronously keeps that property and adds the one
  ADR-0007 actually wants: the coins and the state change commit together, so there is no window in which
  somebody has cancelled and not yet been charged.
- **A penalty takes what the account holds; a spend refuses.** `CoinService.penalize` is a separate entry
  point from `apply` for a reason that is policy, not convenience. Refusing an unaffordable penalty would let
  anybody dodge a late-cancellation charge by spending down to nothing first, and a negative balance is
  forbidden by the CHECK — so the charge is capped at the balance and the shortfall goes in `metadata` as
  `requestedAmount`, the same way `TrustService` records a delta the bounds clipped.
- **A penalty capped to *nothing* writes no ledger row**, because `coin_ledger.amount` may not be zero where
  `trust_score_ledger.delta` may. That would normally be the bug M9 warned about — the row is what consumes
  the idempotency key — and it is safe here only because the charge happens inside a **terminal** state
  transition, so `assertParticipantTransition` is the real exactly-once guard and the key is the second one.
  Stated because it is the one place in the economy where the key is not the primary defence.
- **Both thresholds sit on the cheaper side.** Exactly 24 hours out is `H24_TO_H3`, exactly 3 hours out is
  `H24_TO_H3` as well. A threshold that bites at exactly its own name surprises the person standing on it, so
  where the comparison is arguable it rounds towards charging less. The boundaries are swept a minute at a
  time in a pure test, not merely sampled at the named cases.
- **The grace window is checked before the clock thresholds, and that ordering is load-bearing.** Somebody
  accepted two hours before an event has not had a chance to think about it yet, so grace has to win over
  lateness — otherwise the 15 minutes §11 promises would be worth nothing precisely when a promotion makes
  them matter most. There is a test for exactly that interleaving.
- **`Asia/Tehran` does not enter cancellation pricing at all**, and the test says so rather than leaving it
  implied. Every threshold is a difference between two instants, so no timezone can move it; the obvious
  wrong implementation — formatting both sides into Tehran local time and subtracting — would break the
  test that pins it. The Tehran boundary that *does* matter here is the attendance cap's day, which uses
  `startOfDayIn` like the event quota does.
- **The dry run is a `GET`, not §6's `POST … ?dryRun=true`.** A dry run reads and changes nothing, and giving
  it its own verb is what stops a proxy retry, a double-tap or a mistyped query string from cancelling
  somebody's plans — which is the exact failure the confirmation dialog exists to prevent. Both previews
  quote from the same functions that do the charging, so the dialog cannot promise a different number from
  the one taken. `GET /participants/:publicId/cancel-preview` and `GET /events/:publicId/cancel-preview`.
- **A host cancellation with nobody accepted is free.** ADR-0011 prices "a host cancelling a published event
  **with accepted participants**"; charging for calling off something nobody joined would teach hosts to
  leave dead listings standing, which is worse for everyone reading discovery than the cancellation is.
- **The host's coin penalty is the participant price for the same lateness × 1.5, rounded not floored.**
  ×1.5 on an odd price lands on a half, and flooring would quietly make every such penalty cheaper than the
  multiplier says. The *trust* half is not derived from the participant table at all: §11 gives the host two
  numbers split at 24 hours where a participant has three buckets, so a host who cancels more than a day out
  pays no coins and still loses reputation — a cancelled event costs people their Saturday whether or not it
  was cheap to call off.
- **A pending or waitlisted request `EXPIRED`s when the host cancels; only an accepted one is
  `CANCELLED_BY_HOST`.** This is what M6's state machine has said since it was written —
  `WAITLISTED → CANCELLED_BY_HOST` is not a legal edge — and the reasoning holds: somebody still waiting was
  never given a seat, so there is nothing to take away.
- **M8's note to M10 is discharged**: host cancellation closes every chat it cancels, inside the same
  transaction and under the event lock it already holds, so the ordering stays event → chat. A chat left open
  after its event was cancelled is two strangers arranging a meeting that will not happen.
- **D9a is unchanged and still honest.** The refund reverses every `coin_ledger` row whose subject is the
  participant, which today is an empty set because joining is free. It is tested with a synthetic
  participant-side charge, so it is known to work rather than assumed to. One filter was needed that the ADR
  does not mention: penalty rows are excluded, or a host cancelling afterwards would hand back the
  participant's *own* late-cancellation fine — turning "the host let you down" into a refund for letting them
  down first.
- **The event lifecycle sweep lands here, not in M13.** `ACCEPTED → COMPLETED` had no writer anywhere in the
  product, which M9 recorded as an open gap that made the referral programme unreachable. M10 is the
  milestone that prices attendance and no-shows, so it is the one that has to decide who attended.
  `retireStarted` and `settleAttendance` are domain methods; **scheduling them is still M13**, exactly as M6
  left `expireOverdue`. **This closes M9's referral gap** — there is a test that a referral qualifies through
  the sweep.
- **Attendance settles after a configured delay (24 h), not at the end of the event.** `COMPLETED` is
  terminal, so settling immediately would close the door before a host could report a no-show. The delay
  matches the review window opening at T+24 h (§11), so the two things a host is asked to do about a finished
  event become available together.
- **Everyone still ACCEPTED when the sweep runs is treated as having attended.** The alternative is
  penalising people for a report their host never filed. A host who says nothing has told us nothing.
- **`POST /participants/:publicId/no-show` is an addition to §6's endpoint list.** §11 prices a no-show at
  −60 coins and −15 trust and §7 draws `ACCEPTED → NO_SHOW`, but the plan never says who decides one — and
  the platform is not at the café. Left unbuilt, the most expensive penalty in the product would be
  unreachable and the state would be decoration. It is a host action, audited like every other, only after
  the event has ended, and M12's moderation is where a participant disputes one.
- **Attendance trust is capped per *Tehran* day, counted against the ledger.** §11's "+2, cap +2/day" is
  what stops two people running six events a day to trade reputation with each other — the same reasoning
  that puts the referral reward behind an attended event. Counted from `trust_score_ledger` rather than a
  stored per-day tally, because the ledger is already the truth and a second counter is a second thing that
  can disagree with it.
- **A latent M9 bug, found by the attendance cap.** Both ledgers took `created_at` from the column default,
  so a policy window derived from the injected `Clock` and the rows it filtered came from two different
  sources of time — the cap would have been untestable and silently inert wherever the two diverged. This is
  the same divergence M4 had to fix on `event.created_at`, and the fix is the same: `CoinService` and
  `TrustService` now take the `Clock` and stamp `created_at` from it (ADR-0008). Worth the constructor churn
  because M12's admin views and M15's retention purge will both filter these columns.
- **The referral payout runs *after* the settlement transaction, not inside it.** `qualifyForAttendance`
  takes the *referrer's* coin-account lock — a different user from the attendee, and one the sweep has no
  other reason to touch — so calling it under the event lock would mean holding an event lock while waiting
  on an arbitrary third party's account, which is the second-lock-of-unknown-order ADR-0006 rule 2 exists to
  prevent. Safe outside because it re-derives its own condition and is idempotent: a crash between the commit
  and the payout pays out on the next sweep rather than losing the reward.
- **Host cancellation is the first path to hold more than one coin-account lock, so it needs an order among
  them.** Every refunded participant's account plus the host's are taken up front, sorted by user id: two
  such cancellations sharing a participant could otherwise deadlock, and the event locks they each hold are
  for *different* events, so nothing serialises them earlier. Latent today — D9a means the refund reverses an
  empty set — and built anyway, because D9a also says the refund goes live the moment a participant-side cost
  exists, and a deadlock found then would be found in production.
- **A second latent issue the clock change exposed**, this time in M9's own reconciliation test: it read the
  ledger chain ordered by `created_at` alone. Two movements can share a timestamp — the clock has millisecond
  resolution and one transaction can write two rows — so the order was arbitrary whenever they tied, which
  turns a continuity assertion into a coin toss. Now ordered by `(created_at, id)`, `id` being UUIDv7 and
  therefore a time-ordered unique tiebreak — the same shape the waitlist queue uses.
- **The leak scan's new coverage guard earned itself immediately.** It caught all four of M10's endpoints the
  moment they were added, which is the first time that check has done its job on code written after it.
- **No Mini App work**, as in M4, M5, M8 and M9. The cancellation dialogs the dry-run endpoints exist to
  power are not built.

**M11 — Blind reviews** · *M*
Tests: **the counterparty review is unreadable before reveal — asserted at the API layer, not the UI (D7)**;
both submitted ⇒ immediate reveal; deadline with one side ⇒ `EXPIRED_PARTIAL` (D7a); duplicate ⇒ 409;
editing after reveal ⇒ 409; the T+24 h notification fires once even if the job runs twice.

**Deviations from this plan, decided during M11:**

- **Migration `0011`, with no `0010`.** The numbers track milestones, and M10 needed no schema change — the
  gap says so rather than hiding it.
- **Readability is a property of the *pair*, not of the review.** Every public read joins through
  `review_pair` and filters on `REVEALED_PAIR_STATUSES`, so an unrevealed review is **absent from the
  response** rather than filtered out of one that briefly contained it. A `WHERE` on the review's own status
  would be true only by accident: a review is `SUBMITTED` both before its counterparty writes and while the
  pair waits, so the review alone cannot answer "may anybody read this?".
- **`PENDING → REVEALED` is deliberately absent from the pair's state machine.** Two sides cannot arrive at
  once — each submission is its own transaction — so the second always finds the first and moves
  `PARTIAL → REVEALED`. Admitting the edge would admit a path that says a pair went from empty to complete in
  one step, which would hide a bug rather than describe one.
- **`SUBMITTED → HIDDEN` is in the review's table though §7 draws only `REVEALED → HIDDEN`.** Moderation has
  to be able to take down a review that never reached reveal — a comment reported inside the edit window is
  exactly that case — and routing it through REVEALED to do so would mean publishing the thing being taken
  down.
- **The reward is paid on submission, not at reveal.** §11 says "completed review +10 coins"; paying at
  reveal would make the reward depend on whether somebody *else* did their part, which is both unfair and the
  precise incentive D7 removes elsewhere — it would give a reviewer a reason to care what the counterparty
  does.
- **Trust moves at reveal, and D7a is where it bites.** A pair that revealed because both sides wrote moves
  both scores. One that expired with a single side written reveals that review — the reviewer's effort stays
  visible — and moves nothing, overridable at runtime through `review.partial_reveal_affects_trust`, the flag
  §0 explicitly says is there to be overridden. Three stars writes no movement at all, because it is worth
  zero and `TrustService` rejects a zero delta as a bug.
- **Editing is refused after reveal even inside the hour.** §11 gives a one-hour edit window and §7 says
  "only while SUBMITTED"; the two agree, and the reason is worth stating: once the counterparty can see what
  you wrote, an edit is a *reply*, which is the exact dynamic D7 exists to prevent.
- **The window opens at attendance settlement, in M10's transaction.** That placement is what makes "you may
  only review an evening you were actually at" structural rather than a check somebody has to remember: a
  completed participation always has a pair, and **a no-show or a cancellation never gets one**. Reviewing
  somebody for not turning up is what the no-show penalty already is; asking two people to rate an evening
  that did not happen produces a rating about nothing.
- **Both dates are measured from the event's `ends_at`, not from the sweep.** §11's "opens T+24 h, deadline
  T+7 d" is about when the thing being reviewed finished, so a sweep that runs late does not shorten
  anybody's window.
- **`review.moderation_status` is now written, which closes a gap this milestone would otherwise have
  shipped.** §4.6 gives the column and the read path filters on it, but nothing set it. A review comment is
  public free text about another person, so it gets the same blacklist an event description does, mapped
  ADR-0012's way: FLAG stays visible and opens a case, BLOCK does not become visible and opens a case. Edits
  are re-judged, or "submit something clean then edit it" would be the obvious way past the scanner.
- **A blocked comment does not refuse the submission**, which is the one place this differs from event
  authoring. The review is half of a pair, and refusing it would let one party's bad language stop the other
  party's review from ever revealing. The rating counts, the pair completes, and only the text is withheld.
- **`review_pair_due_idx` is composite, not partial.** Prisma's `@@index` where-clause supports only equality
  and `not`, so `status IN ('PENDING','PARTIAL')` is not expressible — and an index Prisma cannot see is one
  `migrate dev` would happily drop. `(status, deadline_at)` prunes to the same rows through its leading
  column. This is the opposite call from M2's partial unique index, and deliberately: that one enforced an
  invariant and was worth the drift, this one is a performance index and is not.
- **A revealed review carries no reviewer on the public read.** A reader is entitled to know what was said
  about this person, not who said it. The author's own read is a separate endpoint with a separate shape,
  because it answers a different question.
- **The average is computed over revealed reviews only.** An average that moved when an unrevealed rating
  landed would leak the rating through arithmetic without ever returning it — the subtle way invariant 8
  gets broken.
- **Tags are a fixed vocabulary, not free text.** A closed list needs no moderation and no normalisation and
  makes ratings comparable across reviewers. Free text still exists in `comment`, and that is the field the
  scanner reads.
- **Two endpoints beyond §6's list**: `PUT /participants/:publicId/review` (the edit §7 requires but §6 never
  names) and `GET /participants/:publicId/review` (reading back your own, which the edit screen needs). §6
  gives `GET /me/reviews/pending`, `POST /participants/:id/review` and `GET /users/:publicId/reviews`, all
  built as specified.
- **The deadline sweep is a domain method; scheduling it is M13**, exactly as M6 left `expireOverdue` and M10
  left the attendance sweep. **The plan's "T+24 h notification fires once even if the job runs twice" is
  therefore not tested here**: the reveal emits one outbox row per pair and `settleExpired` is idempotent,
  which is the half M11 owns — but the notification itself does not exist until M13 builds the relay and
  `notification.dedupe_key`. Stated rather than quietly counted as done.
- **The test harness caps its connection pool at ten per client.** Every integration file builds its own
  Prisma client and the driver's default pool is `cpus * 2 + 1` — thirty-three on a sixteen-core machine,
  against Postgres's default hundred. Ten is far more than any one file needs, and the concurrency suites
  queue at the pool instead of at Postgres, which changes nothing they assert: they contend on row locks, and
  the lock is the thing under test.
  **Correction, established in M13:** this was treated at the time as the *cause* of a wave of 289 failures,
  and it was not — it was a mitigation that made the real fault less likely to fire. The actual cause was
  that `fileParallelism: false` did not hold for the integration project in the **combined** run, so files
  meant to be sequential ran concurrently and raced each other's `TRUNCATE`. M13 hit the same fault with a
  different symptom (a deadlock rather than stale fixtures) and fixed it properly with `singleFork`. The
  pool cap is still worth having; it was not the answer.
- **No Mini App work**, as in M4, M5 and M8–M10. The review screens are not built.

**M12 — Reports & admin moderation** · *L*
Tests: the same user cannot report twice (DB-enforced); the **3rd distinct** reporter hides the event and
opens a case (threshold read from config, also tested at 2 and 4); the owner is notified **without any
reporter identity**; **an RBAC matrix test — every role × every admin endpoint**; SUPPORT cannot adjust
coins; chat unseal without an open case is denied.

**Deviations from this plan, decided during M12:**

- **`MESSAGE` reports name the *conversation*, not a message.** §4.6 lists `MESSAGE` as a target type, but a
  message has no public id — §4.4 exposes conversations by `anonymous_chat.public_id` and messages only by a
  per-chat sequence, deliberately. Naming an individual message from outside would need an identifier the
  product does not publish. Reporting a conversation is what a user can actually do, and it is also what
  opens the case a break-glass grant then requires (T14), so the two features meet where they should.
- **Nobody is notified when a conversation is reported.** Telling one side of an anonymous chat that the
  other reported them is the single notification this module must never send, so `MESSAGE` reports have no
  owner and emit nothing.
- **`report.target_type` reuses `ModerationSubjectType` rather than declaring a parallel enum.** A report and
  the case it opens are about the same kinds of thing, and two enums would drift the first time one gained a
  member.
- **The auto-hide threshold counts rows because the UNIQUE makes rows mean people.** That is the load-bearing
  connection between invariant 5 and §11's "3 distinct users": without
  `UNIQUE (target_type, target_id, reporter_user_id)`, one determined person could hide anybody's event by
  clicking three times. The count is taken *after* the insert and inside the same transaction, so two
  simultaneous third reports cannot both see two.
- **A fourth report updates the existing case rather than opening another.** A queue holding three cases
  about one event is a queue three people work in parallel.
- **Reporting your own content is refused.** Not in the plan, but allowing it would let somebody inflate a
  count towards their own threshold, and "report your own event" is not a meaningful action.
- **TOTP is hand-rolled**, for the reason M2 hand-rolled the `initData` HMAC: it is thirty lines of RFC 6238
  arithmetic with published test vectors, it needs no I/O, and a dependency on the code path that decides who
  reaches the moderation panel is a supply-chain risk. Tested against the RFC's own vectors. `argon2id` is
  **not** hand-rolled — `@node-rs/argon2` is the one new runtime dependency, because a memory-hard hash is
  exactly the kind of primitive nobody should write themselves.
- **`@node-rs/argon2` exports `Algorithm` as an ambient const enum**, which `isolatedModules` cannot inline —
  importing it compiles and then fails at runtime with `undefined`. The algorithm is written as the literal
  `2` with a comment saying why.
- **Login answers identically for every failure.** Unknown email, wrong password, wrong code and suspended
  account all return `INVALID_CREDENTIALS`, and an unknown email still costs a hash so it cannot be
  distinguished with a stopwatch. Distinguishing them would turn the endpoint into an oracle for which staff
  addresses exist. The *audit* row records which factor failed, because a defender needs that and an attacker
  never sees it.
- **The lockout counter advances on a wrong TOTP code, not only a wrong password**, so somebody who has the
  password but not the phone cannot brute-force six digits at leisure. Progressive rather than a flat window,
  because a flat window is a rate limit an attacker waits out.
- **The four-eyes rule is a CHECK, not only a service check.** `approved_by_id <> requested_by_id` in the
  database is what stops one compromised `role.manage` account quietly becoming every role at once — which is
  precisely what an attacker would do with the account they most want.
- **`chat_unseal_grant` is a row, not a flag**, and its three conditions are three columns: a case id that is
  `NOT NULL`, a reason with a length CHECK, and an expiry with `expires_at > granted_at`. "Reading a chat
  requires an open case" is therefore a schema fact rather than a service check.
- **One audit row per message read, never the message body.** T14 says per-message and it is easy to soften
  into per-session; a session row answers "somebody opened this chat" while a per-message row answers what
  they actually read. The body is never copied into the trail — an audit log holding the plaintext defeats
  the encrypted column beside it.
- **`ChatModule` now exports `MessageCipher`**, which it deliberately did not before. There is exactly one
  other consumer — the break-glass path — and the import in `AdminAccessModule` is what makes "who can
  decrypt a private message?" answerable by reading two module files.
- **The global Mini App `AuthGuard` skips `/admin/`.** The admin API is a different identity system with a
  different session mechanism, so the Mini App guard would refuse every staff request with an error about a
  header the panel never sends. `AdminAuthGuard` protects those routes and is deny-by-default in the same
  way, with authorisation underneath it in the services.
- **Cookie registration is a function both composition points call, not a module provider.** A Fastify plugin
  must be on the instance before Nest boots it, and a provider runs during `init()` — too late. This is the
  opposite of the call M6 made for the exception filter, and it is forced rather than preferred; the
  response-leak scan calls it and then asserts admin reads actually succeed, so forgetting it fails a test.
- **The leak scan's `@username` detector matched every email address.** M12 surfaced it the moment the admin
  API started returning a staff member's own address to themselves. A Telegram handle follows whitespace or a
  quote; an email has its local part pressed against the `@`. The pattern now has a lookbehind, which is a
  strictly better detector rather than an exception carved out for one endpoint.
- **The scan reaches the admin API with a real staff session**, including the one endpoint in the product
  that returns decrypted private messages. That read is the single most important response in the file to
  scan, and scanning it at all meant satisfying all three break-glass conditions in the fixture.
- **`POST /admin/v1/coins/adjust` takes a client-supplied `reference` as its idempotency key.** Only the
  caller knows whether a request is a retry, and a generated key would make a flaky connection double
  somebody's balance.
- **Built but not in §6's list**: `/admin/v1/me`, `/admin/v1/trust/adjust`, `/admin/v1/users/:id/status`,
  `/admin/v1/roles/requests` and its approval, and four user-facing report endpoints rather than the one §6
  names — a reporting system that only covers events cannot be used for the things that actually hurt people.
- **Not built, and deliberately deferred**: the dashboard aggregates, and CRUD over catalog, policies,
  settings and the blacklist. §6 lists them and the plan's own §1 says "everything else is CRUD"; they are
  admin-authenticated wrappers over tables that already exist, they add nothing to the invariants this
  milestone is about, and each would need its own row in the RBAC matrix. **Stated as outstanding rather than
  quietly counted as done.**
- **No admin SPA.** `apps/admin` does not exist. M12 is the API and its authorisation; the Vue panel is not
  built, as with every other surface so far.

**M13 — Notification jobs** · *M*
Tests: a crash between commit and enqueue still delivers (kill the relay mid-flight, restart, assert
delivery); duplicate job ids ⇒ one message; 429 honours `retry_after`; 403 marks `bot_blocked` and stops;
exhausted retries land in `job_failure` and are re-drivable.

**Deviations from this plan, decided during M13:**

- **`packages/telegram` finally exists**, outstanding since M2. It holds the Persian message catalogue and
  `escapeHtml`, and **not** the grammY bot — the client lives in `apps/worker`, because it is the only
  process that talks to Telegram and a bot instance in a package both apps import would be a bot instance the
  API could accidentally construct.
- **The relay marks `processed_at` *after* writing the notifications, not before.** That ordering is the
  whole design: a crash between the two re-reads the row and re-plans it, which is safe because the dedupe
  keys are derived from the row rather than from the moment. Marking first would be faster and would lose
  notifications on exactly the crash the outbox exists to survive.
- **The dedupe key is one per recipient, not one per event.** A shared key would deliver to whichever of a
  promotion's two people the relay reached first and silently drop the other — which is the participant who
  most needs to know (D8).
- **The fan-out is a pure function**, tested as a table without a queue or a database. This is the decision
  most likely to be wrong in a way nobody notices: a missing recipient produces **silence**, and silence
  looks like nothing having happened rather than like a bug.
- **An event with no notification returns an empty list rather than throwing.** Several exist to drive other
  consumers — M14's channel publisher reads the same rows — and a fan-out that refused an event it had no
  message for would stall the relay behind it. A recipient who no longer exists (M15's anonymisation) drains
  the row too, with a warning, for the same reason.
- **429 never reaches the classifier.** grammY's `auto-retry` sits beneath the API call and sleeps for
  exactly `retry_after`, which is the only correct response to a rate limit — a fixed backoff either wastes
  time or returns too early and earns a longer penalty. If retries are exhausted the 429 surfaces as
  `RETRY` and the queue's backoff takes over. `maxDelaySeconds` bounds it, because a job sleeping inside the
  worker holds a concurrency slot and a queued one does not.
- **403 is terminal and is *not* a failure.** It returns `BLOCKED` rather than throwing, precisely so the
  caller cannot treat it as retryable — retrying a block burns the global rate budget other users'
  notifications need. `chat not found` is a 400 but is the same situation and is treated the same way.
- **A malformed request (400) stays retryable, deliberately.** It is *our* bug rather than the user's, so it
  exhausts loudly into `job_failure` where somebody sees it — instead of being filed as "undeliverable" and
  marking an innocent account as having blocked the bot.
- **An unknown template is recorded and skipped, not retried.** A notification queued by a newer deploy and
  processed by an older one would otherwise stall the whole queue behind it through a rollout.
- **The rate limiter is on `telegram-send` alone.** Only Telegram limits us; throttling the relay would slow
  the fan-out for nothing, and the fan-out is where latency is visible.
- **`job_failure` is written only when a job has no attempts left**, and is one row per job rather than one
  per attempt. The queue depth an admin sees is then the number of distinct problems rather than the number
  of attempts anybody has made at them.
- **BullMQ 6 replaced repeatable-job options with `upsertJobScheduler`**, which is an improvement rather than
  a rename: the upsert means restarting the worker *replaces* a schedule instead of adding a second copy,
  which is the classic way a "once a minute" sweep ends up running four times a minute after a month of
  deploys.
- **The daily sweeps are pinned to `Asia/Tehran`.** They are about a *person's* day — an attendance settled
  at 03:00 UTC would settle in the middle of somebody's evening.
- **The worker imports the same domain services the API does**, which is the point of `packages/domain`
  existing: the sweeps are the methods M6, M10 and M11 wrote and left unscheduled, not a second
  implementation. A job that promoted a waitlist differently from the request path would be a second source
  of truth for the product's hardest invariant. **Three deferred deviations are discharged here** —
  `expireOverdue`, the attendance settlement and the review-deadline sweep all now run on a schedule.
- **Still not built, and this milestone does not close them.** §3.2 gives `packages/telegram` "grammY
  composition, keyboards, fa message templates" and §6 lists the bot surface — `/start`, `callback_query`
  accept/reject, the inbound `message:text` relay, `edited_message` propagation, `my_chat_member` block
  detection. **None of that exists.** M13 builds the *outbound* half: the relay, the sender, the templates and
  the schedules. The inbound half needs a webhook handler wired to grammY, and **M8's release gate — two real
  Telegram accounts conversing with zero leakage, verified against raw payloads — therefore remains open.**
  Stated plainly because it has now been outstanding across four milestones.
- **The `moderation` queue is declared and unused.** ADR-0005 lists it for the blacklist-version re-scan,
  which nothing triggers yet; the name exists so a producer and a consumer cannot later disagree about it.
- **The integration project now runs in a single fork, and M11's diagnosis was wrong.** `fileParallelism:
  false` is advisory enough that it did not hold once the unit project ran alongside: integration files that
  were supposed to be sequential raced each other's `TRUNCATE` and deadlocked. M11 saw the same fault as a
  wave of foreign-key failures, attributed it to connection-pool exhaustion, and capped the pool — which
  made it rarer rather than impossible. **The tell both times was identical and should have been read
  properly the first time: the integration project passed alone and failed only in the combined run.**
  `poolOptions.forks.singleFork` makes the sequencing structural. M11's deviation note has been corrected
  rather than left standing.
- **No integration test drives a live BullMQ worker.** What is tested is every piece either side of the
  queue: the relay's crash-safety and idempotency against a real database, the fan-out as a table, the
  error classification against real `GrammyError` values, and the DLQ's shape and re-drive semantics. The
  untested seam is BullMQ's own retry and dead-letter behaviour, which is the library's rather than ours —
  but the mirroring code in `WorkerFactory` is exercised by nothing, and that is a genuine gap rather than a
  judgement that it does not matter.

**M14 — Telegram Channel** · *S* — only PUBLISHED + approved events publish; no duplicate post per event
per kind; a hidden event's post is deleted; the post body contains no host identity.

**Deviations from this plan, decided during M14:**

- **Three post kinds, not one.** VIP and BOOSTED are **bought** (M9's two coin sinks); TRENDING is **earned**
  by demand. Keeping them apart is what lets one event appear once for each reason without the channel
  repeating itself, and what keeps "did they pay for this placement?" answerable later.
- **`UNIQUE (event_id, kind)` is the duplicate guard**, and the publisher inserts and lets the index decide
  rather than reading first. A read-then-write has a window, and a channel that double-posts is a channel
  people mute.
- **The row is created *unposted*.** `posted_at` and `telegram_message_id` are filled in only once Telegram
  confirms, so a crash between the claim and the send leaves a row the next pass completes rather than a post
  nothing recorded. A CHECK ties the two columns together: a row claiming to be posted with no message id is
  a post nothing can ever take down.
- **A failed send releases its claim.** Leaving it would mean one failed post permanently barred that event
  from the channel — the unique index would refuse every future claim, and nothing would say why.
- **A taken-down row is kept, not deleted.** It is the record that the event *was* promoted, which a coin
  dispute needs: a host who paid for VIP and lost the post to moderation has a question, and "there is no
  row" is not an answer. It also stops the event being re-posted the moment it becomes publishable again.
- **Takedown is wider than the plan's "hidden".** Cancelled, rejected, soft-deleted and simply *started* all
  mean the post now advertises something that is not on. A channel full of dead links is what makes people
  stop reading it.
- **Takedowns run before new posts** in the sweep, so a channel being read right now stops advertising a
  cancelled event before it gains new entries.
- **`renderChannelPost` takes a narrow content type, not an event row.** There is no host field for a future
  edit to interpolate, which is how "the post body contains no host identity" is made structural rather than
  remembered. The channel is a public surface with no authentication in front of it: whatever appears there
  is readable by anyone who finds it, forever, including after the event is over and the account is deleted.
- **Dates are rendered Gregorian, not Jalali.** `Intl` has no Persian calendar formatter available in every
  Node build, and a wrong date in a public channel is worse than a Gregorian one. The Mini App renders Jalali,
  where the conversion is done properly.
- **`channel.enabled` is a kill switch rather than a feature flag**, read on every pass: a public surface the
  product cannot stop writing to is one that keeps posting through an incident.
- **The trending threshold counts *requests*, not views.** Asking to join is a signal a person produced; a
  view is mostly a measure of how often something was already shown — and M5 deliberately kept `view_count`
  out of ranking for the same reason.
- **A third bug in the test harness, and the second in this area.** M11 blamed connection-pool exhaustion,
  M13 replaced that with `poolOptions.forks.singleFork` — and **Vitest 4 removed `poolOptions`, so that fix
  was silently ignored.** An ignored option looks exactly like a working one until somebody reads the
  deprecation warning. `maxWorkers: 1` is the supported form and is what actually serialises the integration
  project. Recorded here rather than quietly amended in M13's note, because the lesson is the pattern: two
  successive "fixes" to this were wrong, and both times the suite went green anyway.
- **No admin control over the channel.** §6's admin surface does not include channel management, and none is
  built: what publishes is decided by the settings and by what hosts bought. A moderator who wants a post
  gone hides or rejects the event, and the sweep takes it down.

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
