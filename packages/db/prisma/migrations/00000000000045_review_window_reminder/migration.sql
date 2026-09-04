-- Migration 0045: remembering that a review reminder was sent (v0.8.1).
--
-- ── What was missing ────────────────────────────────────────────────────────
--
-- `TEMPLATES.REVIEW_WINDOW_OPEN` has existed since M12. It has Persian copy, a
-- notification category, a deep link, and a case in `render()` — and **nothing
-- has ever emitted it**. The review window opens 24 hours after an activity
-- ends and closes seven days later, and for that whole week the only way to
-- learn there was a review waiting was to open `/reviews` and look. A review
-- nobody is reminded of is a review nobody writes, and an unwritten review is
-- one the counterparty never receives either, because the pair is blind.
--
-- ── Why a column and not a dedupe key ───────────────────────────────────────
--
-- `notification.dedupe_key` would absorb a repeat, so a sweep that re-announced
-- every hour would only ever deliver one message. It would also write an outbox
-- row per pending pair per hour, forever, for the sole purpose of having it
-- thrown away downstream — the retention purge cleaning up after a job that
-- should not have written anything. One nullable timestamp answers "has this
-- been announced?" where the question is actually asked.
--
-- It is also the honest record. "Was this user reminded, and when?" is a
-- question support will be asked, and `notification` rows are purged on a
-- retention schedule while `review_pair` lives as long as the pair does.
--
-- ── Additive, and inert on its own ──────────────────────────────────────────
--
-- One nullable column and one partial index. Nothing is dropped, renamed or
-- narrowed, and every existing row reads NULL — which the sweep treats as "not
-- yet announced", so the first run after the deploy reminds everybody whose
-- window is currently open. That is the intended behaviour rather than a
-- migration side effect: those are exactly the people who are owed a review and
-- have never been told.
ALTER TABLE "review_pair"
  ADD COLUMN IF NOT EXISTS "reminded_at" TIMESTAMPTZ(3);

-- The sweep's read: pairs that are open, not past their deadline, and not yet
-- announced.
--
-- **Not partial**, though `WHERE reminded_at IS NULL` is exactly the predicate
-- and would keep the index to the unannounced tail. `@@index` in `schema.prisma`
-- cannot express it, and `review_pair_due_idx` already records what happens to an
-- index Prisma cannot see: `prisma migrate dev` writes a migration to "fix" the
-- drift, and the fix is a DROP. A plain index that both sides agree on beats a
-- better index that one of them will delete.
CREATE INDEX IF NOT EXISTS "review_pair_reminder_due_idx"
  ON "review_pair" ("opens_at");
