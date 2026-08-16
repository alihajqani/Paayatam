-- Migration 0004: events, the blacklist, and moderation cases.
--
-- Hand-written like 0001–0003. The things that cannot be expressed in
-- schema.prisma here are the CHECK constraints on `event` — the cost/amount
-- coupling, the age ordering, the https-only external link (T5.3), and
-- `accepted_count <= capacity`, which is invariant 1 and the reason the whole
-- capacity design works.
--
-- Deliberately NOT in this migration: `search_vector`, its GIN index and the
-- trigram index on the title. They belong to discovery (M5), and the trigger
-- that fills the tsvector reads the `*_normalized` columns added here rather
-- than re-implementing ADR-0012's normalizer in PL/pgSQL.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE "event_status" AS ENUM (
    'DRAFT',
    'PENDING_MODERATION',
    'PUBLISHED',
    'HIDDEN',
    'REJECTED',
    'CANCELLED_BY_HOST',
    'ONGOING',
    'COMPLETED',
    'EXPIRED',
    'DELETED'
);

CREATE TYPE "event_moderation_status" AS ENUM ('PENDING', 'APPROVED', 'FLAGGED', 'REJECTED');
CREATE TYPE "cost_type"               AS ENUM ('FREE', 'APPROX', 'FIXED', 'SPLIT');
CREATE TYPE "gender_preference"       AS ENUM ('MALE_ONLY', 'FEMALE_ONLY');

CREATE TYPE "blacklist_pattern_type" AS ENUM ('EXACT', 'SUBSTRING', 'REGEX');
CREATE TYPE "blacklist_severity"     AS ENUM ('BLOCK', 'FLAG');

CREATE TYPE "moderation_subject_type" AS ENUM ('EVENT', 'USER', 'MESSAGE', 'REVIEW');
CREATE TYPE "moderation_trigger"      AS ENUM ('AUTO_BLACKLIST', 'REPORT_THRESHOLD', 'MANUAL');
CREATE TYPE "moderation_case_status"  AS ENUM ('OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED');

