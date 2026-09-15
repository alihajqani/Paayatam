-- Migration 0058: a number for every activity, and the seat count a channel post
-- last showed (v0.16.0).
--
-- ── `event.number` ──────────────────────────────────────────────────────────
--
-- The channel post opens with «#رویداد_۲۵»: a hashtag a reader can tap to find
-- one activity, and a name short enough to say out loud. `public_id` is a UUID
-- and `event_code` is ten hex digits — neither is something a person types into a
-- search. So a plain sequence.
--
-- A sequence, not the gap-free counter `founding_counter` uses. That counter
-- exists because its number is a *rank* shown to the person who holds it, and a
-- missing rank is a broken promise. An activity whose creation rolled back leaves
-- a hole here and nobody is owed the missing number.
--
-- Backfilled in creation order, so the existing activities read oldest-first,
-- then the sequence is moved past them. The default is set before NOT NULL and
-- the UNIQUE index, and it is the sequence rather than application code — so an
-- older build that inserts without the column (a rollback) still gets a number.
--
-- Named `event_number_seq` / `event_number_key`, which is what Prisma expects for
-- `@default(autoincrement()) @unique`, so `migrate diff` reports no drift.
--
-- ── `channel_post.rendered_taken` ───────────────────────────────────────────
--
-- Migration 0052 recorded only whether a post said «ظرفیت تکمیل», because the
-- sweep edited only at that boundary. The post now shows every change — a request
-- closes a seat, a rejection opens it — so the sweep has to know the count the
-- text in the channel carries. NULL is "posted before this column", which the
-- sweep reads as stale: every live post is edited once into the new format.
-- `rendered_full` stays and is still written; nothing is dropped.
CREATE SEQUENCE IF NOT EXISTS "event_number_seq" AS INTEGER;

ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "number" INTEGER;

UPDATE "event" AS e
   SET "number" = ordered.rn
  FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS rn FROM "event") AS ordered
 WHERE e."id" = ordered."id"
   AND e."number" IS NULL;

SELECT setval(
  '"event_number_seq"',
  COALESCE((SELECT max("number") FROM "event"), 1),
  (SELECT max("number") IS NOT NULL FROM "event")
);

ALTER SEQUENCE "event_number_seq" OWNED BY "event"."number";
ALTER TABLE "event" ALTER COLUMN "number" SET DEFAULT nextval('"event_number_seq"');
ALTER TABLE "event" ALTER COLUMN "number" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "event_number_key" ON "event" ("number");

ALTER TABLE "channel_post" ADD COLUMN IF NOT EXISTS "rendered_taken" INTEGER;
