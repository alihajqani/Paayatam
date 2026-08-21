-- Migration 0019: the referral rejection the enum has always promised.
--
-- Hand-written like 0001–0018. `referral_status` has carried `REJECTED` since
-- migration 0009 and nothing has ever written it — `project-review.md` §16 asked
-- for a decision, and M19's decision is to wire it rather than drop the value.
--
-- The reason it was never wired is worth keeping: T6 says velocity is
-- **recorded, not enforced**, because a wrong automatic rejection silently steals
-- a real user's reward and nobody ever finds out. So `fraud_signals` were written
-- for a human to review, and the human had no button. This migration is the
-- button's half of the story — a rejection is an *administrative* act with a
-- reason code, a signature and an audit row, and never something the settlement
-- path decides on its own.
--
-- Nothing here is destructive. Every column is nullable, and the two CHECKs
-- constrain a state no existing row is in, which is precisely why they can be
-- added without a backfill.

CREATE TYPE "referral_rejection_reason" AS ENUM (
    'SELF_REFERRAL',
    'DUPLICATE',
    'INVALID_CODE',
    'FRAUD',
    'INELIGIBLE',
    'ADMIN_DECISION'
);

ALTER TABLE "referral" ADD COLUMN "rejected_at" TIMESTAMPTZ(3);
ALTER TABLE "referral" ADD COLUMN "rejection_reason" "referral_rejection_reason";
ALTER TABLE "referral" ADD COLUMN "rejected_by_admin_id" TEXT;
-- Internal only, and never projected to the referrer or the referred user:
-- naming the signal that fired is telling a farmer what to change next time.
ALTER TABLE "referral" ADD COLUMN "review_note" TEXT;

-- The four columns move together or not at all. This is §7's rule for a
-- moderation case — "terminal states require `decided_by` + `decision_note`" —
-- applied to the other terminal decision in the product that withholds money.
--
-- `rejected_by_admin_id` is deliberately **not** in the CHECK: the enum has values
-- for rejections a state machine can reach without a person (`SELF_REFERRAL`,
-- `DUPLICATE`), and "which admin?" must not be answerable when none did.
ALTER TABLE "referral"
    ADD CONSTRAINT "referral_rejection_is_signed"
    CHECK (
        "status" <> 'REJECTED'
        OR ("rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL)
    );

-- And the mirror: a referral that is not rejected must not carry a rejection.
-- Without this, moving one back to PENDING could leave the reason behind, and the
-- admin list would show a live referral with a rejection reason attached to it.
ALTER TABLE "referral"
    ADD CONSTRAINT "referral_rejection_is_cleared"
    CHECK (
        "status" = 'REJECTED'
        OR ("rejected_at" IS NULL AND "rejection_reason" IS NULL)
    );

ALTER TABLE "referral"
    ADD CONSTRAINT "referral_rejected_by_admin_id_fkey"
    FOREIGN KEY ("rejected_by_admin_id") REFERENCES "admin_user"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The admin queue reads "referrals in this state, newest first". `(status)` alone
-- has served the settlement path since 0009 and cannot order a page.
CREATE INDEX "referral_status_created_at_idx" ON "referral" ("status", "created_at");
