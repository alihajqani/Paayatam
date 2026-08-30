-- Migration 0028: notification preferences (v0.6.1).
--
-- **Additive: one table, one index, no column touched.** v0.6.0 runs unchanged
-- against this schema — it never reads the table, and every default here is the
-- behaviour it already has. That is what makes the deploy reversible without a
-- down migration; `rollback.sh` cannot undo one anyway.
--
-- ── Why only notifications ─────────────────────────────────────────────────
--
-- The settings screen shows three things and this table holds one of them,
-- because the other two already exist and duplicating a setting is how two
-- sources of truth start:
--
--   * **Language** is `user.locale`, a column since M2.
--   * **Privacy** is `user_profile.invite_opt_out`, which `ProfileService.update`
--     has accepted since M22 and which the invitation pool already reads.
--
-- Only the notification preferences had nowhere to live.
--
-- ── Why the defaults are all true ──────────────────────────────────────────
--
-- A row is created on first write, so a user who has never opened the screen has
-- no row at all — and the service resolves that absence to these same defaults.
-- Anything else would mean the table's existence silently changed what existing
-- users receive.
--
-- ── What is deliberately not switchable ────────────────────────────────────
--
-- Consent, policy changes, moderation outcomes and account state. Those are not
-- notifications a person opts out of; they are the product telling somebody
-- something it is obliged to tell them. `notificationCategory` marks them
-- `essential` and the worker never consults a preference for them.
CREATE TABLE "user_settings" (
    "id"      TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    -- Chat relays: somebody wrote to you in an anonymous conversation.
    "notify_chat"      BOOLEAN NOT NULL DEFAULT true,
    -- Activity lifecycle: requests, acceptances, waitlist moves, reminders.
    "notify_events"    BOOLEAN NOT NULL DEFAULT true,
    -- Admin campaigns and paid invitations. The one most people will turn off.
    "notify_campaigns" BOOLEAN NOT NULL DEFAULT true,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- One row per person, enforced by the database rather than by a read-then-write
-- in the service — the same reason `conversation_state.user_id` is UNIQUE.
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- CASCADE, not RESTRICT: a preference is not a record anybody needs kept once
-- the person it belongs to is gone. M15's anonymisation deletes the user row.
ALTER TABLE "user_settings"
    ADD CONSTRAINT "user_settings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A notification the recipient asked not to receive.
--
-- Distinct from UNDELIVERABLE, which means "the bot is blocked" and whose helper
-- also sets `telegram_account.bot_blocked` — recording an opt-out as a block
-- would make the Mini App show a re-start banner to somebody who had simply
-- turned a category off, and would suppress *everything* rather than one kind.
--
-- Distinct from FAILED, because nothing failed. A retry would reach the same
-- answer more slowly, so this is terminal.
--
-- The row is still written and still kept: a preference is about delivery, not
-- about whether the product had something to say. «Did we tell them?» six weeks
-- later should answer "we had this, and they had asked us not to" rather than
-- leaving no trace.
ALTER TYPE "notification_status" ADD VALUE IF NOT EXISTS 'SUPPRESSED';
