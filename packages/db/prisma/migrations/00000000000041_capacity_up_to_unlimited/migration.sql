-- Capacity: widen the range so «بدون محدودیت» has a number to be (v0.7.0).
--
-- `event_capacity_range` has said `BETWEEN 1 AND 50` since migration 0004, and
-- the wizard offered 2–50. Two answers were unreachable: a host looking for one
-- companion, and a host who does not want a limit at all.
--
-- `UNLIMITED_CAPACITY` (1000) is a **sentinel, not a nullable column**, and the
-- reason is this constraint's neighbour: `accepted_count <= capacity` is a CHECK,
-- `join` compares against `capacity` under the event row lock to decide PENDING
-- versus WAITLISTED, and four renderers subtract from it. A nullable capacity
-- would put a `?? Infinity` in every one of those, and the one that was forgotten
-- would be a seat check that had silently stopped checking. At 1000 all of that
-- arithmetic stays exactly as written; only the rendering changes, and only at
-- that value.
--
-- Widening a CHECK admits values the old one refused and rejects nothing that is
-- already stored, so this cannot fail on existing data and needs no backfill.
-- `event_accepted_count_within_capacity` is untouched and still holds.

ALTER TABLE "event" DROP CONSTRAINT IF EXISTS "event_capacity_range";
ALTER TABLE "event"
  ADD CONSTRAINT "event_capacity_range" CHECK ("capacity" BETWEEN 1 AND 1000);
