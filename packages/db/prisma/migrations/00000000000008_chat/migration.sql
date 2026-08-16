-- Migration 0008: the anonymous chat.
--
-- Hand-written like 0001–0007. The constraints here are doing more than tidiness:
-- this is the table set that carries the product's differentiator, and every
-- property that can be a constraint is one, because the failure mode — an
-- identity crossing the boundary — is not one that can be safely discovered in
-- production.
--
-- Three things worth reading before the SQL:
--
-- 1. `chat_message` is NOT partitioned, though §4.4 and §3.8 both ask for monthly
--    partitioning from day one. Postgres requires the partition key to appear in
--    every unique index on a partitioned table, which turns `UNIQUE (chat_id,
--    seq)` into `UNIQUE (chat_id, seq, created_at)` — and a chat that spans a
--    month boundary could then hold two messages with the same seq. Retention is
--    keyed on *chat close*, not on message age, so monthly partitions could not
--    be dropped wholesale anyway; the purge is an indexed DELETE either way.
--    Deferred to M15 alongside `audit_log`, whose partitioning M1 deferred for
--    the neighbouring reason.
--
-- 2. `anonymous_chat.next_seq` is an addition to §4.4's field list. It is the seq
--    allocator: `UPDATE … SET next_seq = next_seq + 1 RETURNING next_seq` is one
--    statement, so two senders in the same chat serialise on it without anybody
--    taking an explicit lock. ADR-0006 keeps exactly one `SELECT … FOR UPDATE` in
--    the product and this is not going to be the second.
--
-- 3. `chat_action` is append-only by trigger, like `consent` and `audit_log`. It
--    records that somebody consented to share contact details, which is evidence;
--    evidence that can be edited is not evidence.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "chat_status" AS ENUM ('ANONYMOUS', 'OPEN', 'CLOSED', 'BLOCKED');
CREATE TYPE "chat_participant_role" AS ENUM ('HOST', 'GUEST');
CREATE TYPE "chat_message_kind" AS ENUM ('TEXT', 'SYSTEM');
CREATE TYPE "chat_action_type" AS ENUM ('ACCEPT', 'REJECT', 'CLOSE', 'SHARE_CONTACT', 'BLOCK');

-- ─────────────────────────────────────────────────────────────────────────────
-- anonymous_chat
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "anonymous_chat" (
    "id"                   TEXT           NOT NULL,
    "public_id"            TEXT           NOT NULL,
    "event_id"             TEXT           NOT NULL,
    "participant_id"       TEXT           NOT NULL,
    "status"               "chat_status"  NOT NULL DEFAULT 'ANONYMOUS',
    "next_seq"             INTEGER        NOT NULL DEFAULT 0,

    "opened_at"            TIMESTAMPTZ(3),
    "closed_at"            TIMESTAMPTZ(3),
    "closed_by_user_id"    TEXT,
    "close_reason"         TEXT,
    "retention_expires_at" TIMESTAMPTZ(3),

    "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "anonymous_chat_pkey" PRIMARY KEY ("id"),

    -- An OPEN chat has been opened, and a chat that was opened keeps the
    -- timestamp after it closes. Without this, M11's "was this chat ever open?"
    -- and M15's retention both read a column that some code path forgot to set.
    CONSTRAINT "anonymous_chat_opened_at_matches_status" CHECK (
        "status" <> 'OPEN' OR "opened_at" IS NOT NULL
    ),

    -- Both terminal states are terminal in the same way (plan §7): they stop the
    -- conversation and they start the 90-day clock. A closed chat with no
    -- `retention_expires_at` is a conversation that is never purged.
    CONSTRAINT "anonymous_chat_closed_is_complete" CHECK (
        "status" NOT IN ('CLOSED', 'BLOCKED')
        OR ("closed_at" IS NOT NULL AND "retention_expires_at" IS NOT NULL)
    ),

    -- …and the converse: a live chat must not be carrying a purge date, which
    -- would delete the messages of a conversation still in progress.
    CONSTRAINT "anonymous_chat_live_has_no_retention" CHECK (
        "status" IN ('CLOSED', 'BLOCKED') OR "retention_expires_at" IS NULL
    ),

    CONSTRAINT "anonymous_chat_next_seq_non_negative" CHECK ("next_seq" >= 0)
);

