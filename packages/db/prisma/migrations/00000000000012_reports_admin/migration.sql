-- Migration 0012: reports, admin identity, RBAC and break-glass (ADR-0010).
--
-- Hand-written like the rest. Three things here are load-bearing and everything
-- else is bookkeeping:
--
-- 1. `UNIQUE (target_type, target_id, reporter_user_id)` — invariant 5. It is also
--    what makes the auto-hide threshold mean **distinct people**: counting rows
--    counts reporters, because the index makes a second row from one person
--    impossible. A threshold over a count that could contain duplicates would let
--    one determined person hide anybody's event.
--
-- 2. **`admin_user` has no foreign key to `user`, and must never gain one.**
--    ADR-0010 rejects a role column on `user` precisely so a privilege-escalation
--    bug in user-facing code cannot become an admin compromise. The absence of
--    that FK is the decision; it is not an oversight to be tidied up later.
--
-- 3. `chat_unseal_grant` is a *row*, not a flag. Reading private messages needs
--    `chat.read`, an open case naming the chat, and a written reason, and it lasts
--    fifteen minutes. Every one of those facts is a column, so "who read what, why,
--    and under whose authority" is answerable from the table rather than from a
--    log somebody has to correlate.

CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "report_reason" AS ENUM (
    'SPAM',
    'HARASSMENT',
    'INAPPROPRIATE',
    'SCAM',
    'IMPERSONATION',
    'SAFETY',
    'OTHER'
);

CREATE TYPE "report_status" AS ENUM ('OPEN', 'ACTIONED', 'DISMISSED');
CREATE TYPE "admin_user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');
CREATE TYPE "role_change_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- ─────────────────────────────────────────────────────────────────────────────
-- report
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "report" (
    "id"                 TEXT                      NOT NULL,
    "public_id"          TEXT                      NOT NULL,
    "target_type"        "moderation_subject_type" NOT NULL,
    "target_id"          TEXT                      NOT NULL,
    "reporter_user_id"   TEXT                      NOT NULL,
    "reason"             "report_reason"           NOT NULL,
    "description"        TEXT,
    "status"             "report_status"           NOT NULL DEFAULT 'OPEN',
    "moderation_case_id" TEXT,
    "created_at"         TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(3)            NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id"),

    -- Capped where it is stored, not only where it is parsed.
    CONSTRAINT "report_description_length" CHECK (
        "description" IS NULL OR length("description") <= 1000
    )
);

CREATE UNIQUE INDEX "report_public_id_key" ON "report" ("public_id");

-- Invariant 5, and the reason the threshold counts people rather than clicks.
CREATE UNIQUE INDEX "report_target_type_target_id_reporter_user_id_key"
    ON "report" ("target_type", "target_id", "reporter_user_id");

CREATE INDEX "report_target_type_target_id_status_idx"
    ON "report" ("target_type", "target_id", "status");
CREATE INDEX "report_status_created_at_idx" ON "report" ("status", "created_at");

ALTER TABLE "report"
    ADD CONSTRAINT "report_reporter_user_id_fkey"
    FOREIGN KEY ("reporter_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "report"
    ADD CONSTRAINT "report_moderation_case_id_fkey"
    FOREIGN KEY ("moderation_case_id") REFERENCES "moderation_case"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_user — a separate identity system (ADR-0010)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "admin_user" (
    "id"              TEXT                NOT NULL,
    "email"           CITEXT              NOT NULL,
    "password_hash"   TEXT                NOT NULL,
    -- Not nullable: TOTP is mandatory (D11), so "an admin without a second
    -- factor" is not a state this table can represent.
    "totp_secret_enc" TEXT                NOT NULL,
    "display_name"    TEXT                NOT NULL,
    "status"          "admin_user_status" NOT NULL DEFAULT 'ACTIVE',
    "failed_attempts" INTEGER             NOT NULL DEFAULT 0,
    "locked_until"    TIMESTAMPTZ(3),
    "last_login_at"   TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)      NOT NULL,

    CONSTRAINT "admin_user_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_user_failed_attempts_non_negative" CHECK ("failed_attempts" >= 0)
);

-- CITEXT, so `Ali@x.com` and `ali@x.com` are one account rather than two.
CREATE UNIQUE INDEX "admin_user_email_key" ON "admin_user" ("email");
CREATE INDEX "admin_user_status_idx" ON "admin_user" ("status");

