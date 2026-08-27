-- Migration 0024: more than one channel a user can be required to join.
--
-- **Every statement is additive.** One new table, one new index, and one INSERT
-- that copies a row the product already has. Nothing is dropped, renamed or
-- narrowed, and `event_channel_config` keeps every column it had — so the
-- previous release runs unchanged against this schema, which is what makes the
-- deploy reversible without a down migration.
--
-- ── Why a table rather than three more columns ──────────────────────────────
--
-- v0.3.0 put the channel's public face *on the settings singleton*: one
-- `chat_identifier`, one `public_username`, one `invite_url`. That shape can
-- hold exactly one channel, and the product now has to hold several — with an
-- order, because the requirement is that users are asked to join them in a
-- stated sequence and the panel lists them the same way.
--
-- The singleton keeps what is genuinely global — whether the requirement is on
-- at all, which operations it covers, whether Telegram is asked — and the
-- channels move to rows. Its three per-channel columns are **left in place and
-- unread by the new code**: dropping them would be a destructive statement in a
-- release whose whole point is a feature, and keeping them costs three nullable
-- columns on a one-row table.
--
-- ── The backfill, and why it cannot lose anything ──────────────────────────
--
-- The INSERT below copies the configured channel into the new table, once,
-- guarded on there being something to copy and on the table being empty. A
-- deployment that had no channel configured gets no row and therefore no
-- requirement; a deployment that had one gets exactly the channel it already
-- had, at position 1, active. Re-running the migration is impossible (Prisma
-- records it), but the guard means re-running the *statement* is still a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- required_channel — the channels a user may be asked to join, in order
--
-- No secret lives here, for the same reason none lives in `event_channel_config`:
-- `TELEGRAM_CHANNEL_ID` and the bot token stay environment variables, because a
-- *posting* destination editable from a web session is a destination an attacker
-- with a session can redirect. What this table holds is public either way — a
-- @username, an invite link, a display title.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "required_channel" (
    "id"                  TEXT           NOT NULL,
    -- What the operator calls it in the panel and what the user reads above the
    -- join button. Not derived from the username: «کانال اصلی پایه‌تم» is what a
    -- user needs, and `@payetam_main` is not.
    "title"               TEXT           NOT NULL,
    -- What `getChatMember` is given: `@payetam` or `-100…`. Null means this
    -- channel cannot be verified, which is legitimate — see `verify_via_telegram`
    -- on the singleton — and means every user passes it.
    "chat_identifier"     TEXT,
    "public_username"     TEXT,
    -- Rendered as an `href` for every user, so it is normalised to
    -- `https://t.me/…` on write and rejected otherwise. An unvalidated URL here
    -- is a phishing link the product would be hosting.
    "invite_url"          TEXT,
    -- Order of joining and of display, which the requirement states matter.
    -- Sparse on purpose (10, 20, 30…), so inserting between two channels does not
    -- have to rewrite every row after it.
    "sort_order"          INTEGER        NOT NULL DEFAULT 0,
    -- Deactivating rather than deleting: a channel that stops being required is
    -- usually required again a month later, and the audit trail reads better when
    -- the row survives.
    "is_active"           BOOLEAN        NOT NULL DEFAULT true,
    "updated_by_admin_id" TEXT,
    "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "required_channel_pkey" PRIMARY KEY ("id"),

    -- A channel with neither a link nor a username is a join button pointing
    -- nowhere. The service refuses it too; this is the copy the database keeps,
    -- because a gate is exactly the place where "the service checks it" stops
    -- being enough.
    CONSTRAINT "required_channel_reachable"
        CHECK ("invite_url" IS NOT NULL OR "public_username" IS NOT NULL)
);

-- The list is read in full on every gate check, ordered, filtered to active.
CREATE INDEX "required_channel_active_order_idx"
    ON "required_channel" ("is_active", "sort_order");

-- One row per channel, so an operator cannot add the same channel twice and
-- leave users with two join buttons for one membership. Partial, because a
-- deactivated row is history and must not block re-adding the channel later.
CREATE UNIQUE INDEX "required_channel_one_active_per_chat"
    ON "required_channel" ("chat_identifier")
    WHERE "is_active" AND "chat_identifier" IS NOT NULL;

ALTER TABLE "required_channel"
    ADD CONSTRAINT "required_channel_updated_by_admin_id_fkey"
    FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: the channel this deployment already had becomes channel 1
--
-- `gen_random_uuid()` rather than an application-generated id: this runs before
-- any application does, and pgcrypto's function has been in core Postgres since
-- 13. The id shape does not have to match the UUIDv7 the app mints elsewhere —
-- nothing orders `required_channel` by id.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO "required_channel" (
    "id", "title", "chat_identifier", "public_username", "invite_url",
    "sort_order", "is_active", "updated_by_admin_id"
)
SELECT
    gen_random_uuid()::TEXT,
    COALESCE(NULLIF("public_username", ''), 'کانال پایه‌تم'),
    "chat_identifier",
    "public_username",
    "invite_url",
    10,
    true,
    "updated_by_admin_id"
FROM "event_channel_config"
WHERE "id" = 'default'
  AND ("invite_url" IS NOT NULL OR "public_username" IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "required_channel");
