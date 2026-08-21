# Architecture Decision Records

Each ADR records one decision, why it was made, what it costs, and what was rejected. They are the anchor for
future sessions: **read these before changing architecture, and add a new ADR rather than editing an accepted
one.** Superseding is done by writing a new record that says so.

| ADR | Decision | Frozen decisions | Invariant it owns |
|---|---|---|---|
| [0001](0001-modular-monolith-and-deployment.md) | Modular monolith, two processes, single foreign VPS | D1, D6 | — |
| [0002](0002-postgresql-and-prisma.md) | PostgreSQL 16 + Prisma, not MongoDB | D1 | Constraints live in the database |
| [0003](0003-vue-frontend-and-telegram-design-system.md) | Vue 3 frontends; Telegram Native Design System | D2, D3 | No hardcoded colour in the Mini App |
| [0004](0004-telegram-webhook-and-miniapp-auth.md) | Webhook mode; `initData` → JWT with replay defence | — | `initData` is never trusted twice |
| [0005](0005-transactional-outbox-and-jobs.md) | Transactional outbox + BullMQ | — | State changed ⇒ notification sent |
| [0006](0006-capacity-locking.md) | Pessimistic row locking for capacity | — | `accepted_count <= capacity` |
| [0007](0007-append-only-ledgers.md) | Append-only coin and trust ledgers | — | `balance >= 0`; ledgers immutable |
| [0008](0008-time-handling.md) | UTC storage, `Asia/Tehran` policy, server clock only | D12 | No client time affects policy |
| [0009](0009-privacy-anonymity-and-retention.md) | Anonymity boundary, chat encryption, retention, minimisation | D4, D5, D10 | `telegram_user_id` never leaves `identity` |
| [0010](0010-admin-auth-rbac-and-break-glass.md) | Separate admin identity, RBAC, break-glass chat access | D11 | Deny by default; everything audited |
| [0011](0011-review-waitlist-and-cancellation-policy.md) | Blind reviews, waitlist promotion, host cancellation | D7, D8, D9 | No review readable before reveal |
| [0012](0012-persian-normalization-and-search.md) | One Persian normalization pipeline for moderation + search | — | Moderation and search normalise identically |
| [0013](0013-typescript-build-and-dev-loop.md) | TypeScript 5.9.3, `tsc -b` project references, no `tsx` for Nest apps | — | Dev and prod run identical compiler output |
| [0014](0014-conversation-titles-and-reputation-display.md) | Conversations titled «who — which event»; Trust Score shown to the counterparty | — | — (amends ADR-0009 layer 3) |
| [0015](0015-gift-codes.md) | Gift codes as a sibling of the referral, over the one coin ledger | — | — (bound by 2, 3, 12) |

## The twelve invariants

Collected from the ADRs above. Violating any of these is a bug regardless of what a test says:

1. `accepted_count <= capacity` — DB CHECK **and** row lock (ADR-0006).
2. `coin_account.balance >= 0` — DB CHECK (ADR-0007).
3. Both ledgers are append-only — trigger-enforced (ADR-0007).
4. One `event_participant` per `(event_id, user_id)` — DB UNIQUE (ADR-0006).
5. One `report` per `(target, reporter)` — DB UNIQUE.
6. One `review` per `(participant_id, reviewer)` — DB UNIQUE.
7. `telegram_user_id` never appears in an API response, a log line, or a frontend bundle (ADR-0009).
8. No review is readable by the counterparty before reveal — enforced at the **API layer** (ADR-0011).
9. All time comparisons use the server clock; no endpoint accepts a client timestamp for policy (ADR-0008).
10. Every state transition goes through `assertTransition()` and writes `audit_log`.
11. Every outbound Telegram call goes through the `telegram-send` queue, never inline (ADR-0005).
12. Every mutating admin action is authorised **in the service layer** and audited (ADR-0010).

## Template for new ADRs

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Decides:** which frozen decision(s), if any
- **Invariant owned:** if it introduces one

## Context
What forces this decision. What breaks if we get it wrong.

## Decision
What we are doing, concretely enough to implement.

## Consequences
**Positive** / **Negative** — including what we are accepting, not just what we gain.

## Alternatives considered
What was rejected and why. Include the ones that were genuinely close.
```
