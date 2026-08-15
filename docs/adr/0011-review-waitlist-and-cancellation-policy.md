# ADR-0011: Blind reviews, waitlist promotion, and host cancellation policy

- **Status:** Accepted (2026-08-15)
- **Decides:** D7/D7a (blind reviews), D8 (waitlist promotion), D9/D9a (host cancellation)
- **Source:** user decisions supplied with plan approval, resolving open questions Q1–Q3

## Context

Three product policies were left open by the business specification. Each has a mechanical consequence in
the schema and the state machines, so each needed resolution before implementation.

---

## Decision 1 — Reviews are strictly blind (D7)

**Neither party may see the other's review while writing their own.** A review is revealed only when:

- **both** parties have submitted, **or**
- the review window deadline passes.

**Purpose: preventing retaliatory ratings.** If A can see B's 2-star review before submitting, A's rating
becomes a reaction rather than an assessment, and the whole reputation signal degrades into reciprocal
score-trading.

### Implementation

- `review_pair` holds both sides plus `opens_at` (event end + 24 h) and `deadline_at` (+7 d).
- **Enforcement is at the API layer, not the UI.** `GET /users/:publicId/reviews` filters on
  `review.status = 'REVEALED'`; the counterparty's unrevealed review is never serialised, so it is not merely
  hidden in the interface — it is absent from the response. A test asserts this at the HTTP layer.
- Editing is permitted only while `SUBMITTED` and before `edit_deadline_at` (1 h), never after reveal.
- `UNIQUE (participant_id, reviewer_user_id)` prevents duplicates in the database.

### D7a — one-sided at deadline (sub-decision, flagged for override)

If the deadline passes with only one review submitted, that review **is revealed**, marked
`EXPIRED_PARTIAL` («بدون بازخورد متقابل»), and **excluded from Trust Score**.

Rationale: the reviewer's effort stays visible to future users, but someone who never reviewed cannot have
their score moved by a counterparty they had no opportunity to answer. Override by setting
`review.partial_reveal_affects_trust` in `app_setting`.

---

## Decision 2 — Waitlist promotion notifies both parties (D8)

When an accepted participant cancels, the next waitlisted user (FIFO by `requested_at, id`) is promoted
`WAITLISTED → PENDING`, and the **host** decides within `min(12h, event−3h)`.

**Both parties are notified immediately via the Telegram Bot:**

- the **promoted participant** — "a seat opened up, your request is now awaiting the host's decision";
- the **host** — "a waitlisted request has been promoted and needs your decision", with the deadline stated.

Notifying only the host would leave the promoted user unaware that their status changed, which is precisely
the moment they need to know.

### Implementation

- Promotion happens **under the same event row lock** as every other capacity operation (ADR-0006), so two
  concurrent cancellations promote two **different** people — asserted by test.
- Both notifications go through the transactional outbox (ADR-0005), so a crash mid-promotion cannot deliver
  one and lose the other.
- The promotion job is idempotent: a retry re-notifying is suppressed by `notification.dedupe_key`.
- A 5-minute sweep backstops the event-driven path so a seat freed during an outage is still filled.

Participant re-confirmation before host review (the Q2 option (b) design) is **deferred to v1.1**: it is the
better product but costs an extra state, an extra deadline and an extra notification path.

---

## Decision 3 — Host cancellation is symmetrical, ×1.5, with full refund (D9)

A host cancelling a published event with accepted participants incurs:

- the **same time thresholds** as participants,
- a **×1.5 coin penalty** multiplier,
- Trust **−5** (>24 h) or **−12** (<24 h),
- **100% automatic coin refund** to all accepted participants,
- immediate notification to every accepted and waitlisted participant,
- closure of all associated anonymous chats.

Rationale: symmetry is defensible to users, and the multiplier reflects that one host cancellation harms N
people rather than one. Without any host penalty the marketplace fills with phantom events; the multiplier is
capped by configuration so it can be tuned once real behaviour is observed.

### D9a — the refund is currently a no-op (stated, not hidden)

**In the MVP, joining an event costs a participant zero coins.** There is therefore nothing to refund today.

The mechanism is implemented generically — reverse every `coin_ledger` row where
`ref_type = 'event_participant'` and `ref_id` belongs to this event's participants, producing `REVERSAL`
entries (ADR-0007) — and is tested with a synthetic participant-side charge. It becomes live automatically
the moment any participant-side coin cost is introduced.

This is a genuine gap between the policy as written and what it does today. It is recorded here rather than
silently shipped as a no-op, so that nobody later mistakes "the refund code ran" for "coins were returned".

---

## Consequences

**Positive**
- Retaliatory rating is structurally prevented, not merely discouraged.
- The promoted participant is never left guessing about their status.
- Hosts carry real accountability for cancellations, with the numbers tunable at runtime.

**Negative**
- Blind reviews mean a user cannot respond to an unfair review before it is published. Mitigated by review
  reporting and moderation (M12).
- The ×1.5 host multiplier could discourage hosting if set too high. It lives in `app_setting`, so it can be
  lowered without a deploy if hosting volume drops.
- D9a means a documented feature is inert until participant-side costs exist. Explicitly flagged in the
  implementation plan (§12.9) and in this ADR.

## Configuration

All values live in `app_setting`: `review.window_opens_hours` (24), `review.window_deadline_days` (7),
`review.edit_window_minutes` (60), `review.partial_reveal_affects_trust` (false),
`waitlist.promotion_deadline_hours` (12), `waitlist.min_hours_before_event` (3),
`cancellation.host_penalty_multiplier` (1.5), `cancellation.host_trust_gt24h` (−5),
`cancellation.host_trust_lt24h` (−12).