CREATE UNIQUE INDEX "anonymous_chat_public_id_key" ON "anonymous_chat" ("public_id");

-- One chat per request (plan §4.4). The UNIQUE makes "this request's chat" a
-- lookup that cannot return two rows, and it is what stops a retried join from
-- creating a second conversation for the same participant.
CREATE UNIQUE INDEX "anonymous_chat_participant_id_key" ON "anonymous_chat" ("participant_id");

CREATE INDEX "anonymous_chat_event_id_idx" ON "anonymous_chat" ("event_id");

-- The retention purge's query (M15). Partial, so the index holds closed chats
-- rather than every chat the product has ever hosted.
CREATE INDEX "anonymous_chat_retention_idx"
    ON "anonymous_chat" ("retention_expires_at")
    WHERE "retention_expires_at" IS NOT NULL;

ALTER TABLE "anonymous_chat"
    ADD CONSTRAINT "anonymous_chat_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "anonymous_chat"
    ADD CONSTRAINT "anonymous_chat_participant_id_fkey"
    FOREIGN KEY ("participant_id") REFERENCES "event_participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "anonymous_chat"
    ADD CONSTRAINT "anonymous_chat_closed_by_user_id_fkey"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- chat_participant
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat_participant" (
    "id"                TEXT                    NOT NULL,
    "chat_id"           TEXT                    NOT NULL,
    "user_id"           TEXT                    NOT NULL,
    "role"              "chat_participant_role" NOT NULL,
    "alias"             TEXT                    NOT NULL,
    "alias_index"       INTEGER                 NOT NULL,
    "contact_shared_at" TIMESTAMPTZ(3),
    "last_read_at"      TIMESTAMPTZ(3),
    "created_at"        TIMESTAMPTZ(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_participant_pkey" PRIMARY KEY ("id"),

    -- The host is index 0 and a guest is 1-based, which is what lets a host with
    -- five chats on one event tell «میهمان ۲» from «میهمان ۴» in a single Telegram
    -- thread. It also states the shape the alias formatter depends on.
    CONSTRAINT "chat_participant_alias_index_matches_role" CHECK (
        ("role" = 'HOST' AND "alias_index" = 0)
        OR ("role" = 'GUEST' AND "alias_index" >= 1)
    ),

    CONSTRAINT "chat_participant_alias_not_empty" CHECK (length(btrim("alias")) > 0)
);

-- One row per person per chat. A 1:1 chat has exactly two.
CREATE UNIQUE INDEX "chat_participant_chat_id_user_id_key"
    ON "chat_participant" ("chat_id", "user_id");

-- Plan §4.4. Two participants of one chat cannot share an alias, or a recipient
-- could not tell who said what.
CREATE UNIQUE INDEX "chat_participant_chat_id_alias_index_key"
    ON "chat_participant" ("chat_id", "alias_index");

CREATE INDEX "chat_participant_user_id_idx" ON "chat_participant" ("user_id");

