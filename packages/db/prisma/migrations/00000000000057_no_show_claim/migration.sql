-- Migration 0057: somebody saying what happened at an evening (plan 08).
--
-- ── What was missing ────────────────────────────────────────────────────────
--
-- Only a host could record a no-show, nothing could record a host who did not
-- come, and a guest charged sixty coins had no way to say «من حاضر بودم». Three
-- kinds of statement, all of them one person about one evening:
--
-- - GUEST_ABSENT_DISPUTE: a guest marked absent says they were there.
-- - HOST_ABSENT_REPORT:   a guest says the host never came.
-- - HOST_ABSENT_RESPONSE: the host answers those reports.
--
-- ── Why one table, and the UNIQUE ───────────────────────────────────────────
--
-- All three attach to a moderation case and are read together by whoever
-- decides it. `UNIQUE (kind, event_id, author_user_id)` is «each person, about
-- each evening, once» — a person has at most one participation per event, so it
-- holds for the dispute as well as for the reports.
--
-- The statement is plain text, like `report.description`: encryption in this
-- product is for conversations (ADR-0009), not for every sentence a user writes.
-- The CHECK is the form's bound restated, so a caller that skipped the form is
-- refused by the database rather than trusted.
--
-- ── The two columns ─────────────────────────────────────────────────────────
--
-- `event.host_absent_at`: a moderator upheld «میزبان نیامد». What
-- `HostRewardService` refuses a deposit on, and the answer to "was this evening
-- real?".
--
-- `event_participant.no_show_notified_at`: when the guest was told about the
-- no-show with a way to dispute it. The dispute window runs from here, not from
-- the no-show — for the no-shows recorded before this existed, nobody was told
-- until a message offers it (NULL until then), so a window from the no-show
-- itself would already be closed on people who never had one.
--
-- `TEXT` ids, like every other table here (see migration 0042).
--
-- Additive: one type, one table, two nullable columns.
CREATE TYPE "no_show_claim_kind" AS ENUM (
    'GUEST_ABSENT_DISPUTE',
    'HOST_ABSENT_REPORT',
    'HOST_ABSENT_RESPONSE'
);

CREATE TABLE "no_show_claim" (
    "id"                 TEXT                 NOT NULL,
    "event_id"           TEXT                 NOT NULL,
    "kind"               "no_show_claim_kind" NOT NULL,
    "participant_id"     TEXT,
    "author_user_id"     TEXT                 NOT NULL,
    "statement"          TEXT                 NOT NULL,
    "moderation_case_id" TEXT,
    "created_at"         TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "no_show_claim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "no_show_claim_kind_event_id_author_user_id_key"
    ON "no_show_claim"("kind", "event_id", "author_user_id");

-- What a moderator deciding a case reads.
CREATE INDEX "no_show_claim_moderation_case_id_idx" ON "no_show_claim"("moderation_case_id");

ALTER TABLE "no_show_claim"
    ADD CONSTRAINT "no_show_claim_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "no_show_claim"
    ADD CONSTRAINT "no_show_claim_participant_id_fkey"
    FOREIGN KEY ("participant_id") REFERENCES "event_participant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "no_show_claim"
    ADD CONSTRAINT "no_show_claim_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "no_show_claim"
    ADD CONSTRAINT "no_show_claim_moderation_case_id_fkey"
    FOREIGN KEY ("moderation_case_id") REFERENCES "moderation_case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The form's bound, restated where a caller that skipped the form meets it.
ALTER TABLE "no_show_claim"
    ADD CONSTRAINT "no_show_claim_statement_length"
    CHECK (char_length("statement") BETWEEN 10 AND 500);

-- A response is about the evening; a dispute and a report are about one seat.
ALTER TABLE "no_show_claim"
    ADD CONSTRAINT "no_show_claim_participant_matches_kind"
    CHECK (("kind" = 'HOST_ABSENT_RESPONSE') = ("participant_id" IS NULL));

ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "host_absent_at" TIMESTAMPTZ(3);
ALTER TABLE "event_participant" ADD COLUMN IF NOT EXISTS "no_show_notified_at" TIMESTAMPTZ(3);
