-- Migration 0030: a moderator's Telegram identity (v0.6.3, ADR-0018).
--
-- **Additive: one table, two indexes, no column touched.** Nothing reads it
-- until a row exists, and no row exists until a `SUPER_ADMIN` creates one —
-- there is no self-service path and there is not going to be one.
--
-- ── This changes the security model, and the ADR says so ────────────────────
--
-- ADR-0010's second decision is that *"the identity system is separate, and the
-- separation is the security control"*: `admin_user` has no foreign key to
-- `user`, the session namespace is disjoint, and — in the sentence this table
-- qualifies — **admin access does not follow from a staff member's personal
-- Telegram being taken over**.
--
-- A moderation queue inside the bot needs exactly that correspondence. ADR-0018
-- records the trade and the four things that bound it:
--
--   1. **The link is granted, never derived.** A row here is written by an admin
--      holding `role.manage` and is audited. Nothing about signing into the
--      panel, or about a Telegram account's name matching an admin's, creates
--      one.
--   2. **The bot session is a strict subset.** `BOT_PERMISSIONS` in
--      `admin-telegram.service.ts` is a hard-coded allowlist — the moderation
--      queue and nothing else. A taken-over Telegram account reaches a case
--      list; it cannot move coins, adjust Trust Score, unseal a conversation,
--      change a role, ban an account or edit a setting.
--   3. **Still no foreign key to `user`.** The link is to a Telegram id, so the
--      two identity systems remain disjoint *tables*, and deleting a user
--      neither cascades here nor reveals anything about staff.
--   4. **Revocation is a delete**, exactly as a role revocation is, and the
--      audit log carries the history — which is where "who could do this, and
--      when" is answered for every other grant in this product.
--
-- ── Why the id is a BIGINT and not a join ──────────────────────────────────
--
-- `telegram_user_id` is the highest-value PII in the product (ADR-0009), and it
-- already lives in exactly one table that one module reads. Pointing at
-- `telegram_account.user_id` instead would put a foreign key between the admin
-- identity system and the user one — the precise thing ADR-0010 forbids — so
-- the id is carried here directly, and invariant 7 applies to this column
-- exactly as it does to that one: it never appears in an API response, a log
-- line or a frontend bundle.
CREATE TABLE "admin_telegram_link" (
    "id"            TEXT   NOT NULL,
    "admin_user_id" TEXT   NOT NULL,
    -- The Telegram account that may open the moderation queue in the bot.
    "telegram_user_id" BIGINT NOT NULL,

    -- Who granted it. Not nullable: a capability nobody signed for is not a
    -- capability this table can represent.
    "granted_by_id" TEXT NOT NULL,
    /* Free text from the granter, for the same reason `decision_note` is
       required on a moderation decision — a grant nobody explained is not
       reviewable later. */
    "reason"        TEXT NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_telegram_link_pkey" PRIMARY KEY ("id")
);

-- One Telegram account is at most one admin, and one admin has at most one
-- Telegram account. Both enforced by the database rather than by a
-- read-then-write in the service, for the reason `conversation_state.user_id` is
-- UNIQUE: the window between a read and an insert is where a second grant
-- appears.
CREATE UNIQUE INDEX "admin_telegram_link_admin_user_id_key"
    ON "admin_telegram_link"("admin_user_id");
CREATE UNIQUE INDEX "admin_telegram_link_telegram_user_id_key"
    ON "admin_telegram_link"("telegram_user_id");

-- CASCADE on the subject: a deleted staff account must not leave a row that
-- still resolves to a session. RESTRICT on the granter would be wrong for the
-- opposite reason — losing the record of who signed for it — so that column
-- carries no foreign key at all, exactly as `audit_log.actor_id` does not.
ALTER TABLE "admin_telegram_link"
    ADD CONSTRAINT "admin_telegram_link_admin_user_id_fkey"
    FOREIGN KEY ("admin_user_id") REFERENCES "admin_user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
