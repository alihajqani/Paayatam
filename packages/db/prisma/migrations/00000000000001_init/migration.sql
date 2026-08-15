-- Migration 0001: platform configuration and the audit trail.
--
-- Hand-written rather than generated, because two things in here cannot be
-- expressed in schema.prisma: the extensions, and the trigger that makes
-- `audit_log` genuinely append-only. `prisma migrate diff` is run against this in
-- CI to prove the SQL and the schema still agree.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────────────────
-- pg_trgm: fuzzy title matching for Persian search (ADR-0012, M5).
-- unaccent: diacritic folding, used alongside the application-level normalizer.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "actor_type" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- ─────────────────────────────────────────────────────────────────────────────
-- app_setting — every policy number in the product (ADR-0007, ADR-0011)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "app_setting" (
    "key"          TEXT             NOT NULL,
    "value"        JSONB            NOT NULL,
    "value_schema" JSONB,
    "version"      INTEGER          NOT NULL DEFAULT 1,
    "updated_by"   TEXT,
    "created_at"   TIMESTAMPTZ(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(3)   NOT NULL,

    CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- feature_flag — gates the Tehran-only, two-category launch (plan §2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "feature_flag" (
    "key"         TEXT           NOT NULL,
    "enabled"     BOOLEAN        NOT NULL DEFAULT false,
    "description" TEXT,
    "rollout"     JSONB,
    "updated_by"  TEXT,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("key")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log — append-only (invariants 10 and 12)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "audit_log" (
    "id"          TEXT           NOT NULL,
    "actor_type"  "actor_type"   NOT NULL,
    "actor_id"    TEXT,
    "action"      TEXT           NOT NULL,
    "target_type" TEXT           NOT NULL,
    "target_id"   TEXT,
    "before"      JSONB,
    "after"       JSONB,
    "ip_hash"     TEXT,
    "request_id"  TEXT,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_actor_type_actor_id_created_at_idx"
    ON "audit_log" ("actor_type", "actor_id", "created_at");

CREATE INDEX "audit_log_target_type_target_id_created_at_idx"
    ON "audit_log" ("target_type", "target_id", "created_at");

CREATE INDEX "audit_log_created_at_idx"
    ON "audit_log" ("created_at");

-- An audit trail that can be edited is not an audit trail. Enforced in the
-- database so it holds for every writer — application code, an admin script, or a
-- psql session — not only for code that remembers the rule.
--
-- Deletion is permitted only by the M15 retention job, which sets
-- `payetam.retention_purge` for the duration of its transaction. Nothing else can
-- set that flag without deliberately deciding to.
CREATE OR REPLACE FUNCTION "audit_log_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted';
    END IF;

    IF TG_OP = 'DELETE'
       AND coalesce(current_setting('payetam.retention_purge', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'audit_log is append-only: DELETE is permitted only by the retention job';
    END IF;

    -- Must be OLD, not NULL. A BEFORE trigger that returns NULL silently cancels
    -- the row operation, which would make even the permitted retention delete a
    -- no-op that reports success. Returning OLD lets the delete proceed.
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_append_only"
    BEFORE UPDATE OR DELETE ON "audit_log"
    FOR EACH ROW EXECUTE FUNCTION "audit_log_is_append_only"();
