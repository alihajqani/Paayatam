-- Migration 0051: when a moderator was last told the queue had work (plan 06).
--
-- ── What was missing ────────────────────────────────────────────────────────
--
-- A case that lands in the moderation queue waits until somebody opens the
-- queue on their own. ADR-0018 names the fix as "the obvious next feature": an
-- event held by a BLOCK verdict is invisible until a moderator decides it, so
-- the silence is paid for by a host who did nothing wrong.
--
-- ── Why a column on the link, not Redis ─────────────────────────────────────
--
-- The digest is sent at most once per quiet period per moderator, so the last
-- send has to be remembered. Redis was cheaper and rejected: a FLUSHALL or a
-- restart without persistence would tell every moderator again at once, and
-- "why was I not told?" should have an answer in the database rather than in a
-- memory that is gone. One row per linked moderator, written at most every
-- quarter hour.
--
-- Additive and nullable: NULL means "never told", which is what every existing
-- link is.

ALTER TABLE "admin_telegram_link"
  ADD COLUMN IF NOT EXISTS "last_digest_at" TIMESTAMPTZ(3);
