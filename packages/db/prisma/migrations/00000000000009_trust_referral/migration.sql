-- Migration 0009: Trust Score, and who invited whom.
--
-- Hand-written like 0001–0008. The coin half of ADR-0007 landed in 0003, because
-- the onboarding reward could not be granted exactly once without it. This is the
-- other half, plus the referral table that spends both.
--
-- Two things worth reading before the SQL:
--
-- 1. `trust_score_ledger.delta` is the **effective** movement, after clamping —
--    `score_after - score_before`, always. A rule that says +3 for somebody
--    already at 99 writes +1 here and records the 3 it wanted in `metadata`.
--    Storing the requested delta would break `score = SUM(delta)` the first time
--    anybody reached a bound, and that sum is exactly what ADR-0007's
--    reconciliation test checks. The CHECK below states the relationship so it
--    cannot drift.
--
-- 2. Both bounds are CHECK constraints rather than `app_setting` numbers. Plan
--    §11 makes the *starting* score configurable and it is; the 0–100 range is
--    structural — ADR-0007 writes it into the schema, and a configurable clamp
--    over a fixed CHECK would be a setting whose only effect is a constraint
--    violation.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "trust_ledger_type" AS ENUM (
    'INITIAL',
    'PROFILE_COMPLETE',
    'ATTENDANCE',
    'REVIEW',
    'CANCELLATION',
    'NO_SHOW',
    'MODERATION',
    'REHABILITATION',
    'ADMIN_ADJUSTMENT',
    'REVERSAL'
);

