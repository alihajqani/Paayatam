# ADR-0008: Time handling — UTC storage, Asia/Tehran policy, server clock only

- **Status:** Accepted (2026-08-15)
- **Decides:** D12 (timezone)
- **Invariant owned:** no policy decision ever depends on a client-supplied time

## Context

Time drives money in this product. The cancellation policy has four thresholds:

| Window | Consequence |
|---|---|
| ≤ 15 min after acceptance (grace) | no penalty |
| > 24 h before start | none / minimal |
| 24 h → 3 h before start | coin deduction + small trust loss |
| < 3 h before start, or no-show | large coin penalty + large trust loss + profile warning |

A user who can influence which bucket applies can avoid a 60-coin penalty. So the threshold computation is a
security boundary, not a formatting concern.

Iranian specifics: `Asia/Tehran` is **UTC+03:30** and **abolished DST in 2022**, so there are currently no
transitions. Relying on that is still wrong — the offset is a policy decision by a government, not a
constant — so IANA tz data is used rather than a hardcoded `+03:30`. The half-hour offset itself is a
frequent source of off-by-one-bucket bugs.

Users also read dates in the **Jalali (Persian) calendar**, which is a presentation concern that must not
leak into storage.

## Decision

1. **Storage is UTC.** Every timestamp column is `timestamptz`. The database session runs with `TimeZone=UTC`.
   No `timestamp without time zone` anywhere.
2. **Policy is computed on the server clock, from stored UTC values.** No endpoint accepts a client timestamp
   for any policy purpose. `POST /participants/:id/cancel` takes **no time parameter at all** — the only way
   to influence the outcome is to actually cancel at a different time.
3. **The clock is injectable.** All domain code takes a `Clock` interface (`now(): Date`) rather than calling
   `new Date()`. Production supplies a system clock; tests supply a fake one. This is what makes exhaustive
   threshold testing possible without sleeping.
4. **`Asia/Tehran` is the business timezone**, resolved through IANA tz data (`date-fns-tz`), used for:
   - deciding which calendar day a "daily" job or quota belongs to,
   - rendering times to users,
   - interpreting a host's chosen local start time when creating an event.
5. **Jalali is presentation only.** Conversion happens in the Vue layer. No Jalali date is ever stored,
   compared or transmitted — the API speaks ISO-8601 UTC exclusively.
6. **Persian digits are presentation only.** Rendered by a view-layer formatter; all internal values stay
   Latin so sorting and arithmetic are unaffected.

## Consequences

**Positive**
- Client clock manipulation cannot change a penalty. The attack surface is removed rather than validated.
- A future DST reinstatement, or any offset change, is an IANA data update rather than a code change.
- The injectable clock makes the M10 threshold table exhaustive and fast: grace boundary, 25 h, 23 h,
  3 h 01 m, 2 h 59 m, no-show — each asserting exact coin and trust deltas, with no sleeping in tests.

**Negative**
- Every developer must remember that display and storage differ. Mitigated by the API only ever emitting
  ISO-8601 UTC, so the conversion has exactly one home in each frontend.
- The half-hour offset makes boundary bugs easy to write and hard to see. Mitigated by explicit boundary
  tests: an event at 00:30 Tehran cancelled at 21:35 UTC the previous day must land in the correct bucket.
- Event creation must be careful: a host picks a *local* time, which is converted to UTC on submit. The
  Mini App sends ISO-8601 with an explicit offset; the server does not guess.

## Alternatives considered

- **Storing local time plus a timezone name.** Rejected: every comparison then needs conversion, and
  cross-timezone sorting becomes error-prone.
- **Hardcoding UTC+03:30.** Rejected. Correct today, silently wrong the day the policy changes — and it would
  fail without any error, which is the worst failure mode.
- **Trusting a client-supplied timestamp for cancellation.** Rejected: it is the exact attack this ADR
  exists to prevent.
- **Storing Jalali dates.** Rejected: no database-native support, no correct range queries, no interoperability.
