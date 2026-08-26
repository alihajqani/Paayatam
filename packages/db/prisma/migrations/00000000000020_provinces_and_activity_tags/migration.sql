-- Migration 0020: the rest of Iran, and activity tags an admin can edit.
--
-- Hand-written like 0001–0019. Two changes that arrived together because they
-- are the same product decision seen from two sides: the launch was Tehran with
-- two activity categories (plan §2), and this is the migration that stops the
-- schema from assuming either.
--
-- ── Every statement here is additive, and that is load-bearing ───────────────
--
-- Nothing is dropped, renamed or narrowed. `city.province_id` is NULLABLE, and
-- `category.allows_custom_label` and `event.custom_category_label` both have a
-- default or accept NULL. The consequence is the one that matters on a database
-- with live users in it: **every existing row is already valid the instant this
-- migration commits**, so there is no backfill window during which the old code
-- and the new schema disagree, and `prisma migrate deploy` needs no downtime.
--
-- `province_id` stays nullable *permanently*, not just until a backfill runs.
-- Making it NOT NULL later would mean either a lock on `city` or a moment when
-- an admin cannot create a city without knowing its province — and a city whose
-- province nobody has recorded is a real state, not a broken one. The seed fills
-- in all 1,252 of them; the column tolerating a gap is what lets an admin add
-- the 1,253rd from the panel before anybody has decided where to file it.

-- ─────────────────────────────────────────────────────────────────────────────
-- province
--
-- `is_active` defaults to TRUE, where `city.is_active` defaults to FALSE. The
-- asymmetry is deliberate: deactivating a *city* is how the product says "we do
-- not serve here yet", which is a per-city decision someone makes. A province is
-- a grouping in a picker, and a province that exists but is hidden would strand
-- the cities filed under it with no way to reach them.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "province" (
    "id"         TEXT           NOT NULL,
    "slug"       TEXT           NOT NULL,
    "name_fa"    TEXT           NOT NULL,
    "is_active"  BOOLEAN        NOT NULL DEFAULT true,
    "sort_order" INTEGER        NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "province_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "province_slug_key"                 ON "province" ("slug");
CREATE INDEX "province_is_active_sort_order_idx"        ON "province" ("is_active", "sort_order");

-- ─────────────────────────────────────────────────────────────────────────────
-- city.province_id
--
-- ON DELETE RESTRICT, matching every other catalog reference in this schema:
-- rows here are deactivated, never deleted, precisely so the profiles and events
-- pointing at them are not orphaned (migration 0003's opening comment).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "city" ADD COLUMN "province_id" TEXT;

ALTER TABLE "city"
    ADD CONSTRAINT "city_province_id_fkey"
    FOREIGN KEY ("province_id") REFERENCES "province" ("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The picker's query: the active cities of one province, in order. Leading with
-- `province_id` rather than appending it to the existing
-- `(is_active, sort_order)` index is what makes that an index scan of ~40 rows
-- instead of a scan of all 1,252 filtered down.
CREATE INDEX "city_province_id_is_active_sort_order_idx"
    ON "city" ("province_id", "is_active", "sort_order");

-- ─────────────────────────────────────────────────────────────────────────────
-- category.allows_custom_label — the «سایر» flag
--
-- A column rather than a hardcoded `slug = 'other'` check in the application.
-- The difference shows up the first time somebody wants a second catch-all, or
-- renames the row, or seeds a test fixture: a flag is data the admin panel can
-- set, and a slug comparison is a branch in code that a rename silently breaks.
--
-- FALSE for every existing row, so the two categories the product launched with
-- keep behaving exactly as they do now.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "category" ADD COLUMN "allows_custom_label" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- event.custom_category_label
--
-- What the host called their activity, when they picked a category that allows
-- one. NULL for every event that exists and for every event under a category
-- that does not allow it.
--
-- **No `_normalized` twin, and no place in `search_vector`.** That is not an
-- omission. The 0005 trigger fires on `UPDATE OF title_normalized,
-- description_normalized`, and adding a third source column would mean editing a
-- trigger that sits on the most contended write path in the product (M6 updates
-- `accepted_count` under a row lock; see 0005's note). The label is scanned
-- against the blacklist on write — `ModerationService.scanEventContent` takes it
-- alongside the title — so it is *moderated*, it is just not *searchable*. If it
-- should be searchable later, the honest way is to fold it into the title's
-- normalized copy, not to widen the trigger.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "event" ADD COLUMN "custom_category_label" TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- city_category — which activity tags a city offers
--
-- The semantics that make this migration-safe: **an empty set means "every
-- city"**. A category with no rows here is offered everywhere, which is what
-- every existing category is on the day this table is created — so the table
-- starts empty and nothing changes until an admin deliberately restricts one.
--
-- The inverse convention (a category must be listed to be offered) would have
-- required backfilling 1,252 × N rows on deploy just to preserve today's
-- behaviour, and would have made "I added a city and every activity vanished"
-- the default experience.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "city_category" (
    "city_id"     TEXT           NOT NULL,
    "category_id" TEXT           NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "city_category_pkey" PRIMARY KEY ("city_id", "category_id")
);

-- CASCADE on both sides, unlike the catalog's usual RESTRICT: a row here is a
-- *restriction*, not a reference somebody's data depends on. Deleting it widens
-- availability rather than orphaning anything, so there is nothing to protect.
ALTER TABLE "city_category"
    ADD CONSTRAINT "city_category_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "city" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "city_category"
    ADD CONSTRAINT "city_category_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "category" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- "Which cities is this category restricted to" — the admin panel's read.
CREATE INDEX "city_category_category_id_idx" ON "city_category" ("category_id");
