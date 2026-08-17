-- Migration 0016: stored responses for replayed `Idempotency-Key` requests.
--
-- Plan §6 says "Mutating endpoints accept `Idempotency-Key`; replay returns the
-- stored response with `Idempotency-Replayed: true`", and acceptance criterion 21
-- tests it. Neither existed; the Launch Readiness Report carries it as blocker B3.
--
-- **Why a table rather than a unique index.** Every other duplicate path in this
-- product is already defended in the database by a unique index on a natural key —
-- one participation per (event, user), one review per (participation, reviewer), one
-- report per (target, reporter). That is why criteria 17–20 pass without any of
-- this. Boost is the exception, and M9 stated the reason precisely: a second boost
-- is a second purchase of a second window, which is a thing a host may legitimately
-- want, so the service cannot tell "asked twice" from "arrived twice". Only the
-- client can, by naming the intention — which is what a key is.
--
-- **Scoped to the user.** A key is chosen by a client and is not globally unique;
-- keying on it alone would let one caller's UUID collide with another's, and the
-- failure mode of that is handing somebody else's stored response to the wrong user.
--
-- `request_fingerprint` is what keeps a replay honest. The same key with a different
-- body is a client bug, and answering it with the first response would compound the
-- bug rather than report it — so that case is a conflict, not a replay.
--
-- Only successful responses are stored (see the interceptor): a failed request has
-- to stay retryable, or one network blip would pin a user to an error for the life
-- of the row.
--
-- `response_body` is TEXT rather than JSONB, and that is the difference between
-- meeting criterion 21 and nearly meeting it. JSONB does not preserve key order, so
-- a replay served from it is *semantically* equal and byte-different. Storing the
-- exact serialized response and parsing it back on the way out preserves insertion
-- order, which makes "identical stored response" literally true rather than true
-- enough that nobody would notice.

CREATE TABLE "request_idempotency" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" VARCHAR(10) NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "request_fingerprint" VARCHAR(64) NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "request_idempotency_pkey" PRIMARY KEY ("id")
);

-- The claim. Two concurrent requests carrying one key race to insert here, and
-- exactly one wins — which is what makes the double-tap safe rather than merely
-- unlikely.
CREATE UNIQUE INDEX "request_idempotency_user_id_key_key"
    ON "request_idempotency" ("user_id", "key");

-- For the retention sweep, which deletes by expiry.
CREATE INDEX "request_idempotency_expires_at_idx"
    ON "request_idempotency" ("expires_at");

ALTER TABLE "request_idempotency"
    ADD CONSTRAINT "request_idempotency_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
