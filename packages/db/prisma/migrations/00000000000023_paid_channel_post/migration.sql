-- Migration 0023: a channel post somebody paid for.
--
-- One additive enum value. Nothing reads it yet, no row carries it, and every
-- existing `channel_post` keeps the kind it has. Postgres 12+ permits
-- `ALTER TYPE … ADD VALUE` inside a transaction as long as the new value is not
-- *used* in the same one, which is why there is no INSERT below.
--
-- A fourth kind rather than a reuse of `BOOSTED`. `UNIQUE (event_id, kind)` is
-- what stops an event being posted twice for the same reason, so folding a paid
-- publication into `BOOSTED` would mean a host who had boosted could not also buy
-- a post — and the ledger could no longer say which of the two they bought.

ALTER TYPE "channel_post_kind" ADD VALUE IF NOT EXISTS 'PAID';