ALTER TABLE "chat_participant"
    ADD CONSTRAINT "chat_participant_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "anonymous_chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_participant"
    ADD CONSTRAINT "chat_participant_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- chat_message
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat_message" (
    "id"                         TEXT                NOT NULL,
    "chat_id"                    TEXT                NOT NULL,
    "sender_participant_id"      TEXT,
    "seq"                        INTEGER             NOT NULL,
    "kind"                       "chat_message_kind" NOT NULL DEFAULT 'TEXT',

    "body_ciphertext"            BYTEA               NOT NULL,
    "body_nonce"                 BYTEA               NOT NULL,
    "key_version"                INTEGER             NOT NULL,

    "redactions"                 JSONB               NOT NULL DEFAULT '[]',
    "moderation_flags"           JSONB               NOT NULL DEFAULT '[]',

    "source_telegram_message_id" BIGINT,
    "telegram_message_ids"       JSONB               NOT NULL DEFAULT '{}',

    "edited_at"                  TIMESTAMPTZ(3),
    "deleted_at"                 TIMESTAMPTZ(3),
    "retention_expires_at"       TIMESTAMPTZ(3),
    "created_at"                 TIMESTAMPTZ(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_pkey" PRIMARY KEY ("id"),

    -- A TEXT message was said by somebody; a SYSTEM message was not, because the
    -- platform is not a participant. Getting this wrong in either direction
    -- produces a message attributed to nobody or an announcement attributed to a
    -- user, and both are visible to a recipient.
    CONSTRAINT "chat_message_sender_matches_kind" CHECK (
        ("kind" = 'TEXT' AND "sender_participant_id" IS NOT NULL)
        OR ("kind" = 'SYSTEM' AND "sender_participant_id" IS NULL)
    ),

    -- 12-byte GCM nonce, and a body long enough to hold the 16-byte
    -- authentication tag that `MessageCipher` appends. A row failing either is a
    -- row that will not decrypt, and finding that out at write time beats finding
    -- it out when somebody opens the conversation.
    CONSTRAINT "chat_message_nonce_length" CHECK (octet_length("body_nonce") = 12),
    CONSTRAINT "chat_message_body_holds_tag" CHECK (octet_length("body_ciphertext") >= 16),

    CONSTRAINT "chat_message_seq_positive" CHECK ("seq" >= 1),

    -- A Telegram message id comes from a real inbound message, so it belongs only
    -- to something a user sent.
    CONSTRAINT "chat_message_source_id_needs_sender" CHECK (
        "source_telegram_message_id" IS NULL OR "sender_participant_id" IS NOT NULL
    )
);

-- Plan §4.4, and the reason `next_seq` exists. Gap-free per-chat ordering is what
-- makes "everything after seq N" a correct incremental read rather than an
-- approximation.
CREATE UNIQUE INDEX "chat_message_chat_id_seq_key" ON "chat_message" ("chat_id", "seq");

-- The read path: the newest page of a conversation.
CREATE INDEX "chat_message_recent_idx" ON "chat_message" ("chat_id", "seq" DESC);

-- The edit path (D10): find this sender's message carrying that Telegram id.
-- Partial, because only bot-originated messages have one.
CREATE INDEX "chat_message_source_idx"
    ON "chat_message" ("sender_participant_id", "source_telegram_message_id")
    WHERE "source_telegram_message_id" IS NOT NULL;

-- The retention purge (M15).
CREATE INDEX "chat_message_retention_idx"
    ON "chat_message" ("retention_expires_at")
    WHERE "retention_expires_at" IS NOT NULL;

ALTER TABLE "chat_message"
    ADD CONSTRAINT "chat_message_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "anonymous_chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_message"
    ADD CONSTRAINT "chat_message_sender_participant_id_fkey"
    FOREIGN KEY ("sender_participant_id") REFERENCES "chat_participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- chat_action — append-only
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat_action" (
    "id"            TEXT               NOT NULL,
    "chat_id"       TEXT               NOT NULL,
    "actor_user_id" TEXT,
    "action"        "chat_action_type" NOT NULL,
    "detail"        JSONB,
    "created_at"    TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_action_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_action_chat_id_created_at_idx" ON "chat_action" ("chat_id", "created_at");

ALTER TABLE "chat_action"
    ADD CONSTRAINT "chat_action_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "anonymous_chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_action"
    ADD CONSTRAINT "chat_action_actor_user_id_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same shape as `audit_log` and `consent` (migration 0001, 0002), including the
-- retention escape hatch: the M15 purge sets `payetam.retention_purge` for the
-- length of its transaction, and nothing else can delete a row. `chat_action`
-- records a consent decision made inside a private conversation, so it is
-- evidence in the same sense `consent` is.
CREATE OR REPLACE FUNCTION "chat_action_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'chat_action is append-only: UPDATE is not permitted';
    END IF;

    IF TG_OP = 'DELETE'
       AND coalesce(current_setting('payetam.retention_purge', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'chat_action is append-only: DELETE is permitted only by the retention job';
    END IF;

    -- OLD, not NULL: a BEFORE trigger returning NULL cancels the row operation,
    -- which would turn the permitted retention delete into a silent no-op.
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "chat_action_append_only"
    BEFORE UPDATE OR DELETE ON "chat_action"
    FOR EACH ROW EXECUTE FUNCTION "chat_action_is_append_only"();
