# ADR-0002: PostgreSQL 16 + Prisma (not MongoDB/Mongoose)

- **Status:** Accepted (2026-08-15)
- **Decides:** D1 (persistence)

## Context

The existing Telegram bots in this workspace (`ngls-bot`, `new_ngsl_bot`) use MongoDB via Mongoose, so
continuing with it would be the path of least resistance and would match house convention.

However, PayeTam's core requirements are explicitly relational and explicitly transactional:

- **No overbooking.** Requires either a row lock or an atomic conditional update, plus a durable constraint
  as a backstop.
- **A coin ledger that can never double-grant and never go negative.** Requires unique constraints, check
  constraints and multi-row transactions.
- **"Cannot request twice", "cannot report twice", "cannot review twice".** Each is a composite unique
  constraint.
- **Persian full-text search with filters and sorting.**
- **Append-only audit and ledger tables.**

## Decision

**PostgreSQL 16 as the only datastore of record; Prisma as the ORM and migration tool. Redis is a cache and
queue substrate only — never a source of truth.**

Specific features relied upon:

| Requirement | Postgres feature |
|---|---|
| No overbooking | `SELECT … FOR UPDATE` + `CHECK (accepted_count <= capacity)` |
| Ledger integrity | `UNIQUE(idempotency_key)`, `CHECK (balance >= 0)`, `BEFORE UPDATE OR DELETE` trigger raising on mutation |
| Duplicate guards | Composite `UNIQUE` constraints |
| Persian search | `tsvector` + GIN, `pg_trgm` for fuzzy title match, `unaccent` |
| Audit / chat growth | Declarative monthly partitioning |
| Correct money | `INTEGER` Toman — never a float |
| Type safety | Native enums mapped to TypeScript union types by Prisma |

## Consequences

**Positive**
- The critical invariants live in the database. A future bug in application code — or a second writer such as
  an admin script — still cannot overbook an event or produce a negative balance.
- Prisma's generated types make illegal states hard to express in TypeScript, and `prisma migrate` gives
  reviewable, ordered, rollback-documented SQL.
- `$transaction` with an explicit isolation level gives one obvious place to reason about concurrency.

**Negative**
- Diverges from the workspace's Mongoose convention; a small ramp-up cost.
- Prisma's interactive transactions have a default timeout (5 s) that must be raised deliberately for the
  few long transactions. Documented in `packages/db`.
- Prisma does not express partition management, triggers or partial indexes; these go into hand-written SQL
  inside generated migration files, which must be reviewed rather than trusted.
- Raw SQL is required for keyset pagination with ranking. Restricted to tagged `$queryRaw` templates, with a
  CI grep forbidding string-concatenated SQL.

## Alternatives considered

- **MongoDB + Mongoose.** Rejected. Multi-document transactions exist but require a replica set, and the
  spec's guarantees (`balance >= 0`, `accepted_count <= capacity`, append-only ledgers, composite uniqueness
  across concurrent writers) would all become application-level conventions. For a system that moves a
  currency and allocates scarce seats, that is the wrong trade.
- **Drizzle instead of Prisma.** Genuinely close. Drizzle is SQL-first and lighter. Prisma wins here on
  migration ergonomics and on generated types across a 35-table schema shared by four workspace packages.
- **TypeORM.** Rejected: weaker type inference, historically fragile migration generation.
- **Redis as a source of truth for capacity counters.** Rejected. Fast, but a Redis failure or eviction
  becomes an overbooked event with no durable record to reconcile against.
