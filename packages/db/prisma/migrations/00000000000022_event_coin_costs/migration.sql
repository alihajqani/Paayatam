-- Migration 0022: three names for the three things M22 charges for.
--
-- Its own migration rather than folded into 0021, because 0021 has already been
-- applied to the development and test databases and editing an applied migration
-- changes its checksum — which `prisma migrate deploy` is right to refuse.
--
-- `ALTER TYPE … ADD VALUE` is additive: nothing reads these values yet, no row
-- carries one, and every existing `coin_ledger` row keeps the type it has.
-- Postgres 12+ permits it inside a transaction as long as the new value is not
-- *used* in the same transaction, which is why there is no INSERT below.
--
-- Three values rather than a single `SPEND`, for the reason `GIFT_CODE_REDEEM` is
-- separate from `ADMIN_ADJUSTMENT` (0017): "they made an event", "they pushed one
-- to the channel" and "they paid to invite twenty people" are different questions
-- in an audit, with different people to ask about them — and a ledger that cannot
-- tell them apart cannot answer "how much did promotion earn us this month?".

ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'EVENT_CREATE_SPEND';
ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'CHANNEL_POST_SPEND';
ALTER TYPE "coin_ledger_type" ADD VALUE IF NOT EXISTS 'INVITE_SPEND';
