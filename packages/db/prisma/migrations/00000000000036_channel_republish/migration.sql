-- Migration 0036: an event can reach the channel more than once.
--
-- Additive. Two nullable/defaulted columns and one index swapped for a wider one
-- that is satisfied by every existing row without touching it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the unique index had to change, and why it could not simply be dropped
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `UNIQUE (event_id, kind)` carried two jobs at once. The first is exactly-once
-- purchasing: it is what makes a double-tapped «انتشار در کانال» one post and one
-- charge. The second is stated in `markTakenDown` — a post removed by moderation
-- keeps its row, and *"stops the event being re-posted the moment it becomes
-- publishable again, because the unique index still holds"*.
--
-- Re-publication needs the first job and must not lose the second, so the index
-- is widened rather than made partial. A partial `WHERE deleted_at IS NULL` would
-- have freed exactly the case the second job exists to forbid: a VIP post taken
-- down by a moderator would be re-claimed by the next sweep, for free.
--
-- `republish_seq` is the discriminator. Every row that exists today is seq 0 and
-- keeps behaving identically — including staying blocked after a takedown, since
-- nothing raises the sequence except a host paying to renew. A renewal writes
-- seq 1, then 2, and each is a distinct purchase with its own ledger row.
ALTER TABLE "channel_post"
    ADD COLUMN "republish_seq" INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- Superseding, so the channel does not accumulate duplicates
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A renewal is "post it again so it is seen again", which means the previous post
-- should come down — otherwise the channel carries two copies of one activity and
-- the older one is the one people scroll past.
--
-- The takedown sweep reads `deleted_at IS NULL AND posted_at IS NOT NULL` and
-- decides from the *event's* state, which cannot express "this post is fine, it
-- has simply been replaced". So the replacement says so on the row it replaces,
-- and `findTakedowns` treats it as one more reason to remove a message.
--
-- Separate from `deleted_at` because they mean different things and are written
-- at different times: `superseded_at` is set when the renewal is purchased, and
-- `deleted_at` when Telegram has confirmed the old message is gone.
ALTER TABLE "channel_post"
    ADD COLUMN "superseded_at" TIMESTAMPTZ(3);

DROP INDEX "channel_post_event_id_kind_key";
CREATE UNIQUE INDEX "channel_post_event_id_kind_republish_seq_key"
    ON "channel_post" ("event_id", "kind", "republish_seq");

-- The sweep's read: a post that is live and has been replaced.
CREATE INDEX "channel_post_superseded_at_idx"
    ON "channel_post" ("superseded_at")
    WHERE "superseded_at" IS NOT NULL AND "deleted_at" IS NULL;

-- A sequence only ever moves forward, and only a paid renewal moves it. VIP,
-- boosted and trending claims are derived from the event's own state by the
-- sweep, so a non-zero sequence on one of them would mean something nothing in
-- the product knows how to produce.
ALTER TABLE "channel_post"
    ADD CONSTRAINT "channel_post_republish_seq_paid_only" CHECK (
        "republish_seq" = 0 OR "kind" = 'PAID'
    );
ALTER TABLE "channel_post"
    ADD CONSTRAINT "channel_post_republish_seq_non_negative" CHECK ("republish_seq" >= 0);
