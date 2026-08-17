-- Migration 0014: channel publishing (M14).
--
-- One table and one index that matters. `UNIQUE (event_id, kind)` is the plan's
-- "no duplicate post per event per kind", decided by the database rather than by
-- a check the publisher has to remember — the publisher inserts and lets the
-- index answer, because a read-then-write has a window and a channel that
-- double-posts is a channel people mute.
--
-- The kinds are deliberately not interchangeable. VIP and BOOSTED are **bought**
-- (M9's two coin sinks); TRENDING is **earned** by demand. Keeping them apart is
-- what lets one event appear once for each reason without the channel repeating
-- itself, and what keeps "did they pay for this placement?" answerable later.

CREATE TYPE "channel_post_kind" AS ENUM ('VIP', 'BOOSTED', 'TRENDING');

CREATE TABLE "channel_post" (
    "id"                  TEXT                NOT NULL,
    "event_id"            TEXT                NOT NULL,
    "kind"                "channel_post_kind" NOT NULL,
    "telegram_message_id" INTEGER,
    "posted_at"           TIMESTAMPTZ(3),
    "deleted_at"          TIMESTAMPTZ(3),
    "created_at"          TIMESTAMPTZ(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_post_pkey" PRIMARY KEY ("id"),

    -- A posted row knows what Telegram called it, because that id is the only way
    -- to delete the post later. A row claiming to be posted with no id is a post
    -- nothing can ever take down.
    CONSTRAINT "channel_post_posted_has_message_id" CHECK (
        ("posted_at" IS NULL) = ("telegram_message_id" IS NULL)
    ),

    -- Nothing is deleted before it is posted.
    CONSTRAINT "channel_post_deleted_after_posted" CHECK (
        "deleted_at" IS NULL OR "posted_at" IS NOT NULL
    )
);

-- The duplicate guard.
CREATE UNIQUE INDEX "channel_post_event_id_kind_key" ON "channel_post" ("event_id", "kind");

-- The takedown sweep's read: posts that are live and whose event no longer is.
CREATE INDEX "channel_post_deleted_at_posted_at_idx" ON "channel_post" ("deleted_at", "posted_at");

ALTER TABLE "channel_post"
    ADD CONSTRAINT "channel_post_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
