-- Migration 0062: blocking a sender, and a clock on direct messages.
--
-- ── What changed ────────────────────────────────────────────────────────────
--
-- Two decisions about direct messages, recorded in ADR-0020:
--
--  * A recipient may block the person writing to them. Until now the only
--    answer to an unwanted message was a report, which asks a moderator to act
--    on something the recipient could have settled alone.
--  * Direct messages are kept for 180 days from when they were written, then
--    purged. v0.8.0 deliberately kept them forever; the privacy notice now
--    promises 180 days, and `RetentionService` keeps that promise.
--
-- ── Additive, and inert if the code is rolled back ──────────────────────────
--
-- One table and one index. The previous image never reads the table, so a
-- rollback leaves blocks recorded but unenforced, and the index is only a read
-- path for the purge.

CREATE TABLE IF NOT EXISTS "direct_message_block" (
  "id"              TEXT           NOT NULL,
  "blocker_user_id" TEXT           NOT NULL,
  "blocked_user_id" TEXT           NOT NULL,
  "created_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "direct_message_block_pkey" PRIMARY KEY ("id"),

  -- Blocking yourself is a request nothing in the product can make; a row that
  -- said so would make "who has blocked this sender?" answer with the sender.
  CONSTRAINT "direct_message_block_not_self" CHECK ("blocker_user_id" <> "blocked_user_id"),

  -- RESTRICT, like every other reference to `user`: accounts are anonymised,
  -- never deleted, so neither side of a block ever disappears from under it.
  CONSTRAINT "direct_message_block_blocker_user_id_fkey" FOREIGN KEY ("blocker_user_id")
    REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "direct_message_block_blocked_user_id_fkey" FOREIGN KEY ("blocked_user_id")
    REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Blocking twice is one block.
CREATE UNIQUE INDEX IF NOT EXISTS "direct_message_block_blocker_user_id_blocked_user_id_key"
  ON "direct_message_block"("blocker_user_id", "blocked_user_id");

-- The other half of the write check: has anybody blocked this sender?
CREATE INDEX IF NOT EXISTS "direct_message_block_blocked_user_id_idx"
  ON "direct_message_block"("blocked_user_id");

-- The retention purge reads everything written before a cutoff, whoever it is
-- between; neither existing index leads on `created_at`.
CREATE INDEX IF NOT EXISTS "direct_message_created_idx"
  ON "direct_message"("created_at");
