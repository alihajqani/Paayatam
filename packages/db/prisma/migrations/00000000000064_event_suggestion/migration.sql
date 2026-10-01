-- Migration 0064: event suggestions — a real outside programme an operator
-- found (a screening, a play, a group hike), offered in the channel as
-- «میزبانش می‌شوم».
--
-- ── What a row is ───────────────────────────────────────────────────────────
--
-- Not an event. Nobody hosts a suggestion and nobody joins one: it is the
-- pre-filled answer to the event wizard, and an event exists only once a user
-- taps the link and confirms. The columns are therefore the wizard's own
-- fields with the wizard's own bounds — a suggestion the wizard would refuse
-- is a link that opens on an error.
--
-- `closed_at` rather than a status enum: a suggestion is open until an
-- operator closes it or its start passes, and the second half is read from
-- `starts_at`, so one nullable timestamp says everything a status would.
--
-- `created_by_admin_id` has no foreign key, as `city_seed_config` has none:
-- the audit log is the record of who did what; this column is a convenience.
--
-- ── `event.suggestion_id` ───────────────────────────────────────────────────
--
-- Which events came from a suggestion — the number the founding experiment is
-- judged by, and what routes the second person who taps a link to the first
-- person's event instead of a second empty one. RESTRICT, because suggestions
-- are closed, never deleted.
--
-- ── Additive, and inert if the code is rolled back ──────────────────────────
--
-- One table and one nullable column. The previous image never reads either.

CREATE TABLE IF NOT EXISTS "event_suggestion" (
  "id"                  TEXT           NOT NULL,
  "public_id"           TEXT           NOT NULL,
  "city_id"             TEXT           NOT NULL,
  "category_id"         TEXT           NOT NULL,
  "title"               TEXT           NOT NULL,
  "description"         TEXT           NOT NULL,
  "venue_label"         TEXT           NOT NULL,
  "starts_at"           TIMESTAMPTZ(3) NOT NULL,
  "duration_hours"      INTEGER        NOT NULL,
  "capacity"            INTEGER        NOT NULL DEFAULT 4,
  "cost_type"           "cost_type"    NOT NULL,
  "cost_amount"         INTEGER,
  "external_link"       TEXT,
  "created_by_admin_id" TEXT           NOT NULL,
  "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at"           TIMESTAMPTZ(3),

  CONSTRAINT "event_suggestion_pkey" PRIMARY KEY ("id"),

  -- The wizard's bounds (create-event.ts): title, description, the typed
  -- neighbourhood the venue becomes, a duration of 1–24 hours, a capacity up
  -- to UNLIMITED_CAPACITY.
  CONSTRAINT "event_suggestion_title_length"
    CHECK (char_length("title") BETWEEN 3 AND 80),
  CONSTRAINT "event_suggestion_description_length"
    CHECK (char_length("description") BETWEEN 10 AND 2000),
  CONSTRAINT "event_suggestion_venue_length"
    CHECK (char_length("venue_label") BETWEEN 2 AND 60),
  CONSTRAINT "event_suggestion_duration_range"
    CHECK ("duration_hours" BETWEEN 1 AND 24),
  CONSTRAINT "event_suggestion_capacity_range"
    CHECK ("capacity" BETWEEN 1 AND 1000),

  -- The same two rules `event` has (migration 0004), so a suggestion can never
  -- hold a cost or a link the event it becomes would refuse.
  CONSTRAINT "event_suggestion_cost_amount_matches_type" CHECK (
    ("cost_type" IN ('FIXED', 'APPROX') AND "cost_amount" IS NOT NULL AND "cost_amount" >= 0)
    OR ("cost_type" IN ('FREE', 'SPLIT') AND "cost_amount" IS NULL)
  ),
  CONSTRAINT "event_suggestion_external_link_https"
    CHECK ("external_link" IS NULL OR "external_link" LIKE 'https://%')
);

-- The link carries this, so it is the lookup every tap makes.
CREATE UNIQUE INDEX IF NOT EXISTS "event_suggestion_public_id_key"
  ON "event_suggestion"("public_id");

-- The panel's list, newest programme first, per city.
CREATE INDEX IF NOT EXISTS "event_suggestion_city_id_starts_at_idx"
  ON "event_suggestion"("city_id", "starts_at");

DO $$ BEGIN
  ALTER TABLE "event_suggestion"
    ADD CONSTRAINT "event_suggestion_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "event_suggestion"
    ADD CONSTRAINT "event_suggestion_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "suggestion_id" TEXT;

DO $$ BEGIN
  ALTER TABLE "event"
    ADD CONSTRAINT "event_suggestion_id_fkey"
    FOREIGN KEY ("suggestion_id") REFERENCES "event_suggestion"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Partial: almost every event has no suggestion, and the only question asked
-- of this column is "which events came from suggestion X".
CREATE INDEX IF NOT EXISTS "event_suggestion_id_idx"
  ON "event"("suggestion_id") WHERE "suggestion_id" IS NOT NULL;
