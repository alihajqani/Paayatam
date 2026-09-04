-- Migration 0047: the first thousand members, ranked (v0.9.0).
--
-- ── What this is for ────────────────────────────────────────────────────────
--
-- The launch campaign gives the first N users to *complete a profile* a
-- permanent rank ("you are member #427"), a tier, and a one-time coin grant that
-- declines by tier. The rank is shown on the user's own profile for as long as
-- the account exists and the running total is published to the channel, which is
-- what sets every constraint below.
--
-- ── Why the rank is counted at profile completion ───────────────────────────
--
-- The obvious implementation is a `gift_code` with `max_redemptions = 1000`:
-- that machinery already exists, already caps under a row lock, and needs no
-- migration at all. It was rejected for one reason. With a code, "member #427"
-- means "the 427th person who typed a string" — not the 427th member. A number
-- that sits on a profile for months and gets posted publicly cannot be a count
-- of who found and typed a code. Counting at profile completion also costs the
-- user nothing: it is allocated by the transaction they are already in.
--
-- The gift-code system is untouched and stays available for other campaigns.
--
-- ── Additive, and inert if the code is rolled back ──────────────────────────
--
-- Two new tables and nothing else: no column added to `user`, nothing dropped,
-- renamed or narrowed. `scripts/rollback.sh` does not undo migrations, so the
-- test that matters is whether the *previous* image runs against this schema —
-- and it does, because no existing read path can reach either table.

-- ── The counter ─────────────────────────────────────────────────────────────
--
-- One row, forever, enforced by the CHECK rather than by everyone remembering.
--
-- A counter row rather than a Postgres sequence, and the difference is the whole
-- point of the table. A sequence hands a number to a transaction that then rolls
-- back, and the number is gone: rank 428 would simply never exist. That gap is
-- invisible in most products and unexplainable in this one, because the number
-- is displayed ("نفر ۴۲۷ از ۱۰۰۰") and the running total is published. The
-- allocator is `UPDATE … SET next_rank = next_rank + 1 RETURNING`, which is
-- gap-free precisely because the number is only consumed if the transaction that
-- took it commits.
--
-- `max_rank` is a column, not a setting, because the conditional UPDATE has to
-- read it under the same row lock that increments the counter. A settings read
-- outside that lock would be a check that a concurrent transaction can beat —
-- which is the exact race the lock exists to remove.
CREATE TABLE IF NOT EXISTS "founding_campaign" (
  "id"         INTEGER      NOT NULL DEFAULT 1,
  "next_rank"  INTEGER      NOT NULL DEFAULT 1,
  "max_rank"   INTEGER      NOT NULL DEFAULT 1000,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "founding_campaign_pkey" PRIMARY KEY ("id"),
  -- There is exactly one campaign. A second row would give the allocator two
  -- counters and no way to say which one "the" rank came from.
  CONSTRAINT "founding_campaign_singleton" CHECK ("id" = 1),
  -- Ranks are 1-based and the cap is never below the floor.
  CONSTRAINT "founding_campaign_next_rank_positive" CHECK ("next_rank" >= 1),
  CONSTRAINT "founding_campaign_max_rank_positive" CHECK ("max_rank" >= 0)
);

-- The singleton itself. Created here rather than by a seed script because the
-- allocator's UPDATE silently allocates nothing when the row is absent — which
-- would look exactly like "the campaign is full" and would be found only by
-- somebody wondering why nobody is getting a rank.
INSERT INTO "founding_campaign" ("id", "next_rank", "max_rank")
VALUES (1, 1, 1000)
ON CONFLICT ("id") DO NOTHING;

-- ── The members ─────────────────────────────────────────────────────────────
--
-- Written once, never updated. There is no state machine here: a rank is
-- allocated or it is not, so nothing in this table transitions and nothing needs
-- `assertTransition`.
CREATE TABLE IF NOT EXISTS "founding_member" (
  -- PRIMARY KEY, which *is* the "one rank per person, for life" guarantee. Not
  -- a rule the service remembers — a rule the database enforces against every
  -- caller that will ever exist.
  "user_id"        TEXT    NOT NULL,
  "rank"           INTEGER NOT NULL,
  -- Snapshotted at allocation, exactly as `gift_code_redemption.coins` and
  -- `event_participant.cancellation_bucket` are. The tier boundaries are runtime
  -- settings and may be retuned; this row has to stay explainable against the
  -- tier that actually applied, not the one that applies today.
  "tier"           INTEGER NOT NULL,
  -- What was actually granted, snapshotted for the same reason.
  "coins"          INTEGER NOT NULL,
  -- The coin movement that paid it. Nullable because a tier configured to grant
  -- zero coins still produces a real member — the same argument that lets
  -- `trust_score_ledger.delta` be zero. UNIQUE because a ledger row cannot be
  -- claimed by two awards.
  "coin_ledger_id" TEXT,
  "awarded_at"     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "founding_member_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "founding_member_rank_positive" CHECK ("rank" >= 1),
  CONSTRAINT "founding_member_tier_positive" CHECK ("tier" >= 1),
  CONSTRAINT "founding_member_coins_non_negative" CHECK ("coins" >= 0),

  -- ON DELETE CASCADE: a deleted account takes its rank with it. The rank is
  -- not reissued — the counter never moves backwards — so the campaign can end
  -- with fewer than `max_rank` live members, which is the honest outcome.
  CONSTRAINT "founding_member_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- RESTRICT, as every other reference to the ledger is: a paid row is not
  -- deletable while something points at it.
  CONSTRAINT "founding_member_coin_ledger_id_fkey" FOREIGN KEY ("coin_ledger_id")
    REFERENCES "coin_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Gap-free numbering is only a property if it is enforced. Two allocations of
-- the same rank would be a bug in the allocator; this is what makes it a failed
-- INSERT instead of two members holding "#427".
CREATE UNIQUE INDEX IF NOT EXISTS "founding_member_rank_key"
  ON "founding_member"("rank");

-- One ledger row, one award.
CREATE UNIQUE INDEX IF NOT EXISTS "founding_member_coin_ledger_id_key"
  ON "founding_member"("coin_ledger_id");

-- "Who are the first hundred?" — the campaign roll-up, ordered.
CREATE INDEX IF NOT EXISTS "founding_member_tier_rank_idx"
  ON "founding_member"("tier", "rank");
