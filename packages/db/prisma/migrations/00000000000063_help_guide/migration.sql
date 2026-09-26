-- Migration 0063: the in-bot guide, editable from the admin panel.
--
-- ── What this table holds, and what it does not ─────────────────────────────
--
-- The guide's sections and their default text live in code
-- (`HELP_GUIDE_DEFAULTS` in `@payetam/domain`), the way `SETTING_DEFAULTS` does
-- for numbers. A row here exists only for a section somebody edited in the
-- panel, and each column overrides one thing: a NULL `title` or `body` means
-- "the default from code". Resetting a section deletes its row.
--
-- That split is deliberate. A release that improves a section's default reaches
-- every section nobody edited, and an edited section keeps its operator's text
-- until they choose to reset it.
--
-- ── Additive, and inert if the code is rolled back ──────────────────────────
--
-- One new table. The previous image never reads it, so a rollback shows the
-- old `/help` and leaves any edits here unused.

CREATE TABLE IF NOT EXISTS "help_guide" (
  "slug"       TEXT           NOT NULL,
  "title"      TEXT,
  "body"       TEXT,
  "hidden"     BOOLEAN        NOT NULL DEFAULT false,
  "updated_by" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "help_guide_pkey" PRIMARY KEY ("slug"),

  -- A button label, so short enough to read on a phone; the service enforces
  -- the same bound with a Persian message, this is the backstop.
  CONSTRAINT "help_guide_title_length"
    CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 40),

  -- One Telegram message is 4096 characters; the page adds a heading and a
  -- footer, so the body stops well short of it.
  CONSTRAINT "help_guide_body_length"
    CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 3500)
);
