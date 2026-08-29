-- Migration 0025: the state a stateless bot has to start keeping (ADR-0017).
--
-- **Every statement is additive.** One enum, one table, two indexes. Nothing
-- existing is dropped, renamed or narrowed, so the previous release runs
-- unchanged against this schema — which is what makes the deploy reversible
-- without a down migration. The reverse, if it is ever wanted, is
-- `DROP TABLE conversation_state; DROP TYPE conversation_kind;` and it loses
-- only half-filled forms.
--
-- ── What this table is for ─────────────────────────────────────────────────
--
-- The bot has been read-only and deliberately stateless: `BotService` held no
-- per-user conversation state, and that absence is what made a redelivered
-- Telegram update idempotent by construction. ADR-0017 reverses that so the
-- forms can move out of the Mini App and into the chat. This table is where the
-- memory goes, and `last_update_id` is what replaces the property that is lost.
--
-- ── Why `user_id` is UNIQUE rather than indexed ────────────────────────────
--
-- One wizard at a time, per person. A user has exactly one Telegram
-- conversation with the bot, so two concurrent wizards would be two flows
-- editing the same message — each destroying the other's screen. The constraint
-- is also the authorisation model: a draft is found by the authenticated
-- sender's id, never by an id carried in a button, so there is no identifier a
-- tampered `callback_data` could swap to reach somebody else's form.
--
-- ── Why the payload is encrypted ───────────────────────────────────────────
--
-- Most of a draft becomes a public event. The description need not: it is the
-- user's words *before* they chose to publish them, and an abandoned draft is
-- words they chose not to. Same three columns and the same key as
-- `chat_message` (ADR-0009), so the repository has one story about encrypted
-- columns rather than two that drift.
--
-- ── `expires_at`, and the requirement it settles ───────────────────────────
--
-- The brief asked for three retention rules that cannot all hold: delete after
-- 24 hours, resume after 24 hours, delete after 7 days. ADR-0017 picks seven
-- days — resume was explicit, and somebody who starts an event on Friday and
-- finishes it on Monday is an ordinary user. The index is on `expires_at`
-- because the sweeper reads by it and nothing else does.

CREATE TYPE "conversation_kind" AS ENUM (
  'ACCEPT_POLICIES',
  'COMPLETE_PROFILE',
  'EDIT_PROFILE',
  'CREATE_EVENT',
  'EDIT_EVENT'
);

CREATE TABLE "conversation_state" (
  "id"                     TEXT         NOT NULL,
  "user_id"                TEXT         NOT NULL,
  "kind"                   "conversation_kind" NOT NULL,
  "step"                   TEXT         NOT NULL,
  "form_data_ciphertext"   BYTEA        NOT NULL,
  "form_data_nonce"        BYTEA        NOT NULL,
  "key_version"            INTEGER      NOT NULL,
  "last_message_id"        INTEGER,
  "target_public_id"       TEXT,
  -- BIGINT because Telegram's update_id is unbounded in principle and a bot
  -- that has run for years will exceed INTEGER.
  "last_update_id"         BIGINT       NOT NULL,
  "expires_at"             TIMESTAMPTZ(3) NOT NULL,
  "created_at"             TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "conversation_state_pkey" PRIMARY KEY ("id")
);

-- One wizard per person; see the note above. This is a constraint the product
-- relies on for authorisation, not only for tidiness.
CREATE UNIQUE INDEX "conversation_state_user_id_key"
  ON "conversation_state" ("user_id");

-- The sweeper's index, and its only reader.
CREATE INDEX "conversation_state_expires_at_idx"
  ON "conversation_state" ("expires_at");

-- CASCADE rather than RESTRICT: a half-filled form has no independent meaning
-- once the account is gone, and M15's anonymisation must not be blocked by one.
ALTER TABLE "conversation_state"
  ADD CONSTRAINT "conversation_state_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "user"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
