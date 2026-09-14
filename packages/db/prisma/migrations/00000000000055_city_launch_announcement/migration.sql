-- Migration 0055: when a city first opened, and when its people were told (plan 17).
--
-- ── What was missing ────────────────────────────────────────────────────────
--
-- Somebody in a city the product has not opened reads «به‌محض باز شدن، همین‌جا
-- خبرتان می‌کنیم». Nothing sent that message: opening a city in the panel wrote
-- `is_launched` and an audit row, and no one who had been waiting heard about it.
--
-- ── Why two columns ─────────────────────────────────────────────────────────
--
-- `launched_at` is written by the panel the first time a city opens, and never
-- again — closing and reopening a city is not a launch, and its people must not
-- be told twice. `launch_announced_at` is written by the worker once the
-- broadcast exists. The pair is the queue: launched and not yet announced. A
-- crash between the two re-runs the announcement, which the campaign's
-- `idempotency_key` (`city-launch:<city id>`) turns into the same campaign.
--
-- ── The backfill, and why it sets both ──────────────────────────────────────
--
-- Tehran and Mashhad were open before this existed. Leaving their `launched_at`
-- NULL would announce them the first time an operator closed and reopened one;
-- setting only `launched_at` would announce them to every profile on the first
-- worker pass after deploy. Both, so an open city is a city whose launch already
-- happened and was already known.
--
-- ── Additive ────────────────────────────────────────────────────────────────
--
-- Two nullable columns and an UPDATE of rows that are open. No index: the worker
-- asks among cities with `is_launched`, which `city_is_launched_idx` narrows to a
-- handful.
ALTER TABLE "city" ADD COLUMN IF NOT EXISTS "launched_at" TIMESTAMPTZ(3);
ALTER TABLE "city" ADD COLUMN IF NOT EXISTS "launch_announced_at" TIMESTAMPTZ(3);

UPDATE "city"
SET "launched_at" = now(), "launch_announced_at" = now()
WHERE "is_launched" AND "launched_at" IS NULL;
