-- Migration 0007: the transactional outbox.
--
-- Hand-written like 0001–0006. M7's own subject — waitlist promotion — needs no
-- schema of its own: a promoted user is an `event_participant` moving from
-- WAITLISTED to PENDING, which migration 0006 already models. What promotion
-- does need is somewhere to record that it happened, because ADR-0011 requires
-- both the promoted participant and the host to be notified, and ADR-0005 says a
-- notification is only safe if it commits with the state change that caused it.
--
-- The relay that drains this table is M13. Until then, rows accumulate as a
-- durable log of what happened — which is precisely what the relay will need to
-- find when it is built.

CREATE TABLE "outbox_event" (
    "id"             TEXT           NOT NULL,
    "aggregate_type" TEXT           NOT NULL,
    "aggregate_id"   TEXT           NOT NULL,
    "event_type"     TEXT           NOT NULL,
    "payload"        JSONB          NOT NULL,
    "processed_at"   TIMESTAMPTZ(3),
    "attempts"       INTEGER        NOT NULL DEFAULT 0,
    "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id"),

    -- An unprocessed row has made no delivery attempts to record, and a row that
    -- has been retried must not look unprocessed. Cheap to state, and it catches
    -- a relay that marks rows processed without clearing its own bookkeeping.
    CONSTRAINT "outbox_event_attempts_non_negative" CHECK ("attempts" >= 0)
);

-- The relay's only query: oldest unprocessed first. Partial, so the index holds
-- the backlog rather than every domain event the product has ever emitted — the
-- difference between an index that stays small forever and one that grows without
-- bound.
CREATE INDEX "outbox_event_unprocessed_idx"
    ON "outbox_event" ("created_at")
    WHERE "processed_at" IS NULL;

-- For answering "what happened to this participant?" without scanning.
CREATE INDEX "outbox_event_aggregate_type_aggregate_id_idx"
    ON "outbox_event" ("aggregate_type", "aggregate_id");
