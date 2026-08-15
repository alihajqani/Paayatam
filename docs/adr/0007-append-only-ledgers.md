# ADR-0007: Append-only ledgers for coins and Trust Score

- **Status:** Accepted (2026-08-15)
- **Decides:** Coin accounting, Trust Score accounting and explainability
- **Invariants owned:** `balance >= 0`; ledgers are immutable; score is always explainable

## Context

Coins are an in-app currency. Users earn them (onboarding, referrals, reviews) and spend them (boost, VIP),
and the system takes them away as cancellation penalties. Trust Score is a 0–100 reputation number driven by
attendance, reviews, cancellations and moderation.

A mutable `balance` column on a user row is the obvious implementation and is wrong in ways that surface
only after real users are affected:

- A double-processed reward silently inflates the balance with no record of what happened.
- A penalty applied twice cannot be distinguished from two legitimate penalties.
- A user disputing "where did my coins go?" cannot be answered.
- An admin adjustment leaves no trace of who did it or why.
- A negative balance from a race is unrecoverable, because the history needed to reconstruct the truth was
  never written.

The same argument applies to Trust Score, with an added requirement from the spec: the algorithm must be
**versioned, configurable, manipulation-resistant, and explainable to admins**. A bare integer explains
nothing.

## Decision

**Both coins and Trust Score use an append-only ledger as the source of truth. The current value is a cache
that must always equal the sum of its ledger.**

### Schema

- `coin_ledger` — `user_id`, **`idempotency_key` UNIQUE**, `type`, `amount` (signed, ≠ 0), `balance_before`,
  `balance_after`, `reason_code`, `actor_type` (SYSTEM / USER / ADMIN), `actor_id`, `ref_type`, `ref_id`,
  `reverses_ledger_id`, `metadata`, `created_at`.
- `coin_account` — `user_id` PK, `balance` with **`CHECK (balance >= 0)`**, `version`.
- `trust_score_ledger` — the same shape with `delta`, `score_before`, `score_after`, `algo_version`.
- `trust_score` — `user_id` PK, `score` with `CHECK (score BETWEEN 0 AND 100)`, `algo_version`.

### Rules

1. **Immutability is enforced by the database.** A `BEFORE UPDATE OR DELETE` trigger on both ledgers raises
   an exception. Not a convention, not a code review item — a trigger.
2. **Idempotency is enforced by the database.** Every write supplies an `idempotency_key`
   (`onboarding:{userId}`, `cancel-penalty:{participantId}`, `referral:{referralId}`). A retry, a duplicated
   job or a double-clicked button collides on the unique index and is a no-op. **This is what makes the
   onboarding reward grantable exactly once, even under concurrent requests.**
3. **Account and ledger move together**, in one transaction, always through `CoinService` / `TrustService`.
   No other code touches `coin_account.balance`.
4. **Corrections are new rows.** A mistake produces a `REVERSAL` entry pointing at the original via
   `reverses_ledger_id`. Nothing is ever edited or deleted, so history is complete by construction.
5. **Reconciliation is testable.** `balance == SUM(amount)` and `score == clamp(SUM(delta))` are asserted by
   a test that performs 1000 randomised operations and then checks both.
6. **Trust is explainable.** The admin panel renders the *ledger*, not the number: every delta carries a
   `reason_code`, a human-readable Persian reason, and the `algo_version` that produced it. "Why is my score
   47?" has a complete, auditable answer.
7. **Nothing is permanent.** A rehabilitation rule (+1 per 30 clean days, toward 50) prevents a single bad
   period from permanently condemning an account — a direct requirement of the spec.

## Consequences

**Positive**
- Every coin and every point of reputation is traceable to an actor, a reason and a source event.
- Double-grants and double-penalties are structurally impossible, not merely unlikely.
- Disputes and abuse investigations are answerable from data.
- Policy numbers live in `app_setting`, so tuning penalties is a config change with no deploy — and past
  entries retain the values that were actually applied.

**Negative**
- Two writes per economic operation instead of one. Irrelevant at this scale.
- The ledger grows monotonically. At MVP volume this is megabytes per year; partition if it ever matters.
- `balance_before` / `balance_after` are denormalized and could theoretically drift. That is precisely what
  the reconciliation test exists to catch, and it runs in CI.
- Developers must never write `UPDATE coin_account` directly. The trigger catches the ledger half; a code
  review rule and a single-owner service cover the rest.

## Alternatives considered

- **Mutable balance column.** Rejected for every reason above.
- **Event sourcing the whole domain.** Rejected as disproportionate. The ledger pattern gives the auditability
  benefit exactly where value moves, without imposing projections and replay on the entire codebase.
- **Computing the balance on read (`SUM` with no cache).** Correct, and appealing for its single source of
  truth. Rejected because the balance is read on nearly every screen; the cached column plus a CI
  reconciliation test gives the same guarantee at O(1).
- **Storing Trust Score only, recomputing history on demand.** Rejected: it makes the score unexplainable and
  makes algorithm changes silently rewrite users' pasts.