-- ─────────────────────────────────────────────────────────────────────────────
-- RBAC
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "role" (
    "id"   TEXT NOT NULL,
    "key"  TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "role_key_key" ON "role" ("key");

CREATE TABLE "permission" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "permission_key_key" ON "permission" ("key");

CREATE TABLE "role_permission" (
    "role_id"       TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id", "permission_id")
);

ALTER TABLE "role_permission"
    ADD CONSTRAINT "role_permission_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permission"
    ADD CONSTRAINT "role_permission_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "admin_user_role" (
    "admin_user_id" TEXT           NOT NULL,
    "role_id"       TEXT           NOT NULL,
    "granted_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_role_pkey" PRIMARY KEY ("admin_user_id", "role_id")
);

ALTER TABLE "admin_user_role"
    ADD CONSTRAINT "admin_user_role_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_user_role"
    ADD CONSTRAINT "admin_user_role_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- role_change_request — four-eyes (ADR-0010, rule 4)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "role_change_request" (
    "id"               TEXT                 NOT NULL,
    "subject_admin_id" TEXT                 NOT NULL,
    "role_key"         TEXT                 NOT NULL,
    "granting"         BOOLEAN              NOT NULL,
    "reason"           TEXT                 NOT NULL,
    "requested_by_id"  TEXT                 NOT NULL,
    "approved_by_id"   TEXT,
    "status"           "role_change_status" NOT NULL DEFAULT 'PENDING',
    "created_at"       TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at"       TIMESTAMPTZ(3),

    CONSTRAINT "role_change_request_pkey" PRIMARY KEY ("id"),

    -- **This is the four-eyes rule, in the database.** A SUPER_ADMIN cannot
    -- unilaterally grant capabilities, not even to themselves: the approver must
    -- be somebody else. A service check alone is one refactor from being skipped,
    -- and this is the rule that stops a compromised admin account from quietly
    -- becoming every role at once.
    CONSTRAINT "role_change_request_needs_second_pair_of_eyes" CHECK (
        "approved_by_id" IS NULL OR "approved_by_id" <> "requested_by_id"
    ),

    -- A decided request says when, and a pending one does not pretend to.
    CONSTRAINT "role_change_request_decided_at_matches_status" CHECK (
        ("status" = 'PENDING') = ("decided_at" IS NULL)
    )
);

CREATE INDEX "role_change_request_status_created_at_idx"
    ON "role_change_request" ("status", "created_at");

ALTER TABLE "role_change_request"
    ADD CONSTRAINT "role_change_request_subject_admin_id_fkey"
    FOREIGN KEY ("subject_admin_id") REFERENCES "admin_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_change_request"
    ADD CONSTRAINT "role_change_request_requested_by_id_fkey"
    FOREIGN KEY ("requested_by_id") REFERENCES "admin_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_change_request"
    ADD CONSTRAINT "role_change_request_approved_by_id_fkey"
    FOREIGN KEY ("approved_by_id") REFERENCES "admin_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- chat_unseal_grant — break-glass (ADR-0010, T14)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "chat_unseal_grant" (
    "id"                 TEXT           NOT NULL,
    "chat_id"            TEXT           NOT NULL,
    "admin_user_id"      TEXT           NOT NULL,
    -- NOT NULL, and that is the control: a grant that names no case cannot exist,
    -- so "reading a chat requires an open case" is a column rather than a check.
    "moderation_case_id" TEXT           NOT NULL,
    "reason"             TEXT           NOT NULL,
    "granted_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"         TIMESTAMPTZ(3) NOT NULL,
    "read_count"         INTEGER        NOT NULL DEFAULT 0,

    CONSTRAINT "chat_unseal_grant_pkey" PRIMARY KEY ("id"),

    -- Time-boxed by construction. A grant that never expires is standing access.
    CONSTRAINT "chat_unseal_grant_is_time_boxed" CHECK ("expires_at" > "granted_at"),
    -- A written reason, not an empty string standing in for one.
    CONSTRAINT "chat_unseal_grant_reason_present" CHECK (length(btrim("reason")) >= 10),
    CONSTRAINT "chat_unseal_grant_read_count_non_negative" CHECK ("read_count" >= 0)
);

CREATE INDEX "chat_unseal_grant_admin_user_id_granted_at_idx"
    ON "chat_unseal_grant" ("admin_user_id", "granted_at");
CREATE INDEX "chat_unseal_grant_expires_at_idx" ON "chat_unseal_grant" ("expires_at");

ALTER TABLE "chat_unseal_grant"
    ADD CONSTRAINT "chat_unseal_grant_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES "anonymous_chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat_unseal_grant"
    ADD CONSTRAINT "chat_unseal_grant_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "chat_unseal_grant"
    ADD CONSTRAINT "chat_unseal_grant_moderation_case_id_fkey"
    FOREIGN KEY ("moderation_case_id") REFERENCES "moderation_case"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
