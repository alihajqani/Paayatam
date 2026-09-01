-- Migration 0033: what the v0.6.5 QA round needed the schema to hold.
--
-- Two additions and one new table, all additive: no column is dropped, no type
-- is narrowed, and every existing row is valid under the new constraints without
-- being touched. A rollback to the previous release runs against this schema
-- unchanged — the code simply stops writing the new columns.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. event.district_label — a neighbourhood the host typed
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `district` is a curated table whose rows nothing creates: the geography seed
-- says outright that the dataset has none, and the admin panel can deactivate a
-- district but not add one. So the bot's «کدام محله؟» step has been drawing an
-- empty keyboard in every deployment that exists, and «رد کردن» was the only
-- available answer to it.
--
-- Free text beside the foreign key rather than instead of it. A curated district
-- can be filtered, ranked and moderated as an entity; typed text cannot, and
-- collapsing the two would lose that for the cities where the catalogue is
-- populated. The CHECK is what stops one event carrying two different answers to
-- "where is this?".
ALTER TABLE "event"
    ADD COLUMN "district_label" TEXT;

ALTER TABLE "event"
    ADD CONSTRAINT "event_district_one_answer" CHECK (
        "district_id" IS NULL OR "district_label" IS NULL
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. bug_report — what a user says is broken, with the screenshots
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Deliberately **not** a `report` row. `report` is moderation: it is about a
-- person or a thing they posted, it is subject to invariant 5's one-per-reporter
-- UNIQUE, it feeds an auto-hide threshold and it opens a moderation case. A bug
-- report is about the *product*, has no target to hide, and a user who finds
-- three bugs should be able to file three — so the tables share neither shape
-- nor lifecycle, and reusing one for the other would put "hide this after three
-- reports" in reach of a screenshot of a broken button.
--
-- Screenshots are stored as Telegram `file_id` strings, not bytes. The file
-- already lives on Telegram's servers, the bot can fetch it on demand, and
-- copying it into this deployment's storage would mean a retention policy, a
-- deletion path and a virus-scanning question for an image the reporter has
-- already published to the bot. `file_id` is scoped to this bot token: it is not
-- a public URL and is worthless to anybody else.
CREATE TYPE "bug_report_status" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');

CREATE TABLE "bug_report" (
    "id"          TEXT NOT NULL,
    "public_id"   TEXT NOT NULL,
    "user_id"     TEXT NOT NULL,
    "description" TEXT NOT NULL,
    -- Telegram file ids, newest last. An array rather than a child table: it is
    -- read only with its parent, never joined against, and never queried by
    -- element.
    "screenshot_file_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Which release the reporter was on. The single most useful field on a bug
    -- report and the one nobody remembers to ask for, so it is recorded rather
    -- than requested.
    "app_version" TEXT,
    "status"      "bug_report_status" NOT NULL DEFAULT 'OPEN',
    "admin_note"  TEXT,
    "handled_by_admin_id" TEXT,
    "handled_at"  TIMESTAMPTZ(3),
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bug_report_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bug_report_public_id_key" ON "bug_report" ("public_id");
-- The queue: oldest open first is how it is worked.
CREATE INDEX "bug_report_status_created_at_idx" ON "bug_report" ("status", "created_at");
-- "What has this person reported?", for the support conversation that follows.
CREATE INDEX "bug_report_user_id_created_at_idx" ON "bug_report" ("user_id", "created_at");

-- At most ten screenshots, and at least a sentence. Both in the database rather
-- than only in the wizard, because this table is also reachable from a script.
ALTER TABLE "bug_report"
    ADD CONSTRAINT "bug_report_description_not_empty" CHECK (length(btrim("description")) >= 10);
ALTER TABLE "bug_report"
    ADD CONSTRAINT "bug_report_screenshot_cap" CHECK (array_length("screenshot_file_ids", 1) IS NULL
                                                      OR array_length("screenshot_file_ids", 1) <= 10);
-- Handled means handled *by* somebody, at a time. Three columns that move
-- together, said out loud — the same discipline `message_campaign_actor_consistent`
-- uses.
ALTER TABLE "bug_report"
    ADD CONSTRAINT "bug_report_handled_consistent" CHECK (
        ("status" IN ('OPEN')          AND "handled_at" IS NULL) OR
        ("status" NOT IN ('OPEN')      AND "handled_at" IS NOT NULL)
    );

ALTER TABLE "bug_report"
    ADD CONSTRAINT "bug_report_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bug_report"
    ADD CONSTRAINT "bug_report_handled_by_admin_id_fkey"
    FOREIGN KEY ("handled_by_admin_id") REFERENCES "admin_user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
