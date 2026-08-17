-- Migration 0013: notifications and the dead-letter queue (ADR-0005).
--
-- Two tables, and both exist because of the same argument: **a queue is not a
-- record**. Redis can be flushed, replayed or migrated, and a job that only ever
-- existed there leaves nothing behind when it does.
--
-- 1. `notification.dedupe_key` is the second of two independent idempotency
--    layers. The first is BullMQ's deterministic `jobId`; this is a UNIQUE index
--    in Postgres. Either alone would cover most failure modes, and they fail
--    independently — a flushed queue defeats the first and not the second.
--
-- 2. `job_failure` is the DLQ mirrored into Postgres, so an exhausted job is an
--    inspectable, re-drivable row rather than a log line somebody has to find.

CREATE TYPE "notification_channel" AS ENUM ('TELEGRAM');
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'UNDELIVERABLE');

-- ─────────────────────────────────────────────────────────────────────────────
-- notification
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "notification" (
    "id"                  TEXT                   NOT NULL,
    "user_id"             TEXT                   NOT NULL,
    "channel"             "notification_channel" NOT NULL DEFAULT 'TELEGRAM',
    "template_key"        TEXT                   NOT NULL,
    "payload"             JSONB                  NOT NULL,
    "dedupe_key"          TEXT                   NOT NULL,
    "status"              "notification_status"  NOT NULL DEFAULT 'PENDING',
    "attempts"            INTEGER                NOT NULL DEFAULT 0,
    "last_error"          TEXT,
    "telegram_message_id" INTEGER,
    "created_at"          TIMESTAMPTZ(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at"             TIMESTAMPTZ(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "notification_attempts_non_negative" CHECK ("attempts" >= 0),

    -- A sent notification says when, and one that has not been sent must not
    -- claim to have been. `sent_at` is what a support conversation reads to
    -- answer "did we tell them?".
    CONSTRAINT "notification_sent_at_matches_status" CHECK (
        ("status" = 'SENT') = ("sent_at" IS NOT NULL)
    )
);

-- **Exactly once, in the database.** The queue's deterministic job id is the
-- other layer; this one holds when the queue does not exist any more.
CREATE UNIQUE INDEX "notification_dedupe_key_key" ON "notification" ("dedupe_key");

CREATE INDEX "notification_user_id_created_at_idx" ON "notification" ("user_id", "created_at");
CREATE INDEX "notification_status_created_at_idx" ON "notification" ("status", "created_at");

-- CASCADE, unlike `consent` and the ledgers: a notification is a delivery record,
-- not evidence. M15's anonymisation should take them with the account.
ALTER TABLE "notification"
    ADD CONSTRAINT "notification_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- job_failure — the DLQ, in Postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "job_failure" (
    "id"          TEXT           NOT NULL,
    "queue"       TEXT           NOT NULL,
    "job_name"    TEXT           NOT NULL,
    "job_id"      TEXT           NOT NULL,
    "payload"     JSONB          NOT NULL,
    "error"       TEXT           NOT NULL,
    "attempts"    INTEGER        NOT NULL DEFAULT 0,
    "redriven_at" TIMESTAMPTZ(3),
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_failure_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "job_failure_attempts_non_negative" CHECK ("attempts" >= 0)
);

-- One row per failed job. A job re-driven and failing again updates its row
-- rather than accumulating a new one each time, so the queue depth in the admin
-- panel is the number of distinct problems and not the number of attempts.
CREATE UNIQUE INDEX "job_failure_queue_job_id_key" ON "job_failure" ("queue", "job_id");
CREATE INDEX "job_failure_created_at_idx" ON "job_failure" ("created_at");
CREATE INDEX "job_failure_redriven_at_idx" ON "job_failure" ("redriven_at");
