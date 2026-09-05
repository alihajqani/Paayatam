-- Migration 0048: a city can be chosen before it is open (v0.10.0).
--
-- ── The one flag that answered two questions ────────────────────────────────
--
-- `city.is_active` has been carrying both of these:
--
--   1. "May somebody say they live here?"      — true for all 31 capitals
--   2. "Do we run activities here yet?"        — true for Tehran and Mashhad
--
-- The launch needs (2) narrowed and (1) left wide, and one boolean cannot do
-- both. Narrowing `is_active` to the two open cities answers (2) by breaking
-- (1): somebody from Shiraz then has no way to say they are from Shiraz, so
-- they cannot be counted, cannot be told «شما نفر ۳۰ از شیراز هستید», and either
-- picks a city they do not live in — which is worse than nothing, because it
-- poisons the very demand data the next launch decision is made from — or
-- leaves.
--
-- So (1) stays on `is_active` and (2) moves here.
--
-- ── Why the backfill names two slugs ────────────────────────────────────────
--
-- `DEFAULT false` alone would leave every city closed between this migration
-- and whatever sets the two, and that window is a live product telling every
-- user their city is not open. Backfilled by **slug** rather than `name_fa`:
-- slugs are unique and stable, and there are 1,252 Persian names among which
-- more than one may read «تهران».
--
-- Additive: one column with a default and one narrow UPDATE. Nothing is
-- dropped, renamed or narrowed, and the previous image ignores the column
-- entirely — so rolling back to it leaves a product that behaves exactly as
-- v0.9.1 did.
ALTER TABLE "city"
  ADD COLUMN IF NOT EXISTS "is_launched" BOOLEAN NOT NULL DEFAULT false;

UPDATE "city" SET "is_launched" = true WHERE "slug" IN ('tehran', 'mashhad');

-- "Which cities are open?" — the operator's read.
--
-- Not partial, though `WHERE is_launched` would be smaller: Prisma cannot
-- express a partial index, so the schema would declare a full one under the same
-- name and every `migrate diff` from here on would report drift that is not
-- there. A full index on a 1,252-row table is not worth that.
--
-- **No index on `user_profile.city_id`**, which the waitlist count reads on
-- every completion in a closed city. `@@index([cityId, districtId])` already
-- exists and `city_id` leads it, so the count uses it and a second index would
-- be write cost for a read that is already served.
CREATE INDEX IF NOT EXISTS "city_is_launched_idx" ON "city" ("is_launched");
