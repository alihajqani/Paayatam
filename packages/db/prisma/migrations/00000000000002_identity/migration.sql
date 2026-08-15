-- Migration 0002: identity, policies and consent.
--
-- Hand-written to match 0001's style, and because three things here cannot be
-- expressed in schema.prisma: the partial unique index enforcing one current
-- policy version per type, the append-only trigger on `consent`, and the CHECK
-- that a policy version number is positive. `prisma migrate diff` is run against
-- this to prove the SQL and the schema still agree.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "user_status"      AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED');
CREATE TYPE "onboarding_state" AS ENUM ('NEW', 'TERMS_ACCEPTED', 'PROFILE_COMPLETE');
CREATE TYPE "policy_type"      AS ENUM ('TERMS', 'PRIVACY', 'COMMUNITY');
CREATE TYPE "consent_context"  AS ENUM ('ONBOARDING', 'REACCEPT', 'CONTACT_SHARE');

-- ─────────────────────────────────────────────────────────────────────────────
-- user
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "user" (
    "id"               TEXT               NOT NULL,
    "public_id"        TEXT               NOT NULL,
    "status"           "user_status"      NOT NULL DEFAULT 'ACTIVE',
    "onboarding_state" "onboarding_state" NOT NULL DEFAULT 'NEW',
    "locale"           TEXT               NOT NULL DEFAULT 'fa-IR',
    "timezone"         TEXT               NOT NULL DEFAULT 'Asia/Tehran',
    "created_at"       TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3)     NOT NULL,
    "deleted_at"       TIMESTAMPTZ(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_public_id_key" ON "user" ("public_id");
CREATE INDEX "user_status_idx"     ON "user" ("status");
CREATE INDEX "user_created_at_idx" ON "user" ("created_at");

-- ─────────────────────────────────────────────────────────────────────────────
-- telegram_account — the highest-value PII in the product (ADR-0009)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "telegram_account" (
    "id"                TEXT           NOT NULL,
    "user_id"           TEXT           NOT NULL,
    "telegram_user_id"  BIGINT         NOT NULL,
    "username_cached"   TEXT,
    "first_name_cached" TEXT,
    "language_code"     TEXT,
    "bot_blocked"       BOOLEAN        NOT NULL DEFAULT false,
    "first_seen_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_account_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_account_user_id_key"          ON "telegram_account" ("user_id");
CREATE UNIQUE INDEX "telegram_account_telegram_user_id_key" ON "telegram_account" ("telegram_user_id");

ALTER TABLE "telegram_account"
    ADD CONSTRAINT "telegram_account_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Telegram user IDs are positive. A non-positive value means we parsed something
-- we should not have trusted.
ALTER TABLE "telegram_account"
    ADD CONSTRAINT "telegram_account_telegram_user_id_positive"
    CHECK ("telegram_user_id" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- policy_version
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "policy_version" (
    "id"           TEXT           NOT NULL,
    "type"         "policy_type"  NOT NULL,
    "version"      INTEGER        NOT NULL,
    "content_md"   TEXT           NOT NULL,
    "summary_fa"   TEXT,
    "is_current"   BOOLEAN        NOT NULL DEFAULT false,
    "published_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_version_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "policy_version_type_version_key" ON "policy_version" ("type", "version");
CREATE INDEX "policy_version_type_is_current_idx"     ON "policy_version" ("type", "is_current");

ALTER TABLE "policy_version"
    ADD CONSTRAINT "policy_version_version_positive" CHECK ("version" > 0);

-- Exactly one current version per policy type, enforced by the database.
-- Publishing a new version must clear the old flag in the same transaction; if it
-- forgets, this index rejects the write instead of leaving users consenting to an
-- ambiguous "current" document.
--
-- KNOWN PRISMA DRIFT — deliberate, do not "fix" by dropping this index.
-- Prisma cannot express a partial UNIQUE index: `@@unique([type], where: ...)` is
-- rejected by the schema parser (`@@index` accepts `where`, `@@unique` does not).
-- So `prisma migrate diff` reports this as an extra index, and `prisma migrate dev`
-- would generate a migration DROPPING it.
--
-- It is kept anyway because it is the only race-proof enforcement: a trigger doing
-- `IF EXISTS (...)` can be passed by two concurrent transactions, a unique index
-- cannot. CI guards this (see .github/workflows/ci.yml, "Protect hand-written
-- database guarantees"), so an accidental drop fails the build instead of silently
-- removing the constraint.
CREATE UNIQUE INDEX "policy_version_one_current_per_type"
    ON "policy_version" ("type") WHERE "is_current";

-- ─────────────────────────────────────────────────────────────────────────────
-- consent — append-only evidence
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "consent" (
    "id"                TEXT              NOT NULL,
    "user_id"           TEXT              NOT NULL,
    "policy_version_id" TEXT              NOT NULL,
    "context"           "consent_context" NOT NULL DEFAULT 'ONBOARDING',
    "accepted_at"       TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash"           TEXT,
    "user_agent_hash"   TEXT,

    CONSTRAINT "consent_pkey" PRIMARY KEY ("id")
);

-- The idempotency guard. Accepting the same policy twice — including from two
-- concurrent requests — produces one row, because the second INSERT loses here
-- rather than in application code.
CREATE UNIQUE INDEX "consent_user_id_policy_version_id_context_key"
    ON "consent" ("user_id", "policy_version_id", "context");

CREATE INDEX "consent_user_id_accepted_at_idx" ON "consent" ("user_id", "accepted_at");

-- RESTRICT, not CASCADE: account deletion anonymises (M15); it must not erase the
-- record that consent was given.
ALTER TABLE "consent"
    ADD CONSTRAINT "consent_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "consent"
    ADD CONSTRAINT "consent_policy_version_id_fkey"
    FOREIGN KEY ("policy_version_id") REFERENCES "policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Consent is evidence. Evidence that can be edited is not evidence.
-- Same shape as the audit_log trigger in 0001, including the retention escape
-- hatch that only the M15 purge job sets.
CREATE OR REPLACE FUNCTION "consent_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'consent is append-only: UPDATE is not permitted';
    END IF;

    IF TG_OP = 'DELETE'
       AND coalesce(current_setting('payetam.retention_purge', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'consent is append-only: DELETE is permitted only by the retention job';
    END IF;

    -- OLD, not NULL: a BEFORE trigger returning NULL cancels the row operation,
    -- which would make the permitted retention delete a silent no-op.
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "consent_append_only"
    BEFORE UPDATE OR DELETE ON "consent"
    FOR EACH ROW EXECUTE FUNCTION "consent_is_append_only"();
