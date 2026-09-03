-- Retire the anonymous conversation (v0.8.0).
--
-- ── What this does not do ───────────────────────────────────────────────────
--
-- It does not drop a table. `anonymous_chat` and its four dependents still hold
-- real conversations between real people, a moderator can still be granted a
-- break-glass unseal against one under an open case, and a report filed while
-- the feature existed still points at a row here. Dropping them would destroy
-- the evidence for complaints that are open right now.
--
-- ── What it does ────────────────────────────────────────────────────────────
--
-- It closes them, which is the one thing the removal of the code makes
-- necessary. `retention_expires_at` is set when a chat **closes**, and the
-- nightly purge keys on it — so a chat left open by a build that can no longer
-- close one would never expire, and the ninety-day promise in the privacy notice
-- would quietly become "forever" for whoever happened to have a live
-- conversation on the day of this deploy.
--
-- So every non-closed chat is closed now, with the standard ninety-day clock
-- from ADR-0009 §8. Nothing is deleted today; everything is deleted on the
-- schedule it was promised, and moderation keeps its window in the meantime.
--
-- `closed_by_user_id` stays NULL on purpose: nobody decided this. The reason
-- column says what did.
UPDATE "anonymous_chat"
SET "status" = 'CLOSED',
    "closed_at" = NOW(),
    "close_reason" = 'feature_retired',
    "retention_expires_at" = NOW() + INTERVAL '90 days',
    "updated_at" = NOW()
WHERE "status" <> 'CLOSED';

-- The messages carry their own expiry, and the same rule applies: one written in
-- a chat that never closed has none, and the purge would never see it.
UPDATE "chat_message" m
SET "retention_expires_at" = NOW() + INTERVAL '90 days'
WHERE m."retention_expires_at" IS NULL;
