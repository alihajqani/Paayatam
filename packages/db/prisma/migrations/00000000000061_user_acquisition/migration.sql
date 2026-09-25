-- Migration 0061: where an account came from (acquisition tracking).
--
-- ── What was missing ────────────────────────────────────────────────────────
--
-- The product could not say which ad, post or link brought a user in. Every
-- `/start` payload that was not an event link was handed to the referral claim,
-- so an ad link like `?start=tgads1` was logged as a refused referral and then
-- forgotten, and the only way to compare two ads was to run them one after the
-- other and guess from the daily sign-up count.
--
-- ── What this records ───────────────────────────────────────────────────────
--
-- One row per account, written in the same INSERT that creates it: the shape of
-- the `/start` payload that created it (`source`), and the campaign tag, event or
-- raw payload behind it (`ref`). First touch only — an existing user who taps an
-- ad link later is not re-attributed, because the question this answers is "what
-- brought them", and they were already here.
--
-- ── Additive, and inert if the code is rolled back ──────────────────────────
--
-- One type and one table; nothing on `user` changes. The previous image never
-- reads or writes the table, so `scripts/rollback.sh` leaves a schema it runs
-- against unchanged. Accounts created by that image while rolled back simply
-- have no row, which the report already shows as «پیش از ردیابی».
CREATE TYPE "acquisition_source" AS ENUM (
    'DIRECT',
    'CAMPAIGN',
    'REFERRAL',
    'EVENT_LINK',
    'OTHER'
);

CREATE TABLE IF NOT EXISTS "user_acquisition" (
  -- PRIMARY KEY, which is the "one source per person, for life" guarantee.
  "user_id"    TEXT                 NOT NULL,
  "source"     "acquisition_source" NOT NULL,
  "ref"        TEXT,
  "created_at" TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_acquisition_pkey" PRIMARY KEY ("user_id"),

  -- `ref` is what a `?start=` payload could carry: 1–64 of Telegram's own
  -- characters. Anything longer did not come from a link, and storing free text
  -- typed after `/start` would be storing whatever somebody chose to type.
  CONSTRAINT "user_acquisition_ref_is_payload"
    CHECK ("ref" IS NULL OR "ref" ~ '^[A-Za-z0-9_-]{1,64}$'),

  -- Which sources carry a `ref`, so the report can group on it without asking
  -- whether a row is malformed. A campaign's tag is lower-cased on the way in —
  -- two spellings of one tag would split one campaign across two rows.
  CONSTRAINT "user_acquisition_ref_matches_source" CHECK (
    ("source" IN ('DIRECT', 'REFERRAL') AND "ref" IS NULL)
    OR ("source" = 'CAMPAIGN' AND "ref" ~ '^[a-z0-9_-]{1,60}$')
    OR ("source" = 'EVENT_LINK' AND "ref" IS NOT NULL)
    OR "source" = 'OTHER'
  ),

  -- ON DELETE CASCADE, as `founding_member` does. Accounts are anonymised
  -- rather than deleted, so in practice the row outlives the person — which is
  -- right, because it describes a link, not them.
  CONSTRAINT "user_acquisition_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- "How did campaign X do?" — the report groups on exactly these two.
CREATE INDEX IF NOT EXISTS "user_acquisition_source_ref_idx"
  ON "user_acquisition"("source", "ref");