-- ─────────────────────────────────────────────────────────────────────────────
-- event
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "event" (
    "id"                     TEXT                      NOT NULL,
    "public_id"              TEXT                      NOT NULL,
    "host_user_id"           TEXT                      NOT NULL,
    "title"                  TEXT                      NOT NULL,
    "description"            TEXT                      NOT NULL,
    "title_normalized"       TEXT                      NOT NULL,
    "description_normalized" TEXT                      NOT NULL,
    "category_id"            TEXT                      NOT NULL,
    "city_id"                TEXT                      NOT NULL,
    "district_id"            TEXT,
    "starts_at"              TIMESTAMPTZ(3)            NOT NULL,
    "ends_at"                TIMESTAMPTZ(3)            NOT NULL,
    "capacity"               INTEGER                   NOT NULL,
    "accepted_count"         INTEGER                   NOT NULL DEFAULT 0,
    "cost_type"              "cost_type"               NOT NULL,
    "cost_amount"            INTEGER,
    "cost_note"              TEXT,
    "rules"                  TEXT,
    "gender_preference"      "gender_preference",
    "min_age"                INTEGER,
    "max_age"                INTEGER,
    "external_link"          TEXT,
    "status"                 "event_status"            NOT NULL DEFAULT 'DRAFT',
    "moderation_status"      "event_moderation_status" NOT NULL DEFAULT 'PENDING',
    "published_at"           TIMESTAMPTZ(3),
    "boosted_until"          TIMESTAMPTZ(3),
    "is_vip"                 BOOLEAN                   NOT NULL DEFAULT false,
    "view_count"             INTEGER                   NOT NULL DEFAULT 0,
    "request_count"          INTEGER                   NOT NULL DEFAULT 0,
    "version"                INTEGER                   NOT NULL DEFAULT 0,
    "created_at"             TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMPTZ(3)            NOT NULL,
    "deleted_at"             TIMESTAMPTZ(3),

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "event_public_id_key"          ON "event" ("public_id");
CREATE INDEX        "event_status_starts_at_idx"   ON "event" ("status", "starts_at");
CREATE INDEX        "event_host_user_id_created_at_idx" ON "event" ("host_user_id", "created_at");

-- The discovery index (plan §4.3). Its predicate is constants and IS NULL, so it
-- is immutable and Postgres accepts it. M5 adds the GIN and trigram indexes that
-- need the tsvector column.
CREATE INDEX "event_discovery_idx"
    ON "event" ("city_id", "category_id", "starts_at")
    WHERE "status" = 'PUBLISHED' AND "deleted_at" IS NULL;

-- §4.3 asks for a partial index `WHERE boosted_until > now()`. Postgres rejects
-- that: an index predicate must be IMMUTABLE, and `now()` is not — the set of
-- matching rows would change without the index changing. `IS NOT NULL` is the
-- expressible form and prunes just as well, since only boosted events are ever
-- in it. The freshness comparison moves into the query, where it belongs.
CREATE INDEX "event_boosted_idx"
    ON "event" ("boosted_until")
    WHERE "boosted_until" IS NOT NULL;

ALTER TABLE "event"
    ADD CONSTRAINT "event_host_user_id_fkey"
    FOREIGN KEY ("host_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event"
    ADD CONSTRAINT "event_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event"
    ADD CONSTRAINT "event_city_id_fkey"
    FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "event"
    ADD CONSTRAINT "event_district_id_fkey"
    FOREIGN KEY ("district_id") REFERENCES "district"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariant 1, one half of it. The other half is `SELECT … FOR UPDATE` on this
-- row in every path that increments the counter (ADR-0006, M6). The CHECK alone
-- does not prevent overbooking — it turns a lost race into a failed transaction
-- instead of a silently oversold event, which is what makes the lock's absence
-- loud rather than invisible.
ALTER TABLE "event"
    ADD CONSTRAINT "event_accepted_count_within_capacity"
    CHECK ("accepted_count" >= 0 AND "accepted_count" <= "capacity");

ALTER TABLE "event"
    ADD CONSTRAINT "event_capacity_range" CHECK ("capacity" BETWEEN 1 AND 50);

ALTER TABLE "event"
    ADD CONSTRAINT "event_ends_after_starts" CHECK ("ends_at" > "starts_at");

ALTER TABLE "event"
    ADD CONSTRAINT "event_title_length" CHECK (char_length("title") BETWEEN 3 AND 80);

ALTER TABLE "event"
    ADD CONSTRAINT "event_description_length"
    CHECK (char_length("description") BETWEEN 10 AND 2000);

-- A cost that needs a number must have one, and a cost that does not must not.
-- FREE and SPLIT carry no amount: "we'll split it" has no figure yet.
ALTER TABLE "event"
    ADD CONSTRAINT "event_cost_amount_matches_type"
    CHECK (
        ("cost_type" IN ('FIXED', 'APPROX') AND "cost_amount" IS NOT NULL AND "cost_amount" >= 0)
        OR
        ("cost_type" IN ('FREE', 'SPLIT') AND "cost_amount" IS NULL)
    );

-- 18 is the platform floor (plan §4.1); a host may raise it but not lower it.
ALTER TABLE "event"
    ADD CONSTRAINT "event_age_range"
    CHECK (
        ("min_age" IS NULL OR "min_age" >= 18)
        AND ("max_age" IS NULL OR "max_age" >= 18)
        AND ("min_age" IS NULL OR "max_age" IS NULL OR "max_age" >= "min_age")
    );

-- T5.3: the link is stored and displayed, never fetched server-side. https-only
-- is enforced here as well as in the zod contract, because an http:// link in a
-- listing is a downgrade a host should not be able to talk anyone into.
ALTER TABLE "event"
    ADD CONSTRAINT "event_external_link_https"
    CHECK ("external_link" IS NULL OR "external_link" LIKE 'https://%');

-- A published event must record when. Reading `published_at` as "is it live?"
-- is a mistake waiting to happen otherwise.
ALTER TABLE "event"
    ADD CONSTRAINT "event_published_at_present_when_published"
    CHECK ("status" <> 'PUBLISHED' OR "published_at" IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- blacklist_version — what judged a decision, kept so the decision stays
-- explainable after the rules change (ADR-0012)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "blacklist_version" (
    "id"         TEXT           NOT NULL,
    "version"    INTEGER        NOT NULL,
    "note"       TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_version_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blacklist_version_version_key" ON "blacklist_version" ("version");

ALTER TABLE "blacklist_version"
    ADD CONSTRAINT "blacklist_version_positive" CHECK ("version" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- blacklist_term
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "blacklist_term" (
    "term_raw"        TEXT                     NOT NULL,
    "term_normalized" TEXT                     NOT NULL,
    "pattern_type"    "blacklist_pattern_type" NOT NULL,
    "severity"        "blacklist_severity"     NOT NULL,
    "category"        TEXT,
    "is_active"       BOOLEAN                  NOT NULL DEFAULT true,
    "created_by"      TEXT,
    "id"              TEXT                     NOT NULL,
    "created_at"      TIMESTAMPTZ(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ(3)           NOT NULL,

    CONSTRAINT "blacklist_term_pkey" PRIMARY KEY ("id")
);

-- One rule per (term, pattern type). The same word may legitimately exist as
-- both an EXACT and a SUBSTRING rule with different severities; two identical
-- rules are a duplicate that would double-report the same match.
CREATE UNIQUE INDEX "blacklist_term_term_normalized_pattern_type_key"
    ON "blacklist_term" ("term_normalized", "pattern_type");

CREATE INDEX "blacklist_term_is_active_idx" ON "blacklist_term" ("is_active");

ALTER TABLE "blacklist_term"
    ADD CONSTRAINT "blacklist_term_normalized_not_blank"
    CHECK (char_length(btrim("term_normalized")) > 0);

-- A pathological pattern is a denial of service on the event-creation path, and
-- JavaScript has no regex timeout to fall back on. A length cap is a blunt but
-- real limit on how much backtracking a single pattern can express; M12's admin
-- UI must validate patterns before storing them.
ALTER TABLE "blacklist_term"
    ADD CONSTRAINT "blacklist_term_pattern_length"
    CHECK (char_length("term_normalized") <= 200);

-- ─────────────────────────────────────────────────────────────────────────────
-- moderation_case
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "moderation_case" (
    "id"                TEXT                      NOT NULL,
    "subject_type"      "moderation_subject_type" NOT NULL,
    "subject_id"        TEXT                      NOT NULL,
    "trigger"           "moderation_trigger"      NOT NULL,
    "status"            "moderation_case_status"  NOT NULL DEFAULT 'OPEN',
    "assigned_admin_id" TEXT,
    "blacklist_version" INTEGER,
    "matched_terms"     JSONB,
    "report_count"      INTEGER                   NOT NULL DEFAULT 0,
    "decision"          TEXT,
    "decision_note"     TEXT,
    "decided_by"        TEXT,
    "decided_at"        TIMESTAMPTZ(3),
    "false_positive"    BOOLEAN,
    "created_at"        TIMESTAMPTZ(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ(3)            NOT NULL,

    CONSTRAINT "moderation_case_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "moderation_case_status_created_at_idx"
    ON "moderation_case" ("status", "created_at");
CREATE INDEX "moderation_case_subject_type_subject_id_idx"
    ON "moderation_case" ("subject_type", "subject_id");

-- A case the blacklist opened must name the version that opened it, or the
-- decision cannot be explained once the rules move on. MANUAL cases have no
-- version, because no version judged them.
ALTER TABLE "moderation_case"
    ADD CONSTRAINT "moderation_case_auto_records_version"
    CHECK ("trigger" <> 'AUTO_BLACKLIST' OR "blacklist_version" IS NOT NULL);

-- Plan §7: a terminal state requires an accountable human.
ALTER TABLE "moderation_case"
    ADD CONSTRAINT "moderation_case_terminal_requires_decider"
    CHECK (
        "status" NOT IN ('APPROVED', 'REJECTED')
        OR ("decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_note" IS NOT NULL)
    );
