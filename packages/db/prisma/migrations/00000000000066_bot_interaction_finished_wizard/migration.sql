-- Migration 0066: which form an update finished.
--
-- ── What 0065 could not say ─────────────────────────────────────────────────
--
-- `bot_interaction` has one place for a form: `wizard_kind` and `wizard_step`,
-- the form and the step **left on screen** once the update was handled. That is
-- the right thing to record for a form somebody abandons — its last row names
-- the question that lost them.
--
-- It is the wrong place to record that a form was *submitted*, because an update
-- can submit one form and open the next. Accepting the terms does exactly that:
-- «می‌پذیرم» writes the acceptance and draws the first question of the profile
-- form, in one update. The row then says "profile form, first step", and nothing
-- anywhere says the terms were accepted. A funnel over 0065's columns would show
-- the terms as a form everybody starts and nobody finishes — for the most
-- important form in the product, on the path every new account takes.
--
-- ── What this adds ──────────────────────────────────────────────────────────
--
-- `finished_wizard`: the kind of the form this update submitted, whatever was
-- drawn afterwards. `outcome` already says whether the product accepted it, so
-- `finished_wizard = 'CREATE_EVENT' AND outcome = 'REFUSED'` is somebody who
-- pressed «ثبت» and was told no.
--
-- With it, `wizard_step` stops carrying a `$submitted` mark: after a form is
-- sent there is no form on screen, and both columns are null unless the same
-- update opened another. One fact per column.
--
-- ── Additive, and released with the table it amends ─────────────────────────
--
-- One nullable column and its CHECK. 0065 and this migration ship in the same
-- release, so no production row is ever written under the old meaning of
-- `wizard_step`. An image rolled back to before either neither reads nor
-- writes the table.
ALTER TABLE "bot_interaction"
  ADD COLUMN IF NOT EXISTS "finished_wizard" TEXT;

-- A conversation kind, by the rule `wizard_kind` already has.
DO $$ BEGIN
  ALTER TABLE "bot_interaction"
    ADD CONSTRAINT "bot_interaction_finished_wizard_is_a_name"
    CHECK ("finished_wizard" IS NULL OR "finished_wizard" ~ '^[A-Z_]{1,40}$');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
