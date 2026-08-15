# ADR-0005: Transactional outbox and BullMQ job strategy

- **Status:** Accepted (2026-08-15)
- **Decides:** Notification reliability, background job execution

## Context

Almost every state change in PayeTam must produce a Telegram notification: a join request notifies the host,
an acceptance notifies the participant, a waitlist promotion notifies **both** parties (D8), a cancellation
notifies everyone affected.

The naive implementation is a dual write:

```ts
await prisma.$transaction(...)   // commit the state change
await queue.add('notify', ...)   // then enqueue the notification
```

This is wrong in both directions:
- Crash **between** the two lines ⇒ the state changed and nobody was ever told. A host never learns someone
  wants to join. Silent, permanent, and invisible in logs.
- Enqueue **before** commit, and a rollback ⇒ a notification about something that never happened.

Additionally, Telegram enforces roughly 30 messages/second globally and 1/second per chat. Notifications must
be paced, retried on `429`, and abandoned on `403` (bot blocked).

## Decision

**A transactional outbox plus BullMQ, with idempotency enforced at two independent layers.**

### Outbox

Domain events are `INSERT`ed into `outbox_event` **inside the same transaction** as the state change. A relay
in the worker polls unprocessed rows (1 s, with a `LISTEN/NOTIFY` fast path and a 5-minute backstop sweep),
enqueues them to BullMQ, and marks them processed.

The outbox row commits atomically with the state change, so:
- a crash before the relay runs ⇒ the row is still there, delivered on restart;
- a rolled-back transaction ⇒ no row, no notification.

### Queues

| Queue | Purpose | Concurrency | Limiter |
|---|---|---|---|
| `telegram-send` | every outbound Telegram call | 5 | 25/s global, 1/s per chat key |
| `domain-events` | outbox fan-out → notifications, trust, channel | 10 | — |
| `scheduled` | repeatable cron jobs | 2 | — |
| `moderation` | re-scan on blacklist version bump | 2 | — |

The global limiter is set to 25/s, below Telegram's ~30/s, to leave headroom for interactive replies.

### Idempotency at two layers

1. **BullMQ `jobId`** is deterministic — `notify:participant:{id}:accepted`. Re-adding an existing id is a
   no-op.
2. **`notification.dedupe_key` is UNIQUE** in Postgres. Even if the queue is flushed, replayed or migrated,
   the insert fails and delivery is skipped.

Either layer alone would be sufficient in most failure modes. Both are cheap, and they fail independently.

### Retries and dead-lettering

5 attempts, exponential backoff 5 s → 80 s, `removeOnFail: false`.
- Telegram `429` ⇒ honour `retry_after` via `@grammyjs/auto-retry`.
- Telegram `403` (bot blocked) ⇒ set `telegram_account.bot_blocked = true` and **stop retrying**. Retrying a
  block wastes the global rate budget that other users' notifications need.
- Exhausted ⇒ a row in `job_failure` with payload and error, visible in the admin panel and re-drivable.

### Scheduled jobs

All repeatable, all idempotent, all on the server clock: event lifecycle (1 min) · pending-request expiry
(1 min) · waitlist promotion sweep (5 min) · outbox backstop (5 min) · review reminders and reveal (hourly) ·
no-show finalisation (daily 03:00) · retention purge (daily 04:00) · trust rehabilitation (daily 05:00).

The promotion sweep exists **in addition to** the event-driven promotion path. The event-driven path is the
fast one; the sweep is the backstop that guarantees a seat freed during an outage is eventually filled.

## Consequences

**Positive**
- "State changed ⇒ notification sent" survives process crashes at any point.
- Telegram rate limits are absorbed by a queue instead of by request latency.
- Every failed job is a durable, inspectable row rather than a lost log line.

**Negative**
- Notifications are eventually consistent — typically sub-second, but not synchronous. The API therefore
  never tells a user "the host has been notified"; it says the request was registered.
- The outbox table needs its own retention policy (processed rows pruned daily) or it grows forever.
- Redis becomes required infrastructure. Its failure pauses delivery, but **loses nothing**: the outbox is
  in Postgres, so delivery resumes on recovery. This is the main reason the outbox is worth its complexity.

## Alternatives considered

- **Direct dual write.** Rejected — loses notifications on crash, as described above.
- **Postgres `LISTEN/NOTIFY` alone, no queue.** Rejected: no retries, no backoff, no rate limiting, no DLQ,
  and notifications are dropped if no listener is connected.
- **`pg-boss` (queue inside Postgres).** Genuinely attractive: it removes Redis and makes enqueue truly
  atomic with the state change, eliminating the relay. Rejected because Redis is already required for
  sessions, caching and rate limiting, and BullMQ's rate-limiter and repeatable-job support are a better fit
  for the Telegram constraint. Worth revisiting if Redis is ever dropped.
- **Sending inline and accepting occasional loss.** Rejected. In a marketplace, a lost "someone wants to
  join" notification is a lost transaction and an invisible failure.
