-- Migration 0035: make `event.accepted_count` mean what v0.6.5 says it means.
--
-- Data only. No column is added, dropped, renamed or narrowed, and the statement
-- is idempotent — running it twice changes nothing the second time.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why a data migration is required, and not merely tidy
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `accepted_count` is a **stored counter**, not a view. Nothing recomputes it:
-- it is moved one at a time by `takeSeat` and `releaseSeat` under the event row
-- lock, which is what makes the capacity check in `join` a single indexed read
-- instead of a COUNT over `event_participant` on the product's most contended
-- write path (ADR-0006).
--
-- v0.6.5 changed what the counter counts. It was `PENDING + ACCEPTED` — seats
-- *spoken for* — and it is now `ACCEPTED` alone, because a request nobody has
-- answered is not a filled seat and «۰ جای خالی» on an activity nobody was
-- accepted to is a false statement. See `SEAT_HOLDING_STATUSES`.
--
-- Changing the definition in code does not change the numbers already in the
-- table. Every event that has an outstanding request right now carries a value
-- computed under the old rule, and **no code path will ever bring it down
-- again**: the only decrement is `releaseSeat`, and it is now reached solely for
-- participants who were ACCEPTED. A rejection or an expiry of a PENDING request
-- correctly releases nothing, so the inflated count is permanent.
--
-- Concretely, this is the operator's original report. An activity with two
-- places, one rejected request and one expired one, showed «ظرفیت تکمیل».
-- Shipping the code fix without this migration leaves that activity — and every
-- other activity that already exists — reading exactly as wrong as it did
-- before, while the tests all pass, because the tests build their rows under the
-- new rule.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why recomputing from the rows is safe
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `event_participant` is the ground truth and the counter is the cache, so the
-- rows can only correct the counter and never the reverse.
--
-- The CHECK `accepted_count >= 0 AND accepted_count <= capacity` (migration 0004,
-- invariant 1) holds through this by construction: the new value counts a subset
-- of what the old value counted, so it is less than or equal to a number that
-- already satisfied the constraint. This migration can lower a count and can
-- never raise one.
--
-- `IS DISTINCT FROM` rather than `<>` so the comparison is total, and it is what
-- makes the statement idempotent — a second run matches no rows and writes
-- nothing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The window this does not close
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `deploy.sh` runs migrations (§5) and *then* restarts the containers (§6), so
-- for the few seconds between the two the previous release is still serving. A
-- join that lands in that window is counted by the old code under the old rule
-- and re-inflates that one event by one.
--
-- Left as it is rather than designed around, because the alternative is stopping
-- the product for the length of a deploy to protect against a single join
-- arriving in a several-second window. The repair is to run this statement again
-- afterwards, which is why it was written to be idempotent:
--
--   ./scripts/compose.sh exec -T postgres psql -U payetam -d payetam \
--     -f - < packages/db/prisma/migrations/00000000000035_seat_accounting_backfill/migration.sql
--
-- DEPLOYMENT.md §13 says so beside the other v0.6.5 notes.
UPDATE "event" e
SET "accepted_count" = c."seats"
FROM (
    SELECT ev."id" AS "id",
           COUNT(p."id") FILTER (WHERE p."status" = 'ACCEPTED') AS "seats"
    FROM "event" ev
    LEFT JOIN "event_participant" p ON p."event_id" = ev."id"
    GROUP BY ev."id"
) c
WHERE e."id" = c."id"
  AND e."accepted_count" IS DISTINCT FROM c."seats";
