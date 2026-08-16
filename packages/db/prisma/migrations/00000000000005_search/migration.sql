-- Migration 0005: full-text and trigram search over events (ADR-0012).
--
-- The one thing that could not be done in M4: `search_vector` is filled by a
-- trigger, and the trigger reads `title_normalized` / `description_normalized`
-- rather than the raw columns. That indirection is the whole point — the
-- ADR-0012 pipeline is TypeScript and cannot be called from PL/pgSQL, so the
-- application normalizes on write and the database indexes what it wrote.
-- Re-implementing the normalizer in SQL would give two pipelines that drift,
-- which is exactly what the ADR exists to prevent.

-- ─────────────────────────────────────────────────────────────────────────────
-- search_vector
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "event" ADD COLUMN "search_vector" tsvector;

-- The 'simple' configuration, not a stemmer. Postgres ships no Persian stemmer,
-- and the 'arabic' one produces wrong stems for Persian morphology (ADR-0012).
-- Trigram matching covers most of what stemming would have.
--
-- Title is weight A, description weight B, so a query word in the title
-- outranks the same word buried in a paragraph.
CREATE OR REPLACE FUNCTION "event_search_vector_refresh"()
RETURNS TRIGGER AS $$
BEGIN
    NEW."search_vector" :=
        setweight(to_tsvector('simple', coalesce(NEW."title_normalized", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW."description_normalized", '')), 'B');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- `UPDATE OF` on the normalized columns only: the vector is derived from those
-- two and nothing else, so a capacity edit or an accepted_count increment has no
-- reason to recompute it. That matters more than it looks — M6 updates
-- `accepted_count` while holding the event row lock, and rebuilding a tsvector
-- inside that critical section would lengthen the most contended write path in
-- the product.
CREATE TRIGGER "event_search_vector_sync"
    BEFORE INSERT OR UPDATE OF "title_normalized", "description_normalized" ON "event"
    FOR EACH ROW EXECUTE FUNCTION "event_search_vector_refresh"();

-- Backfill anything created by M4. Naming a column in SET fires an `UPDATE OF`
-- trigger even when the value is unchanged, which is what makes this work.
UPDATE "event" SET "title_normalized" = "title_normalized";

-- ─────────────────────────────────────────────────────────────────────────────
-- Search indexes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "event_search_vector_idx" ON "event" USING GIN ("search_vector");

-- Trigram on the *normalized* title, so a query and the index have been through
-- the same pipeline. Indexing the raw title would mean «كافه» and «کافه» were
-- different strings to the fuzzy matcher, which is the bug ADR-0012 opens with.
CREATE INDEX "event_title_trgm_idx"
    ON "event" USING GIN ("title_normalized" gin_trgm_ops);

-- The `newest` sort, restricted to what discovery can actually return. Partial
-- on the same predicate as `event_discovery_idx`, so both stay usable as the
-- table grows and unpublished rows accumulate.
CREATE INDEX "event_published_recent_idx"
    ON "event" ("published_at" DESC)
    WHERE "status" = 'PUBLISHED' AND "deleted_at" IS NULL;

-- The `soonest` sort with no city or category filter — the default cold-start
-- listing, and the one query `event_discovery_idx` cannot serve because its
-- leading columns are unbound.
CREATE INDEX "event_upcoming_idx"
    ON "event" ("starts_at")
    WHERE "status" = 'PUBLISHED' AND "deleted_at" IS NULL;