CREATE TYPE "referral_status" AS ENUM ('PENDING', 'QUALIFIED', 'REJECTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- user.referral_code
-- ─────────────────────────────────────────────────────────────────────────────
-- The code a user hands out. §4.5 gives `referral.code`, which snapshots the code
-- a referral *used*; the referrer still needs somewhere to keep the current one.
-- Nullable and generated on first read, so it costs nothing for the users who
-- never open the invite screen.
ALTER TABLE "user" ADD COLUMN "referral_code" TEXT;

CREATE UNIQUE INDEX "user_referral_code_key" ON "user" ("referral_code");

-- ─────────────────────────────────────────────────────────────────────────────
-- trust_score
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "trust_score" (
    "user_id"      TEXT           NOT NULL,
    "score"        INTEGER        NOT NULL,
    "algo_version" INTEGER        NOT NULL DEFAULT 1,
    "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trust_score_pkey" PRIMARY KEY ("user_id"),

    -- ADR-0007, and the backstop for a clamp somebody gets wrong in code.
    CONSTRAINT "trust_score_within_range" CHECK ("score" BETWEEN 0 AND 100)
);

ALTER TABLE "trust_score"
    ADD CONSTRAINT "trust_score_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- trust_score_ledger
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "trust_score_ledger" (
    "id"                 TEXT                NOT NULL,
    "user_id"            TEXT                NOT NULL,
    "idempotency_key"    TEXT                NOT NULL,
    "type"               "trust_ledger_type" NOT NULL,
    "delta"              INTEGER             NOT NULL,
    "score_before"       INTEGER             NOT NULL,
    "score_after"        INTEGER             NOT NULL,
    "reason_code"        TEXT                NOT NULL,
    "algo_version"       INTEGER             NOT NULL,
    "actor_type"         "actor_type"        NOT NULL,
    "actor_id"           TEXT,
    "ref_type"           TEXT,
    "ref_id"             TEXT,
    "reverses_ledger_id" TEXT,
    "metadata"           JSONB,
    "created_at"         TIMESTAMPTZ(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trust_score_ledger_pkey" PRIMARY KEY ("id"),

    -- The three CHECKs that keep `score = SUM(delta)` true by construction.
    -- Each is free at write time and expensive to discover later, which is the
    -- same trade migration 0003 made for `coin_ledger`.
    CONSTRAINT "trust_score_ledger_arithmetic" CHECK ("score_after" = "score_before" + "delta"),
    -- Note what is *absent*: `coin_ledger` forbids a zero amount, and this
    -- deliberately does not. A rule that fires against somebody already at 100
    -- has an effective delta of zero, and the row must still be written — because
    -- the row is what consumes the idempotency key. Without it, a redelivered job
    -- would find the same key unused, and would pay out for real the moment the
    -- score dropped enough to have room. A zero row is also the honest answer to
    -- "why didn't my score go up?": the rule fired, and the cap ate it.
    CONSTRAINT "trust_score_ledger_within_range" CHECK (
        "score_before" BETWEEN 0 AND 100 AND "score_after" BETWEEN 0 AND 100
    ),

    -- A REVERSAL names what it reverses, and nothing else does.
    CONSTRAINT "trust_score_ledger_reversal_pairing" CHECK (
        ("type" = 'REVERSAL') = ("reverses_ledger_id" IS NOT NULL)
    )
);

-- Exactly-once, and the reason a retried job or a double-tapped button cannot
-- move somebody's reputation twice.
CREATE UNIQUE INDEX "trust_score_ledger_idempotency_key_key"
    ON "trust_score_ledger" ("idempotency_key");

-- NULLs are distinct in Postgres, so this reads as "a row can be reversed at
-- most once". Reversing twice would silently double a correction.
CREATE UNIQUE INDEX "trust_score_ledger_reverses_ledger_id_key"
    ON "trust_score_ledger" ("reverses_ledger_id");

CREATE INDEX "trust_score_ledger_user_id_created_at_idx"
    ON "trust_score_ledger" ("user_id", "created_at");
CREATE INDEX "trust_score_ledger_type_created_at_idx"
    ON "trust_score_ledger" ("type", "created_at");

ALTER TABLE "trust_score_ledger"
    ADD CONSTRAINT "trust_score_ledger_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trust_score_ledger"
    ADD CONSTRAINT "trust_score_ledger_reverses_ledger_id_fkey"
    FOREIGN KEY ("reverses_ledger_id") REFERENCES "trust_score_ledger"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, with **no retention escape hatch** — the same shape `coin_ledger`
-- got in 0003 and deliberately stricter than `audit_log` and `consent`. Deleting
-- a row here would break reconciliation permanently: the score is defined as the
-- sum of these rows, so a missing one is not lost history, it is a wrong number
-- with no way to discover that it is wrong.
CREATE OR REPLACE FUNCTION "trust_score_ledger_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'trust_score_ledger is append-only: correct a mistake with a REVERSAL row, not an UPDATE';
    END IF;

    RAISE EXCEPTION 'trust_score_ledger is append-only: DELETE is never permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trust_score_ledger_append_only"
    BEFORE UPDATE OR DELETE ON "trust_score_ledger"
    FOR EACH ROW EXECUTE FUNCTION "trust_score_ledger_is_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────
-- referral
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "referral" (
    "referrer_user_id" TEXT              NOT NULL,
    "referred_user_id" TEXT              NOT NULL,
    "id"               TEXT              NOT NULL,
    "code"             TEXT              NOT NULL,
    "status"           "referral_status" NOT NULL DEFAULT 'PENDING',
    "qualified_at"     TIMESTAMPTZ(3),
    "reward_ledger_id" TEXT,
    "fraud_signals"    JSONB,
    "created_at"       TIMESTAMPTZ(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMPTZ(3)    NOT NULL,

    CONSTRAINT "referral_pkey" PRIMARY KEY ("id"),

    -- T6, and the cheapest fraud control there is: inviting yourself is not a
    -- referral. Stated in the database because the service check is one refactor
    -- away from being skipped.
    CONSTRAINT "referral_not_self" CHECK ("referrer_user_id" <> "referred_user_id"),

    -- A qualified referral has a date; an unqualified one has not happened yet.
    CONSTRAINT "referral_qualified_at_matches_status" CHECK (
        ("status" = 'QUALIFIED') = ("qualified_at" IS NOT NULL)
    ),

    -- And a reward only exists for a referral that qualified.
    CONSTRAINT "referral_reward_needs_qualification" CHECK (
        "reward_ledger_id" IS NULL OR "status" = 'QUALIFIED'
    )
);

-- One referrer per person, for life. The claim path inserts and lets this decide,
-- rather than reading first — a read-then-write has a window, this has none.
CREATE UNIQUE INDEX "referral_referred_user_id_key" ON "referral" ("referred_user_id");

CREATE INDEX "referral_referrer_user_id_created_at_idx"
    ON "referral" ("referrer_user_id", "created_at");
CREATE INDEX "referral_status_idx" ON "referral" ("status");

ALTER TABLE "referral"
    ADD CONSTRAINT "referral_referrer_user_id_fkey"
    FOREIGN KEY ("referrer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "referral"
    ADD CONSTRAINT "referral_referred_user_id_fkey"
    FOREIGN KEY ("referred_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
