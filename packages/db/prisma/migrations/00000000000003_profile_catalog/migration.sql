-- Migration 0003: catalog, user profile, and the coin ledger slice.
--
-- Hand-written like 0001 and 0002, and for the same reason: the guarantees that
-- matter here cannot be expressed in schema.prisma. Specifically the CHECK that
-- a ledger row's arithmetic is internally consistent, the CHECK that a balance
-- never goes negative, and the trigger that makes `coin_ledger` append-only.
--
-- The ledger arrives in M3 rather than M9 (its home in the plan) because the
-- onboarding reward must be grantable exactly once, and "exactly once" is a
-- UNIQUE index on an idempotency key — not something the application can promise.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "gender" AS ENUM ('MALE', 'FEMALE', 'PREFER_NOT_SAY');

-- Only ONBOARDING_REWARD is written in M3. The rest are declared now so later
-- milestones add ledger rows rather than altering a type that live code reads.
CREATE TYPE "coin_ledger_type" AS ENUM (
    'ONBOARDING_REWARD',
    'REFERRAL_REWARD',
    'REVIEW_REWARD',
    'BOOST_SPEND',
    'VIP_SPEND',
    'CANCELLATION_PENALTY',
    'NO_SHOW_PENALTY',
    'HOST_CANCELLATION_REFUND',
    'ADMIN_ADJUSTMENT',
    'REVERSAL'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- city
--
-- `is_active` defaults to false: a city becomes selectable when someone decides
-- it is served, not because a row appeared. Launch is Tehran only (plan §2).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "city" (
    "id"         TEXT           NOT NULL,
    "slug"       TEXT           NOT NULL,
    "name_fa"    TEXT           NOT NULL,
    "is_active"  BOOLEAN        NOT NULL DEFAULT false,
    "sort_order" INTEGER        NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "city_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "city_slug_key"                ON "city" ("slug");
CREATE INDEX        "city_is_active_sort_order_idx" ON "city" ("is_active", "sort_order");

-- ─────────────────────────────────────────────────────────────────────────────
-- district
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "district" (
    "id"         TEXT           NOT NULL,
    "city_id"    TEXT           NOT NULL,
    "slug"       TEXT           NOT NULL,
    "name_fa"    TEXT           NOT NULL,
    "is_active"  BOOLEAN        NOT NULL DEFAULT true,
    "sort_order" INTEGER        NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "district_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "district_city_id_slug_key" ON "district" ("city_id", "slug");
CREATE INDEX "district_city_id_is_active_sort_order_idx"
    ON "district" ("city_id", "is_active", "sort_order");

-- RESTRICT: deactivate a city, never delete one out from under the profiles and
-- events that point at it.
ALTER TABLE "district"
    ADD CONSTRAINT "district_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- category
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "category" (
    "id"         TEXT           NOT NULL,
    "slug"       TEXT           NOT NULL,
    "name_fa"    TEXT           NOT NULL,
    "icon"       TEXT,
    "is_active"  BOOLEAN        NOT NULL DEFAULT false,
    "sort_order" INTEGER        NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "category_slug_key"                 ON "category" ("slug");
CREATE INDEX        "category_is_active_sort_order_idx" ON "category" ("is_active", "sort_order");

-- ─────────────────────────────────────────────────────────────────────────────
-- interest
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "interest" (
    "id"          TEXT           NOT NULL,
    "category_id" TEXT,
    "slug"        TEXT           NOT NULL,
    "name_fa"     TEXT           NOT NULL,
    "is_active"   BOOLEAN        NOT NULL DEFAULT true,
    "sort_order"  INTEGER        NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "interest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interest_slug_key"                 ON "interest" ("slug");
CREATE INDEX        "interest_is_active_sort_order_idx" ON "interest" ("is_active", "sort_order");

ALTER TABLE "interest"
    ADD CONSTRAINT "interest_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_profile
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "user_profile" (
    "user_id"      TEXT           NOT NULL,
    "display_name" TEXT           NOT NULL,
    "gender"       "gender",
    "birth_year"   INTEGER,
    "city_id"      TEXT           NOT NULL,
    "district_id"  TEXT,
    "bio"          TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "user_profile_city_id_district_id_idx" ON "user_profile" ("city_id", "district_id");

ALTER TABLE "user_profile"
    ADD CONSTRAINT "user_profile_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_profile"
    ADD CONSTRAINT "user_profile_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_profile"
    ADD CONSTRAINT "user_profile_district_id_fkey"
    FOREIGN KEY ("district_id") REFERENCES "district"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The same bounds the zod contract enforces, restated where they cannot be
-- bypassed. A shared schema protects the API; this protects the table from a
-- migration, a seed script or a psql session.
ALTER TABLE "user_profile"
    ADD CONSTRAINT "user_profile_display_name_length"
    CHECK (char_length("display_name") BETWEEN 2 AND 40);

ALTER TABLE "user_profile"
    ADD CONSTRAINT "user_profile_bio_length"
    CHECK ("bio" IS NULL OR char_length("bio") <= 300);

-- A plausibility range, NOT the 18+ rule.
--
-- The age gate depends on the current date, and Postgres refuses non-IMMUTABLE
-- functions in a CHECK constraint, so `now()` cannot appear here. The gate is
-- therefore enforced in ProfileService against the injected Clock (ADR-0008),
-- which is also the only way it stays testable without waiting a year. What this
-- constraint catches is a typo or a Jalali year submitted where a Gregorian one
-- was expected — 1375 lands outside the range and is rejected at the table.
ALTER TABLE "user_profile"
    ADD CONSTRAINT "user_profile_birth_year_plausible"
    CHECK ("birth_year" IS NULL OR "birth_year" BETWEEN 1900 AND 2200);

-- ─────────────────────────────────────────────────────────────────────────────
-- user_interest
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "user_interest" (
    "user_id"     TEXT           NOT NULL,
    "interest_id" TEXT           NOT NULL,
    "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_interest_pkey" PRIMARY KEY ("user_id", "interest_id")
);

CREATE INDEX "user_interest_interest_id_idx" ON "user_interest" ("interest_id");

ALTER TABLE "user_interest"
    ADD CONSTRAINT "user_interest_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_interest"
    ADD CONSTRAINT "user_interest_interest_id_fkey"
    FOREIGN KEY ("interest_id") REFERENCES "interest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- coin_account — the cached balance and the lock every coin movement takes
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "coin_account" (
    "user_id"    TEXT           NOT NULL,
    "balance"    INTEGER        NOT NULL DEFAULT 0,
    "version"    INTEGER        NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "coin_account_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "coin_account"
    ADD CONSTRAINT "coin_account_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Invariant 2. The service layer also refuses an overdraft, but this is the line
-- that holds when the service layer has a bug.
ALTER TABLE "coin_account"
    ADD CONSTRAINT "coin_account_balance_non_negative" CHECK ("balance" >= 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- coin_ledger — append-only, the source of truth (ADR-0007, invariant 3)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "coin_ledger" (
    "id"                  TEXT               NOT NULL,
    "user_id"             TEXT               NOT NULL,
    "idempotency_key"     TEXT               NOT NULL,
    "type"                "coin_ledger_type" NOT NULL,
    "amount"              INTEGER            NOT NULL,
    "balance_before"      INTEGER            NOT NULL,
    "balance_after"       INTEGER            NOT NULL,
    "reason_code"         TEXT               NOT NULL,
    "actor_type"          "actor_type"       NOT NULL,
    "actor_id"            TEXT,
    "ref_type"            TEXT,
    "ref_id"              TEXT,
    "reverses_ledger_id"  TEXT,
    "metadata"            JSONB,
    "created_at"          TIMESTAMPTZ(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coin_ledger_pkey" PRIMARY KEY ("id")
);

-- The exactly-once guarantee. A retried job, a double-tapped button and two
-- concurrent requests all collide here and produce one row.
CREATE UNIQUE INDEX "coin_ledger_idempotency_key_key" ON "coin_ledger" ("idempotency_key");

-- Postgres treats NULLs as distinct in a unique index, so this reads as "a ledger
-- row can be reversed at most once" while leaving ordinary rows unconstrained.
-- Reversing twice would silently double a refund.
CREATE UNIQUE INDEX "coin_ledger_reverses_ledger_id_key" ON "coin_ledger" ("reverses_ledger_id");

CREATE INDEX "coin_ledger_user_id_created_at_idx" ON "coin_ledger" ("user_id", "created_at");
CREATE INDEX "coin_ledger_type_created_at_idx"    ON "coin_ledger" ("type", "created_at");

-- RESTRICT: account deletion anonymises (M15). Financial history is not erased
-- by deleting the user it belongs to.
ALTER TABLE "coin_ledger"
    ADD CONSTRAINT "coin_ledger_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coin_ledger"
    ADD CONSTRAINT "coin_ledger_reverses_ledger_id_fkey"
    FOREIGN KEY ("reverses_ledger_id") REFERENCES "coin_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A zero-amount entry records nothing and would quietly pass reconciliation.
ALTER TABLE "coin_ledger"
    ADD CONSTRAINT "coin_ledger_amount_non_zero" CHECK ("amount" <> 0);

-- `balance_before`/`balance_after` are denormalized, so they can drift from the
-- amount they claim to bracket. This makes that impossible at write time rather
-- than discoverable later by the reconciliation test.
ALTER TABLE "coin_ledger"
    ADD CONSTRAINT "coin_ledger_arithmetic"
    CHECK ("balance_after" = "balance_before" + "amount");

ALTER TABLE "coin_ledger"
    ADD CONSTRAINT "coin_ledger_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- A REVERSAL must say what it reverses, and nothing else may claim to reverse
-- something. Without this, "corrections are new rows" is a convention rather
-- than a property of the data.
ALTER TABLE "coin_ledger"
    ADD CONSTRAINT "coin_ledger_reversal_targets_original"
    CHECK (("type" = 'REVERSAL') = ("reverses_ledger_id" IS NOT NULL));

-- Invariant 3, enforced where it cannot be forgotten. Same shape as the
-- audit_log and consent triggers in 0001/0002, including the retention escape
-- hatch — though note the M15 purge must never actually use it here: a ledger
-- row is financial history, and deleting one would break reconciliation.
CREATE OR REPLACE FUNCTION "coin_ledger_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'coin_ledger is append-only: correct a mistake with a REVERSAL row, not an UPDATE';
    END IF;

    RAISE EXCEPTION 'coin_ledger is append-only: DELETE is never permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "coin_ledger_append_only"
    BEFORE UPDATE OR DELETE ON "coin_ledger"
    FOR EACH ROW EXECUTE FUNCTION "coin_ledger_is_append_only"();
