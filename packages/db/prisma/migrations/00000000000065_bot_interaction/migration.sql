-- Migration 0065: what people do in the bot (interaction tracking).
--
-- ── What was missing ────────────────────────────────────────────────────────
--
-- `user_acquisition` records the one `/start` that created an account, and
-- `audit_log` records state transitions. Between them the product could not say
-- how often a link was tapped by people who already had an account, which
-- buttons are pressed, whether anybody goes past the welcome, or what refused
-- them when they stopped. `telegram_account.last_seen_at` looked like an answer
-- and was not: only `/start` writes it.
--
-- ── What this records ───────────────────────────────────────────────────────
--
-- One row per Telegram update the bot handles: who (the internal user id), what
-- kind of update, the *name* of what was pressed, the public id it pointed at,
-- the form and step on screen afterwards, how the bot answered, and how long it
-- took. Written by `BotService.dispatch` after the update is handled.
--
-- ── What it must never hold, and how the database says so ───────────────────
--
-- No message text and no Telegram user id. The first is a rule about a writer
-- that will be edited by people in a hurry, so it is also a rule here: every
-- text column is constrained to the alphabet a *name* is written in. A typed
-- sentence — Persian, spaces, punctuation — fails the CHECK and the row is not
-- written at all, which is the right failure: a lost count, not a stored
-- message. `message_id` is Telegram's per-chat message counter, the same value
-- `notification.telegram_message_id` already holds; it identifies nobody.
--
-- ── Additive, and inert if the code is rolled back ──────────────────────────
--
-- Two types and one table; nothing existing changes. The previous image never
-- reads or writes the table, so `scripts/rollback.sh` leaves a schema it runs
-- against unchanged, and the days it runs are simply days with no rows.
CREATE TYPE "bot_interaction_kind" AS ENUM (
    'START',
    'COMMAND',
    'CALLBACK',
    'KEYBOARD',
    'TEXT',
    'PHOTO',
    'UNSUPPORTED',
    'BLOCKED',
    'UNBLOCKED'
);

CREATE TYPE "bot_interaction_outcome" AS ENUM (
    'OK',
    'REFUSED',
    'GATED',
    'STALE',
    'FAILED',
    'NO_ACCOUNT'
);

CREATE TABLE IF NOT EXISTS "bot_interaction" (
  "id"              TEXT                      NOT NULL,
  -- Telegram's own id for the update. UNIQUE (below) is the whole of the
  -- idempotency: Telegram redelivers any update whose webhook call did not
  -- answer 200, and a tap counted twice is a report that is wrong by one.
  "update_id"       BIGINT                    NOT NULL,
  -- Null when the sender has no usable account: never started, banned, deleted.
  "user_id"         TEXT,
  "kind"            "bot_interaction_kind"    NOT NULL,
  "action"          TEXT                      NOT NULL,
  "ref"             TEXT,
  -- True on the `/start` that created the account, which is what separates a
  -- link's new people from the members who followed it.
  "created_account" BOOLEAN                   NOT NULL DEFAULT false,
  "message_id"      INTEGER,
  "wizard_kind"     TEXT,
  "wizard_step"     TEXT,
  "outcome"         "bot_interaction_outcome" NOT NULL DEFAULT 'OK',
  "detail"          TEXT,
  "screen"          TEXT,
  "duration_ms"     INTEGER                   NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bot_interaction_pkey" PRIMARY KEY ("id"),

  -- A name: `ev:show`, `cmd:discover`, `mn:c:create_event`. Lower-case, so a
  -- report never splits one button across two spellings.
  CONSTRAINT "bot_interaction_action_is_a_name"
    CHECK ("action" ~ '^[a-z0-9_:]{1,64}$'),

  -- What a `?start=` payload could carry — the same rule `user_acquisition.ref`
  -- has — which also admits a public id and a guide's slug.
  CONSTRAINT "bot_interaction_ref_is_an_id"
    CHECK ("ref" IS NULL OR "ref" ~ '^[A-Za-z0-9_-]{1,64}$'),

  -- A conversation kind, and a step key or one of the `$` markers
  -- (`$summary`, `$submitted`, `$cancelled`).
  CONSTRAINT "bot_interaction_wizard_is_a_name" CHECK (
    ("wizard_kind" IS NULL OR "wizard_kind" ~ '^[A-Z_]{1,40}$')
    AND ("wizard_step" IS NULL OR "wizard_step" ~ '^[$]?[a-z0-9_]{1,24}$')
  ),

  -- An error code or the name of a gate, and a template key (`bot.welcome`).
  CONSTRAINT "bot_interaction_detail_is_a_code"
    CHECK ("detail" IS NULL OR "detail" ~ '^[A-Za-z0-9_]{1,64}$'),
  CONSTRAINT "bot_interaction_screen_is_a_template"
    CHECK ("screen" IS NULL OR "screen" ~ '^[a-z0-9_.]{1,64}$'),

  CONSTRAINT "bot_interaction_duration_non_negative" CHECK ("duration_ms" >= 0),

  -- ON DELETE CASCADE, as `notification` does. Accounts are anonymised rather
  -- than deleted, so in practice the trail outlives the profile — and when a row
  -- of `user` really is removed, what that person did goes with them.
  CONSTRAINT "bot_interaction_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "bot_interaction_update_id_key"
  ON "bot_interaction"("update_id");

-- One person's trail, and the window function that cuts it into visits.
CREATE INDEX IF NOT EXISTS "bot_interaction_user_id_created_at_idx"
  ON "bot_interaction"("user_id", "created_at");

-- Every report's window, and the retention purge.
CREATE INDEX IF NOT EXISTS "bot_interaction_created_at_idx"
  ON "bot_interaction"("created_at");

-- "How often was this pressed?" — the buttons and the links reports.
CREATE INDEX IF NOT EXISTS "bot_interaction_action_created_at_idx"
  ON "bot_interaction"("action", "created_at");
