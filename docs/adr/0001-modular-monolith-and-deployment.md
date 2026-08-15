# ADR-0001: Modular monolith, two processes, single VPS

- **Status:** Accepted (2026-08-15)
- **Decides:** D1 (runtime shape), D6 (hosting)
- **Supersedes:** —

## Context

PayeTam has 14 domain areas (identity, events, participation, chat, economy, reviews, moderation, …) and a
small team. The spec demands transactional guarantees that span several of those areas at once:

- Accepting a participant mutates `event_participant`, `event.accepted_count` and `anonymous_chat` — and must
  be atomic with respect to a concurrent join.
- Cancelling mutates participation, the coin ledger, the trust ledger and the waitlist — atomically.
- Onboarding writes a user, a consent and a coin ledger entry — atomically, exactly once.

These are one consistency domain, not several.

Separately, an HTTP request must never block on the Telegram Bot API. Telegram enforces roughly 30 messages
per second globally and 1 per second per chat. A burst of waitlist promotions issuing inline `sendMessage`
calls would stall request handling and breach the rate limit at the same time.

## Decision

**A modular monolith in TypeScript, deployed as two runtime processes plus two static SPAs on a single
foreign VPS running Docker Compose.**

1. `packages/domain` holds all business logic as framework-agnostic services. It imports no HTTP framework
   and no grammY.
2. `apps/api` (NestJS) exposes the Mini App API, the Admin API and the Telegram webhook receiver. Stateless.
3. `apps/worker` (NestJS standalone) hosts all BullMQ processors. Every outbound Telegram call happens here.
4. `apps/miniapp` and `apps/admin` are static bundles served by nginx.
5. Both `api` and `worker` import the **same** `packages/domain` services.

Deployment target is a single VPS outside Iran (Hetzner/Contabo class, 4 vCPU / 8 GB), because
`api.telegram.org` is unreachable from Iranian IP ranges and Iranian Telegram users already tunnel their
traffic to reach Telegram at all.

## Consequences

**Positive**
- One database, one transaction manager. Every cross-module invariant is enforceable with a plain
  `BEGIN … COMMIT` instead of a saga.
- Because controllers and job processors are thin adapters over the same services, "the bot and the Mini App
  behave identically" is true **by construction**, not by discipline. A bug fixed in one is fixed in both.
- The rate-limit-sensitive work is isolated in a process that can be paused, drained and scaled independently.
- One VPS, one Compose file. Operable by one engineer.

**Negative**
- Module boundaries are conventions, not network boundaries. They can rot. Mitigated by ESLint
  `no-restricted-imports` rules that forbid cross-module imports except through each module's public index,
  and by forbidding HTTP/grammY imports inside `packages/domain`.
- The whole application scales as a unit. Acceptable: at MVP volume a 4 vCPU box is roughly two orders of
  magnitude oversized.
- A single VPS is a single point of failure. Accepted for MVP; mitigated by nightly off-box encrypted
  backups and a rehearsed restore drill (M16), not by redundancy.

**Risk explicitly accepted:** foreign IP reachability from Iranian devices for the Mini App WebView can vary.
If reachability proves poor in practice, the mitigation is to front the Mini App domain with a CDN — a DNS
change, not an architecture change.

## Alternatives considered

- **Microservices.** Rejected. Every meaningful invariant in this product spans services, which converts
  `SELECT … FOR UPDATE` into a distributed saga with compensating transactions. That is a large amount of
  new failure modes bought for scaling headroom this product will not need for years.
- **Single process (API serves the queue in-process).** Rejected. Telegram's rate limits then apply pressure
  directly to request latency, and a slow Telegram API degrades the Mini App.
- **Serverless.** Rejected. Long-lived Telegram webhook handling, BullMQ workers, persistent Postgres
  connections and a fixed low budget all argue against it.
- **Hosting inside Iran.** Rejected as the default because it makes every outbound Telegram call depend on a
  proxy, which becomes a single point of failure on the product's most critical path. Reconsider only if
  Mini App reachability data says otherwise.
