# ADR-0006: Pessimistic row locking for capacity control

- **Status:** Accepted (2026-08-15)
- **Decides:** Overbooking prevention, waitlist promotion safety
- **Invariant owned:** `accepted_count <= capacity`, always

## Context

An event has `capacity` seats. Five operations change how many are taken: **join**, **accept**, **reject**,
**cancel** (participant or host), and **waitlist promotion**. Several can run concurrently — a popular event
posted to the channel will receive simultaneous joins, and a cancellation can race a promotion sweep.

The failure modes are concrete and unacceptable:

- Two accepts for the last seat ⇒ 6 people show up for 5 seats.
- Two simultaneous cancellations ⇒ the same waitlisted person promoted twice, or two people promoted into one
  seat.
- Read-then-write on `accepted_count` ⇒ a classic lost update.

This is the single most important correctness property in the product. It is also the one most likely to be
silently broken by a future change.

## Decision

**Every operation that can change `accepted_count` first takes a pessimistic lock on the event row, and
holds no other lock while doing so. A database `CHECK` constraint is the independent backstop.**

```sql
-- Step 1 of every capacity-affecting operation, without exception:
SELECT * FROM event WHERE id = $1 FOR UPDATE;
```

```ts
await prisma.$transaction(async (tx) => {
  const [event] = await tx.$queryRaw`SELECT * FROM event WHERE id = ${id} FOR UPDATE`;
  assertJoinable(event);
  // … participant insert / status change / accepted_count update …
}, { isolationLevel: 'ReadCommitted' });
```

Three rules make this safe and keep it safe:

1. **Lock first.** The event row lock is acquired before any other row is touched in that transaction.
2. **Lock only.** No second lock is taken while holding it. Single-resource ordering ⇒ deadlock-free by
   construction.
3. **Backstop.** `CHECK (accepted_count <= capacity)` on the table. If a future code path forgets the lock,
   the database rejects the write rather than overbooking. The constraint turns a silent data corruption
   into a loud 500.

Duplicate requests are prevented by the schema, not by a check:

```sql
UNIQUE (event_id, user_id)
-- used as: INSERT … ON CONFLICT (event_id, user_id) DO NOTHING  → 0 rows ⇒ 409
```

A read-then-write "does a request already exist?" check would have a race window between the read and the
insert. The unique constraint has none.

Waitlist order is derived, never stored: `ORDER BY (requested_at, id)` over
`status = 'WAITLISTED'`, backed by a partial index. Because promotion happens under the same event lock, two
concurrent cancellations serialise and promote two **different** people.

## Consequences

**Positive**
- Overbooking is impossible under any interleaving, and provably so — the test is 20 concurrent joins on
  capacity 5, run 50 times against real Postgres.
- Reasoning is local: one lock, taken first, held briefly.
- The `CHECK` constraint protects against future code that forgets the rule, including admin scripts and
  manual SQL.

**Negative**
- Joins to the same event serialise. Measured cost is a lock held for well under 5 ms; at hundreds of
  concurrent joins on one event this becomes a queue, which is the correct behaviour for allocating scarce
  seats.
- Long transactions are dangerous while holding the lock. Enforced rule: **no network calls — no Telegram
  API, no HTTP, no file I/O — inside a capacity transaction.** Notifications go through the outbox
  (ADR-0005), which is a local insert.
- Requires raw SQL, since Prisma has no first-class `FOR UPDATE`. Confined to a single documented helper,
  `lockEventForUpdate(tx, id)`, which every capacity path calls.

## Alternatives considered

- **Optimistic locking (version column, retry on conflict).** Rejected as the primary mechanism. Under a
  posting burst the retry storm is worse than a short lock, and correctness depends on every caller
  implementing retry properly. A `version` column exists on `event` anyway for *edit* conflicts, which is a
  different problem with a different UX (tell the user their view is stale).
- **Atomic conditional update** (`UPDATE … SET accepted_count = accepted_count + 1 WHERE accepted_count <
  capacity`). Correct for the counter in isolation and genuinely elegant. Rejected because acceptance also
  inserts a participant, transitions a chat and writes an outbox row — those must be atomic with the counter,
  which returns us to a transaction. The conditional-update idea survives as the `CHECK` constraint.
- **Redis counter / distributed lock.** Rejected: a Redis eviction or failover turns into an overbooked
  event with no durable record. Capacity is a correctness property, not a caching problem.
- **`SERIALIZABLE` isolation.** Rejected: pushes the burden onto serialisation-failure retry logic at every
  call site for no gain over an explicit, obvious row lock.
