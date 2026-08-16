-- Migration 0011: blind reviews (ADR-0011, D7/D7a).
--
-- Hand-written like 0001–0009. The whole point of this schema is one property:
-- **neither side can read the other's review while writing their own**. That is a
-- read-path rule, so most of it lives in the service — but the shape here is what
-- makes the rule enforceable rather than merely intended:
--
-- 1. `review_pair` is **one row holding both sides**. Two independent review rows
--    with their own deadlines would need a second source of truth for "has the
--    other side written yet?", and that answer would be read at least once while
--    it was wrong. One row makes "reveal both at once" a single UPDATE.
--
-- 2. A review's readability is a property of its **pair**, not of itself. The
--    read path joins through `review_pair` and filters on the pair's status, so an
--    unrevealed review is absent from a response rather than filtered out of one.
--
-- 3. `UNIQUE (participant_id, reviewer_user_id)` is invariant 6, in the database.
--    A duplicate review is impossible rather than unlikely.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "review_status" AS ENUM ('SUBMITTED', 'REVEALED', 'HIDDEN');

CREATE TYPE "review_pair_status" AS ENUM (
    'PENDING',
    'PARTIAL',
    'REVEALED',
    'EXPIRED_PARTIAL',
    'EXPIRED_EMPTY'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- review
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "review" (
    "id"                TEXT                      NOT NULL,
    "public_id"         TEXT                      NOT NULL,
    "event_id"          TEXT                      NOT NULL,
    "participant_id"    TEXT                      NOT NULL,
    "reviewer_user_id"  TEXT                      NOT NULL,
    "reviewee_user_id"  TEXT                      NOT NULL,
    "rating"            INTEGER                   NOT NULL,
    "tags"              TEXT[]                    NOT NULL DEFAULT ARRAY[]::TEXT[],
    "comment"           TEXT,
    "status"            "review_status"           NOT NULL DEFAULT 'SUBMITTED',
    "moderation_status" "event_moderation_status" NOT NULL DEFAULT 'APPROVED',
    "submitted_at"      TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealed_at"       TIMESTAMPTZ(3),
    "edit_deadline_at"  TIMESTAMPTZ(3)            NOT NULL,
    "created_at"        TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(3)            NOT NULL,

    CONSTRAINT "review_pkey" PRIMARY KEY ("id"),

    -- §4.6. A rating outside the scale is not a lenient input to normalise, it is
    -- a client that is wrong about the product.
    CONSTRAINT "review_rating_within_scale" CHECK ("rating" BETWEEN 1 AND 5),

    -- §4.6, and the cheapest integrity control there is: nobody reviews themselves.
    CONSTRAINT "review_not_self" CHECK ("reviewer_user_id" <> "reviewee_user_id"),

    -- Free text is capped where it is stored, not only where it is parsed. A zod
    -- schema protects the endpoint; this protects the column.
    CONSTRAINT "review_comment_length" CHECK ("comment" IS NULL OR length("comment") <= 500),

    -- A revealed review carries the moment it was revealed, and one that has not
    -- been revealed must not claim to have been. This is the column the public
    -- read path orders by, so a lie here is a lie in somebody's profile.
    CONSTRAINT "review_revealed_at_matches_status" CHECK (
        ("status" = 'SUBMITTED') = ("revealed_at" IS NULL)
    ),

    -- At most five, so one reviewer cannot flood the vocabulary, and no empties.
    CONSTRAINT "review_tags_bounded" CHECK (
        array_length("tags", 1) IS NULL OR array_length("tags", 1) <= 5
    )
);

CREATE UNIQUE INDEX "review_public_id_key" ON "review" ("public_id");

-- Invariant 6. One review per (participation, reviewer), decided by the database
-- rather than by a read the service performed a moment earlier.
CREATE UNIQUE INDEX "review_participant_id_reviewer_user_id_key"
    ON "review" ("participant_id", "reviewer_user_id");

-- The public profile read: everything revealed about one person, newest first.
CREATE INDEX "review_reviewee_user_id_status_submitted_at_idx"
    ON "review" ("reviewee_user_id", "status", "submitted_at");
CREATE INDEX "review_event_id_idx" ON "review" ("event_id");

ALTER TABLE "review"
    ADD CONSTRAINT "review_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review"
    ADD CONSTRAINT "review_participant_id_fkey"
    FOREIGN KEY ("participant_id") REFERENCES "event_participant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review"
    ADD CONSTRAINT "review_reviewer_user_id_fkey"
    FOREIGN KEY ("reviewer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review"
    ADD CONSTRAINT "review_reviewee_user_id_fkey"
    FOREIGN KEY ("reviewee_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- review_pair
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "review_pair" (
    "id"              TEXT                 NOT NULL,
    "participant_id"  TEXT                 NOT NULL,
    "event_id"        TEXT                 NOT NULL,
    "host_review_id"  TEXT,
    "guest_review_id" TEXT,
    "opens_at"        TIMESTAMPTZ(3)       NOT NULL,
    "deadline_at"     TIMESTAMPTZ(3)       NOT NULL,
    "status"          "review_pair_status" NOT NULL DEFAULT 'PENDING',
    "revealed_at"     TIMESTAMPTZ(3),
    "created_at"      TIMESTAMPTZ(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)       NOT NULL,

    CONSTRAINT "review_pair_pkey" PRIMARY KEY ("id"),

    -- The window has to be a window.
    CONSTRAINT "review_pair_window_ordered" CHECK ("deadline_at" > "opens_at"),

    -- The status and the two review columns must agree. Without this a pair could
    -- claim to be REVEALED with nothing in it, which the read path would then
    -- render as a profile with no reviews and no explanation.
    CONSTRAINT "review_pair_status_matches_contents" CHECK (
        CASE "status"
            WHEN 'PENDING' THEN "host_review_id" IS NULL AND "guest_review_id" IS NULL
            WHEN 'PARTIAL' THEN ("host_review_id" IS NULL) <> ("guest_review_id" IS NULL)
            WHEN 'REVEALED' THEN "host_review_id" IS NOT NULL AND "guest_review_id" IS NOT NULL
            WHEN 'EXPIRED_PARTIAL' THEN ("host_review_id" IS NULL) <> ("guest_review_id" IS NULL)
            WHEN 'EXPIRED_EMPTY' THEN "host_review_id" IS NULL AND "guest_review_id" IS NULL
        END
    ),

    -- A settled pair says when it settled; an unsettled one must not pretend to.
    CONSTRAINT "review_pair_revealed_at_matches_status" CHECK (
        ("status" IN ('PENDING', 'PARTIAL')) = ("revealed_at" IS NULL)
    )
);

-- One pair per participation, for life.
CREATE UNIQUE INDEX "review_pair_participant_id_key" ON "review_pair" ("participant_id");
CREATE UNIQUE INDEX "review_pair_host_review_id_key" ON "review_pair" ("host_review_id");
CREATE UNIQUE INDEX "review_pair_guest_review_id_key" ON "review_pair" ("guest_review_id");

-- The reveal sweep's read: `status IN ('PENDING','PARTIAL') AND deadline_at <=
-- now`. Composite rather than partial: Prisma's `@@index` where-clause supports
-- only equality and `not`, so a two-value `IN` predicate cannot be expressed in
-- the schema — and an index Prisma cannot see is one `migrate dev` would happily
-- drop. Leading on `status` prunes to the pairs still in play, which is what the
-- partial predicate would have done.
CREATE INDEX "review_pair_due_idx" ON "review_pair" ("status", "deadline_at");

ALTER TABLE "review_pair"
    ADD CONSTRAINT "review_pair_participant_id_fkey"
    FOREIGN KEY ("participant_id") REFERENCES "event_participant"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review_pair"
    ADD CONSTRAINT "review_pair_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review_pair"
    ADD CONSTRAINT "review_pair_host_review_id_fkey"
    FOREIGN KEY ("host_review_id") REFERENCES "review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "review_pair"
    ADD CONSTRAINT "review_pair_guest_review_id_fkey"
    FOREIGN KEY ("guest_review_id") REFERENCES "review"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
