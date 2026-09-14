-- Migration 0056: the enum members a no-show dispute needs (plan 08).
--
-- Its own file, as 0027, 0032 and 0043 are: `ALTER TYPE … ADD VALUE` touches no
-- row, a running build simply never writes the new values, and on Postgres 16 it
-- may run in a transaction as long as nothing in the same transaction uses the
-- value. Migration 0057 is the first thing that does.
--
-- - `PARTICIPATION`: a case about one person's attendance at one evening — «من
--   حاضر بودم» is not about the event, the user or a review.
-- - `DISPUTE`: why the case opened. `MANUAL` would say a moderator opened it,
--   which is not true, and `REPORT_THRESHOLD` would make `decideCase` treat it as
--   content to keep or hide.
-- - `NO_SHOW_CLAIM`: the one-question form all three kinds of claim use.
ALTER TYPE "moderation_subject_type" ADD VALUE IF NOT EXISTS 'PARTICIPATION';
ALTER TYPE "moderation_trigger" ADD VALUE IF NOT EXISTS 'DISPUTE';
ALTER TYPE "conversation_kind" ADD VALUE IF NOT EXISTS 'NO_SHOW_CLAIM';
