-- Migration 0017: gift and discount codes.
--
-- A campaign code somebody types in exchange for coins. Hand-written like
-- 0001–0016, and deliberately a *sibling* of `referral` rather than a second
-- economy: the coins move through `CoinService` like every other coin in the
-- product, so `coin_ledger` stays the single truth and ADR-0007's
-- `balance = SUM(coin_ledger.amount)` reconciliation keeps holding.
--
-- Three things the database decides rather than the service, for the reason
-- ADR-0006 gives about capacity — a read-then-write check has a race window and a
-- constraint has none:
--
--   1. `gift_code.code` is UNIQUE and stored **already normalized**: upper-cased,
--      with spaces and dashes removed, exactly what `normalizeCode` produces for a
--      referral code. Case-insensitivity is therefore a property of the column,
--      not something every query has to remember. `citext` would work too and is
--      an extension for one column's sake.
--   2. `UNIQUE (gift_code_id, user_id, seq)` is the per-user limit. `seq` is the
--      1-based ordinal of this person's redemptions of this code, allocated under
--      the code's row lock — so a single-use code allows exactly one redemption
--      per person no matter how many times a flaky connection retries, and a code
--      that allows three allows exactly three. A plain `UNIQUE (code, user)`
--      could only express the first case.
--   3. `CHECK (redeemed_count <= max_redemptions)` is the global cap. The service
--      takes `SELECT … FOR UPDATE` on the code row and checks it there, so the
--      CHECK never fires in normal operation — which is exactly the point: it is
--      the backstop for the day a future code path forgets the lock, and it turns
--      silent over-redemption into a loud failure.
--
-- **Lock ordering.** A redemption takes the `gift_code` row lock first and then
-- lets `CoinService` take `coin_account`. Never the reverse, anywhere. ADR-0006's
-- rule is that lock ordering must be total, and this is the second pair in the
-- product after event → coin_account.

-- ─────────────────────────────────────────────────────────────────────────────
-- coin_ledger_type gains a value
-- ─────────────────────────────────────────────────────────────────────────────
-- Appended rather than folded into ADMIN_ADJUSTMENT: "somebody typed a campaign
-- code" and "a human moved a balance by hand" answer different questions in an
-- audit and have different people to ask about them.
--
-- Postgres 12+ permits ALTER TYPE … ADD VALUE inside a transaction as long as the
-- new value is not *used* in the same transaction. Nothing below uses it, so this
-- is safe under `prisma migrate deploy`, which wraps each migration in one.
ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'GIFT_CODE_REDEEM' AFTER 'REVIEW_REWARD';

-- ─────────────────────────────────────────────────────────────────────────────
-- gift_code
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "gift_code" (
    "id"                  TEXT           NOT NULL,
    "code"                TEXT           NOT NULL,
    "coins"               INTEGER        NOT NULL,
    "max_redemptions"     INTEGER,
    "per_user_limit"      INTEGER        NOT NULL DEFAULT 1,
    "redeemed_count"      INTEGER        NOT NULL DEFAULT 0,
    "starts_at"           TIMESTAMPTZ(3),
    "expires_at"          TIMESTAMPTZ(3),
    "is_active"           BOOLEAN        NOT NULL DEFAULT true,
    "note"                TEXT,
    "created_by_admin_id" TEXT,
    "created_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gift_code_pkey" PRIMARY KEY ("id"),

    -- A code that grants nothing is a code somebody will spend an afternoon on.
    CONSTRAINT "gift_code_coins_positive" CHECK ("coins" > 0),
    CONSTRAINT "gift_code_per_user_limit_positive" CHECK ("per_user_limit" > 0),
    CONSTRAINT "gift_code_max_redemptions_positive"
        CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0),
    CONSTRAINT "gift_code_redeemed_count_nonnegative" CHECK ("redeemed_count" >= 0),
    -- The global cap, as a constraint rather than as a check somebody has to
    -- remember. NULL max means unlimited, and NULL comparisons are unknown — so
    -- the IS NULL branch is what keeps an uncapped code from failing this.
    CONSTRAINT "gift_code_within_max_redemptions"
        CHECK ("max_redemptions" IS NULL OR "redeemed_count" <= "max_redemptions"),
    -- A window that closes before it opens is a typo, and it is one that silently
    -- produces a code nobody can ever redeem.
    CONSTRAINT "gift_code_window_ordered"
        CHECK ("starts_at" IS NULL OR "expires_at" IS NULL OR "starts_at" < "expires_at")
);

-- Case-insensitivity, as a property of the column. Codes are stored normalized,
-- so this index is what makes «abc-123» and «ABC123» one code rather than two.
CREATE UNIQUE INDEX "gift_code_code_key" ON "gift_code" ("code");

-- The admin list, newest first.
CREATE INDEX "gift_code_created_at_idx" ON "gift_code" ("created_at");

-- "Which campaigns are live?"
CREATE INDEX "gift_code_is_active_expires_at_idx" ON "gift_code" ("is_active", "expires_at");

ALTER TABLE "gift_code"
    ADD CONSTRAINT "gift_code_created_by_admin_id_fkey"
    FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- gift_code_redemption
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "gift_code_redemption" (
    "id"             TEXT           NOT NULL,
    "gift_code_id"   TEXT           NOT NULL,
    "user_id"        TEXT           NOT NULL,
    "seq"            INTEGER        NOT NULL,
    "coins"          INTEGER        NOT NULL,
    "coin_ledger_id" TEXT           NOT NULL,
    "created_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_code_redemption_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "gift_code_redemption_seq_positive" CHECK ("seq" > 0),
    CONSTRAINT "gift_code_redemption_coins_positive" CHECK ("coins" > 0)
);

-- The guard. Two concurrent redemptions of a single-use code race to insert
-- `seq = 1`; exactly one wins, and the loser is told it has already been used
-- rather than being paid twice.
CREATE UNIQUE INDEX "gift_code_redemption_gift_code_id_user_id_seq_key"
    ON "gift_code_redemption" ("gift_code_id", "user_id", "seq");

-- A ledger row belongs to at most one redemption, so a grant cannot be claimed
-- twice — the same discipline `coin_ledger.reverses_ledger_id` uses.
CREATE UNIQUE INDEX "gift_code_redemption_coin_ledger_id_key"
    ON "gift_code_redemption" ("coin_ledger_id");

-- "How many has this person had?", read while holding the code's row lock.
CREATE INDEX "gift_code_redemption_user_id_created_at_idx"
    ON "gift_code_redemption" ("user_id", "created_at");

ALTER TABLE "gift_code_redemption"
    ADD CONSTRAINT "gift_code_redemption_gift_code_id_fkey"
    FOREIGN KEY ("gift_code_id") REFERENCES "gift_code"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gift_code_redemption"
    ADD CONSTRAINT "gift_code_redemption_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "gift_code_redemption"
    ADD CONSTRAINT "gift_code_redemption_coin_ledger_id_fkey"
    FOREIGN KEY ("coin_ledger_id") REFERENCES "coin_ledger"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
