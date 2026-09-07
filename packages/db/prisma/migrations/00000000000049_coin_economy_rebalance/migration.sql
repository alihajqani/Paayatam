-- The coin economy rebalance: three new ledger types (docs/coin-economy-plan.md).
--
-- Additive only, and the only kind of change this table can take: `coin_ledger` is
-- append-only by ADR-0007, so a new *reason* for coins to move is always a new
-- enum value and never a widened meaning for an existing one.
--
-- Why three values rather than one `HOST_SETTLEMENT`, or folding the refund into
-- the existing `HOST_CANCELLATION_REFUND`:
--
--   * `EVENT_DEPOSIT_REFUND` is money coming **back** — the registration charge
--     returned because the activity was actually held. It offsets a sink and must
--     not be counted as a grant, or the leak-rate metric in §12 reads every
--     successful host as a hole in the economy. `HOST_CANCELLATION_REFUND` is the
--     opposite case (the host cancelled and the *guests* are made whole), so
--     merging them would make "what did cancellations cost us?" unanswerable.
--   * `HOST_REWARD` is genuinely new money, paid per guest who turned up, and it
--     is capped. It has to be summable on its own for the cap to be enforceable
--     at all.
--   * `COMEBACK_GRANT` is the one-per-lifetime reactivation grant. Separate from
--     `ADMIN_ADJUSTMENT` for the reason `GIFT_CODE_REDEEM` is: "the system decided
--     somebody had run out" and "a human moved a balance by hand" are different
--     questions in an audit and have different people to ask about them.
--
-- Appended in this order, which is the order `schema.prisma` now lists them in:
-- Postgres records enum values in the order they were added, and a schema that
-- disagrees shows up as permanent drift in `migrate diff`.
--
-- No table, no column, no index. "Once in a lifetime" for the comeback grant and
-- "once per event" for the hosting settlement are both carried by the UNIQUE on
-- `coin_ledger.idempotency_key`, which already exists and is the same guarantee
-- every other one-time grant in this product leans on.

ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'EVENT_DEPOSIT_REFUND';
ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'HOST_REWARD';
ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'COMEBACK_GRANT';
