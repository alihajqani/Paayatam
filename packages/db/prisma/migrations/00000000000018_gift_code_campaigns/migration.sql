-- Migration 0018: gift-code campaigns, and a code that is not its own identifier.
--
-- Hand-written like 0001–0017. Two changes that arrive together because the admin
-- panel (M19) is the first consumer of either: until there was a screen, a
-- campaign label had nowhere to be shown and an analytics index had no query to
-- serve.
--
-- ADR-0016 is the decision behind `public_id`, and it is worth stating in the
-- migration too, because a reader here will otherwise assume it is convention: a
-- gift code is a **bearer secret**, and every place the code is used as an
-- identifier is a place the secret is written down.
--
-- Nothing here is destructive and nothing rewrites a row. Every column added is
-- nullable or backfilled before it is made NOT NULL, and every index is
-- additive.

-- ─────────────────────────────────────────────────────────────────────────────
-- gift_code: campaigns and batches
-- ─────────────────────────────────────────────────────────────────────────────
-- A campaign is a **label**, not a table. It has no attribute of its own that is
-- not already on its codes, so a `campaign` table would be a join whose only
-- column is the name — and a foreign key would make "rename the campaign" a
-- migration instead of an UPDATE.
--
-- `batch_id` is one `randomUUID` per bulk mint. Codes are returned to the
-- operator exactly once (they are never re-derivable from the database — that is
-- the point of generating them server-side with a CSPRNG), so the batch id is
-- what lets somebody who closed the tab still find *which* codes they made, count
-- them, and disable the lot.
-- `public_id` is the handle every admin URL and every response uses from M19.
-- The reason is narrower than convention: **the code itself is a bearer secret**,
-- and `POST /admin/v1/gift-codes/NOWRUZ1405/active` writes it into every access
-- log, proxy log and browser history between the operator and the database.
-- ADR-0015 said "never log raw gift codes" and then put one in a URL path.
--
-- Backfilled with `gen_random_uuid()` (pgcrypto is in core since PG13) before the
-- NOT NULL, so existing campaigns get one without a second deploy.
ALTER TABLE "gift_code" ADD COLUMN "public_id" TEXT;
UPDATE "gift_code" SET "public_id" = gen_random_uuid()::TEXT WHERE "public_id" IS NULL;
ALTER TABLE "gift_code" ALTER COLUMN "public_id" SET NOT NULL;
CREATE UNIQUE INDEX "gift_code_public_id_key" ON "gift_code" ("public_id");

ALTER TABLE "gift_code" ADD COLUMN "campaign" TEXT;
ALTER TABLE "gift_code" ADD COLUMN "batch_id" TEXT;

-- Campaign roll-ups on the analytics screen, newest first within a campaign.
CREATE INDEX "gift_code_campaign_created_at_idx" ON "gift_code" ("campaign", "created_at");
-- "Everything I minted a moment ago."
CREATE INDEX "gift_code_batch_id_idx" ON "gift_code" ("batch_id");

-- `per_user_limit` keeps its `CHECK (> 0)` and is deliberately **not** tightened
-- to `= 1` here, even though M19 caps new codes at 1 (ADR-0016). A constraint
-- tightened over live data is a migration that fails on the data it describes,
-- and the rows above 1 are history: their redemptions are paid, their ledger rows
-- are immutable, and rewriting the configuration that explains them would make
-- the ledger unexplainable. The cap lives in the contract and the service, where
-- it governs what can be *created* without lying about what was.

-- ─────────────────────────────────────────────────────────────────────────────
-- gift_code_redemption: the analytics index
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-code analytics asks four questions of this table — first redemption, last
-- redemption, distinct users, and a count bucketed over a window — and every one
-- of them filters on `gift_code_id` and orders or groups by `created_at`. The
-- existing `(user_id, created_at)` index answers the redemption path's "how many
-- has this person had?" and answers none of these.
CREATE INDEX "gift_code_redemption_gift_code_id_created_at_idx"
    ON "gift_code_redemption" ("gift_code_id", "created_at");
