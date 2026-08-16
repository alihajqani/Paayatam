-- Migration 0006: participation, the waitlist, and the seat accounting.
--
-- Hand-written like 0001–0005. What cannot be expressed in schema.prisma here is
-- the set of CHECK constraints tying each status to the timestamps that explain
-- it.
--
-- The capacity invariant itself is NOT added here: `accepted_count <= capacity`
-- is a CHECK on `event`, added in 0004. This migration adds the rows that move
-- that counter, and ADR-0006's rule is that every code path which moves it does
-- so while holding `SELECT … FOR UPDATE` on the event row. The CHECK is the
-- backstop for the day someone forgets.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "participant_status" AS ENUM (
    'PENDING',
    'WAITLISTED',
    'ACCEPTED',
    'REJECTED',
    'EXPIRED',
    'CANCELLED_BY_PARTICIPANT',
    'CANCELLED_BY_HOST',
    'COMPLETED',
    'NO_SHOW'
);

CREATE TYPE "cancellation_bucket" AS ENUM ('GRACE', 'GT_24H', 'H24_TO_H3', 'LT_3H', 'NO_SHOW');

-- ─────────────────────────────────────────────────────────────────────────────
-- event_participant
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "event_participant" (
    "id"                  TEXT                 NOT NULL,
    "public_id"           TEXT                 NOT NULL,
    "event_id"            TEXT                 NOT NULL,
    "user_id"             TEXT                 NOT NULL,
    "status"              "participant_status" NOT NULL DEFAULT 'PENDING',

    "requested_at"        TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at"          TIMESTAMPTZ(3),
    "accepted_at"         TIMESTAMPTZ(3),
    "cancelled_at"        TIMESTAMPTZ(3),
    "grace_expires_at"    TIMESTAMPTZ(3),
    "host_deadline_at"    TIMESTAMPTZ(3),
    "promoted_at"         TIMESTAMPTZ(3),

    "cancellation_reason" TEXT,
    "cancellation_bucket" "cancellation_bucket",
    "penalty_ledger_id"   TEXT,

    "attended"            BOOLEAN,
    "version"             INTEGER              NOT NULL DEFAULT 0,

    "created_at"          TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(3)       NOT NULL,

    CONSTRAINT "event_participant_pkey" PRIMARY KEY ("id"),

    -- `accepted_at` is present exactly when the row has been accepted at some
    -- point. Stated as a CASE rather than a biconditional because the statuses
    -- that follow acceptance legitimately keep the timestamp, while the ones
    -- that precede it must not have one: a stale `accepted_at` on a PENDING row
    -- would give M11's review window a date that never happened.
    CONSTRAINT "event_participant_accepted_at_matches_status" CHECK (
        CASE
            WHEN "status" = 'ACCEPTED' THEN "accepted_at" IS NOT NULL
            WHEN "status" IN ('PENDING', 'WAITLISTED', 'REJECTED', 'EXPIRED')
                THEN "accepted_at" IS NULL
            ELSE TRUE
        END
    ),

    -- Every cancelled row says when it was cancelled. A row without it means a
    -- code path invented a fourth way to cancel.
    CONSTRAINT "event_participant_cancelled_at_present" CHECK (
        "status" NOT IN ('CANCELLED_BY_PARTICIPANT', 'CANCELLED_BY_HOST')
        OR "cancelled_at" IS NOT NULL
    ),

    -- A promotion timestamp only means something for a row that left the
    -- waitlist, and a promoted row can never be WAITLISTED again.
    CONSTRAINT "event_participant_promoted_not_waitlisted" CHECK (
        "promoted_at" IS NULL OR "status" <> 'WAITLISTED'
    ),

    -- A penalty belongs to a cancellation or a no-show. Attached to anything
    -- else it is a charge with nothing to justify it (M10).
    CONSTRAINT "event_participant_penalty_needs_bucket" CHECK (
        "penalty_ledger_id" IS NULL OR "cancellation_bucket" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "event_participant_public_id_key" ON "event_participant" ("public_id");

-- Invariant 4, and the duplicate-request guard the join path relies on. The join
-- inserts with ON CONFLICT DO NOTHING and reads the row count: "no row inserted"
-- is DUPLICATE_REQUEST. A read-then-write existence check would have a race
-- window between the read and the insert; this has none.
CREATE UNIQUE INDEX "event_participant_event_id_user_id_key"
    ON "event_participant" ("event_id", "user_id");

CREATE INDEX "event_participant_event_id_status_idx"
    ON "event_participant" ("event_id", "status");
CREATE INDEX "event_participant_user_id_status_idx"
    ON "event_participant" ("user_id", "status");

-- The waitlist queue, in exactly the order promotion reads it (ADR-0006: FIFO by
-- `(requested_at, id)`). Partial, so an event with a thousand settled requests
-- and three people waiting has a three-row index.
CREATE INDEX "event_participant_waitlist_idx"
    ON "event_participant" ("event_id", "requested_at", "id")
    WHERE "status" = 'WAITLISTED';

ALTER TABLE "event_participant"
    ADD CONSTRAINT "event_participant_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event_participant"
    ADD CONSTRAINT "event_participant_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event_participant"
    ADD CONSTRAINT "event_participant_penalty_ledger_id_fkey"
    FOREIGN KEY ("penalty_ledger_id") REFERENCES "coin_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
