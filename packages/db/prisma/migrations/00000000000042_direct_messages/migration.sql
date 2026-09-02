-- Migration 0042: direct messages (v0.7.0).
--
-- ── Why this is not `anonymous_chat` ─────────────────────────────────────────
--
-- The anonymous chat is a *conversation* that belongs to a participation: it
-- opens when somebody asks to join, uses aliases instead of names, masks contact
-- details until both sides consent, carries a status machine, a per-chat
-- sequence, a retention clock and a relay that routes a typed reply back into it
-- by remembering which message the sender pressed reply on. All of that exists to
-- protect two strangers who have not met.
--
-- A direct message is the other thing somebody wants: a note to the host, about
-- their activity, *before* deciding anything — from a reader who may never join.
-- There is no conversation to open and nothing to keep anonymous beyond what the
-- writer chooses to put in it. Building it on the chat would have meant inventing
-- a participation to hang it from, or a chat with no participation, and either is
-- a lie in a table somebody later reads as truth.
--
-- The decisive difference: contact details are **not masked** here. Exchanging a
-- phone number is the point of the feature, and the notification says so. That is
-- exactly why it must not share a table with the place where masking is the
-- guarantee.
--
-- ── What is the same ─────────────────────────────────────────────────────────
--
-- The body is AES-256-GCM under the same key, with the 16-byte tag appended to
-- the ciphertext and a fresh 12-byte nonce per row (ADR-0009). A database dump
-- must not be a transcript. `key_version` is here from the first row so rotation
-- stays a background re-encrypt job rather than a migration under pressure.
--
-- Additive: a new table, two new indexes and one new enum value. Nothing existing
-- is altered and no data is moved.

-- `TEXT` ids, like every other table here: Prisma generates `uuid(7)` and
-- `uuid(4)` in the client and the columns have been TEXT since 0001. A UUID
-- column would be the one table whose foreign keys could not be declared.
CREATE TABLE "direct_message" (
    "id"                TEXT           NOT NULL,
    "public_id"         TEXT           NOT NULL,
    "event_id"          TEXT           NOT NULL,
    "sender_user_id"    TEXT           NOT NULL,
    "recipient_user_id" TEXT           NOT NULL,
    "body_ciphertext"   BYTEA          NOT NULL,
    "body_nonce"        BYTEA          NOT NULL,
    "key_version"       INTEGER        NOT NULL,
    "parent_id"         TEXT,
    "seen_at"           TIMESTAMPTZ(3),
    "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "direct_message_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "direct_message_public_id_key" ON "direct_message"("public_id");

-- The recipient's inbox, newest first: the read behind «مشاهده».
CREATE INDEX "direct_message_inbox_idx"
    ON "direct_message"("recipient_user_id", "created_at" DESC);

-- Everything said about one activity, for a moderator reading a report about it.
CREATE INDEX "direct_message_event_idx" ON "direct_message"("event_id", "created_at");

ALTER TABLE "direct_message"
    ADD CONSTRAINT "direct_message_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "direct_message"
    ADD CONSTRAINT "direct_message_sender_user_id_fkey"
    FOREIGN KEY ("sender_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "direct_message"
    ADD CONSTRAINT "direct_message_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "direct_message"
    ADD CONSTRAINT "direct_message_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "direct_message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nobody messages themselves. The service refuses it too; this is the backstop
-- that survives a refactor of the service.
ALTER TABLE "direct_message"
    ADD CONSTRAINT "direct_message_not_self" CHECK ("sender_user_id" <> "recipient_user_id");
