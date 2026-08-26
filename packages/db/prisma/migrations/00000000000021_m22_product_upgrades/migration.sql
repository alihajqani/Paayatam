-- Migration 0021: profile editing, paid promotion, legal authoring, and a
-- channel users can be asked to join (M22).
--
-- Hand-written like 0001–0020, and **every statement is additive**. Nothing is
-- dropped, renamed or narrowed; every new column is nullable or carries a
-- default; every new table is empty. The consequence is the one that matters on a
-- database with live users in it: every existing row is already valid the instant
-- this commits, so `prisma migrate deploy` needs no backfill window and no
-- downtime, and the old code keeps working against the new schema.
--
-- Two statements `prisma migrate diff` proposed are **deliberately absent**:
--
--   DROP INDEX "policy_version_one_current_per_type"
--       Migration 0002's partial unique index — "at most one current version per
--       type" — which Prisma cannot express and therefore reports as drift on
--       every diff. It is the guarantee this migration is *building on*, not
--       something to remove.
--
--   ALTER TABLE "role_change_request" DROP CONSTRAINT "…_subject_admin_id_fkey"
--       Pre-existing drift from 0012 in the same direction: a foreign key the
--       database has and the datamodel does not describe. Dropping it here would
--       weaken four-eyes role changes as a side effect of an unrelated release.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "policy_status"           AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "message_campaign_kind"   AS ENUM ('DIRECT', 'BROADCAST', 'EVENT_INVITE');
CREATE TYPE "message_campaign_status" AS ENUM (
    'DRAFT', 'CONFIRMED', 'QUEUED', 'SENDING',
    'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'
);
CREATE TYPE "delivery_status"         AS ENUM (
    'PENDING', 'SENT', 'RATE_LIMITED', 'BLOCKED', 'INVALID', 'FAILED', 'SKIPPED'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- policy_version — the authoring half (phase 8)
--
-- `status` defaults to 'PUBLISHED' rather than to 'DRAFT', and that default is
-- the whole reason this needs no data migration: every row that exists was
-- written by `tools/seed-policies.ts` and *is* published. A 'DRAFT' default would
-- have silently unpublished the terms every current user has already accepted.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "policy_version"
    ADD COLUMN "status"                "policy_status" NOT NULL DEFAULT 'PUBLISHED',
    ADD COLUMN "title_fa"              TEXT,
    ADD COLUMN "change_summary_fa"     TEXT,
    ADD COLUMN "archived_at"           TIMESTAMPTZ(3),
    ADD COLUMN "updated_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "revision"              INTEGER        NOT NULL DEFAULT 0,
    ADD COLUMN "created_by_admin_id"   TEXT,
    ADD COLUMN "published_by_admin_id" TEXT;

ALTER TABLE "policy_version"
    ADD CONSTRAINT "policy_version_created_by_admin_id_fkey"
    FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "policy_version"
    ADD CONSTRAINT "policy_version_published_by_admin_id_fkey"
    FOREIGN KEY ("published_by_admin_id") REFERENCES "admin_user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The two rules the service must not be the only thing enforcing. Both are
-- already true of every seeded row, so neither can fail on deploy.
--
-- `is_current` still means what it meant in 0002 and its partial unique index
-- still enforces "one per type". This CHECK adds the other half: a *current*
-- version cannot be a draft somebody is still editing.
ALTER TABLE "policy_version"
    ADD CONSTRAINT "policy_version_current_is_published"
    CHECK (NOT "is_current" OR "status" = 'PUBLISHED');

ALTER TABLE "policy_version"
    ADD CONSTRAINT "policy_version_archived_has_timestamp"
    CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

-- The admin list: one type, newest first, drafts included.
CREATE INDEX "policy_version_authoring_idx"
    ON "policy_version" ("type", "status", "version" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- consent — three columns of context, and one snapshot
--
-- `consent` is append-only by trigger (0002) and this migration does not touch a
-- single existing row. `policy_version_label` is redundant with the foreign key
-- **on purpose**: evidence that depends on another row still being readable is
-- weaker than evidence that does not, and a published version can now be
-- archived. Nullable, because the rows written before today have no snapshot and
-- fabricating one would be worse than letting the join answer for them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "consent"
    ADD COLUMN "policy_version_label" TEXT,
    ADD COLUMN "request_id"           TEXT,
    ADD COLUMN "app_version"          TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_profile.invite_opt_out (phase 11)
--
-- Opt-*out*, defaulting to false, so nothing changes for anybody until they say
-- so. The top-20 selector excludes anyone with this set.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "user_profile"
    ADD COLUMN "invite_opt_out" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- city.name_normalized (phase 9)
--
-- A picker over 1,252 cities has to be a text field, and a text field over
-- Persian has to fold ی/ي and ک/ك or «قايم شهر» does not find «قائم‌شهر».
--
-- A column rather than an expression index, for the reason `event.title_normalized`
-- is one (ADR-0012): the normalizer is TypeScript and cannot be called from
-- Postgres. The backfill below is the subset of that pipeline these names
-- actually exercise — letter folding, ZWNJ→space, whitespace collapse, case —
-- and `CityAdminService` writes the real `normalize()` output on every write from
-- now on. Iranian place names carry no diacritics, no Latin runs, no digits and
-- no character repetition, so on this data the two agree.
--
-- Nullable, so adding it takes no table rewrite. The search falls back to
-- `name_fa` for a row that somehow has none.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "city" ADD COLUMN "name_normalized" TEXT;

UPDATE "city"
SET "name_normalized" = btrim(
        regexp_replace(
            lower(translate("name_fa",
                'يىكةأإآؤئۀھەٱ' || U&'\200C',
                'ییکهاااویههها '
            )),
            '\s+', ' ', 'g'
        )
    );

CREATE INDEX "city_name_trgm_idx"    ON "city" USING GIN ("name_normalized" gin_trgm_ops);
CREATE INDEX "city_province_name_idx" ON "city" ("province_id", "name_fa");

-- ─────────────────────────────────────────────────────────────────────────────
-- message_campaign — one send operation (phases 4, 11, 12)
--
-- `idempotency_key` is UNIQUE, which is the whole duplicate-broadcast guard: a
-- double-tapped «ارسال» collides on one index and produces one campaign, exactly
-- as `coin_ledger.idempotency_key` makes a double-tapped purchase produce one
-- charge.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "message_campaign" (
    "id"                    TEXT                      NOT NULL,
    "public_id"             TEXT                      NOT NULL,
    "idempotency_key"       TEXT                      NOT NULL,
    "kind"                  "message_campaign_kind"   NOT NULL,
    "status"                "message_campaign_status" NOT NULL DEFAULT 'DRAFT',
    "body_text"             TEXT                      NOT NULL,
    "parse_mode"            TEXT,
    "filter"                JSONB                     NOT NULL DEFAULT '{}',
    "estimated_recipients"  INTEGER                   NOT NULL DEFAULT 0,
    "counts"                JSONB                     NOT NULL DEFAULT '{}',
    "dry_run"               BOOLEAN                   NOT NULL DEFAULT false,
    "actor_type"            "actor_type"              NOT NULL,
    "actor_admin_id"        TEXT,
    "actor_user_id"         TEXT,
    "event_id"              TEXT,
    "coin_ledger_id"        TEXT,
    "confirmed_by_admin_id" TEXT,
    "cancelled_by_admin_id" TEXT,
    "paused_at"             TIMESTAMPTZ(3),
    "pause_reason"          TEXT,
    "created_at"            TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at"          TIMESTAMPTZ(3),
    "started_at"            TIMESTAMPTZ(3),
    "finished_at"           TIMESTAMPTZ(3),
    "cancelled_at"          TIMESTAMPTZ(3),

    CONSTRAINT "message_campaign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_campaign_public_id_key"       ON "message_campaign" ("public_id");
CREATE UNIQUE INDEX "message_campaign_idempotency_key_key" ON "message_campaign" ("idempotency_key");
CREATE UNIQUE INDEX "message_campaign_coin_ledger_id_key"  ON "message_campaign" ("coin_ledger_id");
CREATE INDEX "message_campaign_status_created_at_idx"      ON "message_campaign" ("status", "created_at");
CREATE INDEX "message_campaign_kind_created_at_idx"        ON "message_campaign" ("kind", "created_at");
CREATE INDEX "message_campaign_actor_admin_id_created_at_idx"
    ON "message_campaign" ("actor_admin_id", "created_at");

-- Who asked for it has to be answerable, and a row that names neither actor —
-- or both — cannot answer it. The three-way CHECK is the same discipline
-- `referral`'s rejection triple uses: columns that move together, said out loud.
ALTER TABLE "message_campaign"
    ADD CONSTRAINT "message_campaign_actor_consistent" CHECK (
        ("actor_type" = 'ADMIN'  AND "actor_admin_id" IS NOT NULL AND "actor_user_id" IS NULL) OR
        ("actor_type" = 'USER'   AND "actor_user_id"  IS NOT NULL AND "actor_admin_id" IS NULL) OR
        ("actor_type" = 'SYSTEM' AND "actor_admin_id" IS NULL     AND "actor_user_id"  IS NULL)
    );

-- A dry run may never reach a state that delivers. This is the "preview cannot
-- send" rule as a constraint rather than as a branch somebody has to remember.
ALTER TABLE "message_campaign"
    ADD CONSTRAINT "message_campaign_dry_run_never_sends" CHECK (
        NOT "dry_run" OR "status" IN ('DRAFT', 'COMPLETED', 'CANCELLED')
    );

ALTER TABLE "message_campaign"
    ADD CONSTRAINT "message_campaign_actor_admin_id_fkey"
    FOREIGN KEY ("actor_admin_id") REFERENCES "admin_user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_campaign"
    ADD CONSTRAINT "message_campaign_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_campaign"
    ADD CONSTRAINT "message_campaign_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- RESTRICT, like every other reference to the ledger: a payment cannot be
-- deleted out from under the thing it paid for.
ALTER TABLE "message_campaign"
    ADD CONSTRAINT "message_campaign_coin_ledger_id_fkey"
    FOREIGN KEY ("coin_ledger_id") REFERENCES "coin_ledger" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- message_recipient — one intended delivery
--
-- `UNIQUE (campaign_id, user_id)` is the guard that makes the dispatcher safe to
-- run twice: the second pass inserts nothing rather than enqueueing a second
-- message to the same person.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "message_recipient" (
    "id"                  TEXT              NOT NULL,
    "campaign_id"         TEXT              NOT NULL,
    "user_id"             TEXT              NOT NULL,
    "status"              "delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts"            INTEGER           NOT NULL DEFAULT 0,
    "last_error"          TEXT,
    "telegram_message_id" INTEGER,
    "sent_at"             TIMESTAMPTZ(3),
    "created_at"          TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_recipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_recipient_campaign_id_user_id_key"
    ON "message_recipient" ("campaign_id", "user_id");
CREATE INDEX "message_recipient_campaign_id_status_idx"
    ON "message_recipient" ("campaign_id", "status");

-- The dispatcher's claim query. Partial, so the index holds the backlog rather
-- than every delivery the product has ever made.
CREATE INDEX "message_recipient_pending_idx"
    ON "message_recipient" ("campaign_id") WHERE ("status" = 'PENDING');

ALTER TABLE "message_recipient"
    ADD CONSTRAINT "message_recipient_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "message_campaign" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_recipient"
    ADD CONSTRAINT "message_recipient_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- event_invitation — the top-20 mechanism's own record (phase 11)
--
-- Separate from `message_recipient` even though a campaign carries both, because
-- the question it answers outlives the campaign: "has this person already been
-- invited to this event?" must stay a unique index long after the campaign row
-- has been read for the last time.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "event_invitation" (
    "id"              TEXT              NOT NULL,
    "event_id"        TEXT              NOT NULL,
    "user_id"         TEXT              NOT NULL,
    "campaign_id"     TEXT,
    "score"           INTEGER           NOT NULL,
    "score_breakdown" JSONB             NOT NULL,
    "status"          "delivery_status" NOT NULL DEFAULT 'PENDING',
    "created_at"      TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"         TIMESTAMPTZ(3),

    CONSTRAINT "event_invitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_invitation_event_id_user_id_key"
    ON "event_invitation" ("event_id", "user_id");
CREATE INDEX "event_invitation_event_id_created_at_idx" ON "event_invitation" ("event_id", "created_at");
CREATE INDEX "event_invitation_user_id_created_at_idx"  ON "event_invitation" ("user_id", "created_at");

ALTER TABLE "event_invitation"
    ADD CONSTRAINT "event_invitation_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "event_invitation"
    ADD CONSTRAINT "event_invitation_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event_invitation"
    ADD CONSTRAINT "event_invitation_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "message_campaign" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- event_channel_config — the public face of the channel (phase 6)
--
-- `TELEGRAM_CHANNEL_ID` stays an environment variable: it is where the *bot*
-- posts, and a destination editable from a web session is a destination an
-- attacker with a session can redirect. This table holds only what is already
-- public — a @username, an invite link — plus whether users must join. **No
-- secret is stored here, and the bot token never touches it.**
--
-- One row, pinned by a CHECK. A settings table with two rows is a bug nobody
-- notices until the second one wins.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "event_channel_config" (
    "id"                  TEXT           NOT NULL DEFAULT 'default',
    "chat_identifier"     TEXT,
    "public_username"     TEXT,
    "invite_url"          TEXT,
    "membership_required" BOOLEAN        NOT NULL DEFAULT false,
    "required_actions"    TEXT[]                  DEFAULT ARRAY[]::TEXT[],
    "verify_via_telegram" BOOLEAN        NOT NULL DEFAULT true,
    "updated_by_admin_id" TEXT,
    "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_channel_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_channel_config_singleton" CHECK ("id" = 'default')
);

ALTER TABLE "event_channel_config"
    ADD CONSTRAINT "event_channel_config_updated_by_admin_id_fkey"
    FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The row exists from the moment the migration commits, with the requirement
-- **off**. Creating it lazily on first read would mean the one code path that
-- decides whether users are locked out is also the code path that has to handle
-- "no row yet" — and getting that branch backwards locks out everybody.
INSERT INTO "event_channel_config" ("id") VALUES ('default')
    ON CONFLICT ("id") DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log.action (phases 8 and 13)
--
-- The legal trail is read by action name — "every `policy.*` row", "every
-- `admin.profile.updated`" — and without this that is a scan of a table which
-- grows with every admin action in the product.
--
-- Nothing is added for the top-20 selector's reads: `user_profile (city_id,
-- district_id)` from 0003 already answers "candidates in this city" on its
-- leading column, and `event_participant (user_id, status)` from 0006 already
-- answers "what has this person taken part in". A second index over the same
-- leading column would be write cost for no read.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log" ("action", "created_at");
