# Launch Readiness Report

*Prepared at the end of M17, 2026-08-17, against commit `M17`.*

The plan asks M17 to produce this document. Its job is to answer one question — **can
this launch?** — and the answer is worth stating before the evidence:

> **No, not yet. The backend is substantially complete and well tested. The two
> frontends a launch needs do not exist.**
>
> There is no screen on which a user can create an event, browse events, ask to join
> one, hold a conversation, or leave a review. There is no screen on which a moderator
> can act on a report. Every one of those flows works, is tested against a real
> database, and is reachable only by an HTTP client.

That is not a surprise and it is not a regression. Ten milestones recorded "**No Mini
App work**" as a deliberate deviation — M4, M5, M8, M9, M10 and M11 each say so in
those words — and M12 recorded "**No admin SPA.** `apps/admin` does not exist." The
decision was made repeatedly and consistently: build the domain, the invariants and
the API first. It was a defensible order. What was never done is schedule the other
half, and no milestone in §9 owns it.

The rest of this document is the detail: what is proven, what is claimed, and what is
missing.

---

## 1. Where the code actually is

| Component | State | Evidence |
| --- | --- | --- |
| `packages/domain` | Complete for MVP | 1279+ tests, integration against real Postgres + Redis |
| `packages/db` | Complete | 42 tables, 6 triggers, 9 migrations |
| `apps/api` | Complete for §6 **minus `Idempotency-Key`** | 65 endpoint probes in the response-leak scan |
| `apps/worker` | Complete | outbox relay, 8 repeatable sweeps, DLQ |
| Telegram bot | Complete | onboarding, notifications, anonymous chat, channel |
| `apps/miniapp` | **4 screens of ~15** | splash, terms, profile, home |
| `apps/admin` | **Does not exist** | — |

The Mini App has `SplashView`, `TermsView`, `ProfileView` and `HomeView`. That covers
onboarding and nothing after it.

---

## 2. The 32 acceptance criteria (§10)

**Legend** — ✅ proven by an automated test · ⚠️ implemented, not covered by a test ·
🚧 implemented in the backend, unreachable by a user · ❌ not built.

### Successful flows

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 1 | Onboarding grants coins **exactly once** | ✅ | `profile.service.int.test.ts` — 10 concurrent completions, one ledger row |
| 2 | Clean event publishes, appears in discovery within 5 s | ✅ | `event.service.int.test.ts`, `discovery.service.int.test.ts`. Discovery is a synchronous Postgres read, so the 5 s budget is met by construction, not by tuning |
| 3 | Persian search with ي/ك and half-space variants finds it | ✅ | `discovery.service.int.test.ts`, `persian-normalizer.test.ts` (ADR-0012) |
| 4 | ≥5 messages, **zero identity leakage, verified against raw Telegram payloads** | ⚠️ 🚧 | `chat.service.int.test.ts` and the 65-endpoint leak scan prove the API and the domain. The clause "against raw Telegram payloads" is a **manual gate with two real accounts** and has not been performed — there is no chat screen to perform it on |
| 5 | Acceptance opens the chat and increments `accepted_count` | ✅ 🚧 | `participation.service.int.test.ts`, `chat.service.int.test.ts` |
| 6 | Contact sharing needs explicit confirmation and writes `consent` | ✅ 🚧 | `chat.service.int.test.ts` |
| 7 | T+24 h reviews reveal simultaneously | ✅ 🚧 | `review.service.int.test.ts` (D7/D7a) |

### Error flows

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 8 | Blacklisted title never publishes; case records the blacklist version | ✅ | `moderation.service.int.test.ts` |
| 9 | Full event returns `WAITLISTED` with a correct rank | ✅ 🚧 | `waitlist.int.test.ts` |
| 10 | Under-18 refused with a clear Persian message | ✅ | `participation.service.int.test.ts` (`NOT_ELIGIBLE_AGE`), `profile.service.int.test.ts` |
| 11 | Media in chat gets a Persian refusal and stores nothing | ✅ 🚧 | `chat.service.int.test.ts` |
| 12 | Every error carries a stable `code` and a Persian `messageFa` | ✅ | `errors.test.ts` asserts the mapping is **total** over `ErrorCode` |

### Unauthorized

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 13 | Tampered/expired/replayed `initData` ⇒ 401; A cannot read B's data | ⚠️ | **Tampered and expired: ✅** — `init-data.validator.test.ts` covers a tampered hash, a foreign bot token, a modified user id, an unsigned added field, and both freshness bounds. **Replayed: not asserted.** The guard is *exercised* by the leak scan (which must re-sign `initData` per call because each hash is claimed once) but nothing asserts the refusal. **A cannot read B's data: ✅** — the leak scan authenticates as a separate clean account. See §4 |
| 14 | A non-host cannot accept/reject/cancel/edit | ✅ | `participation.service.int.test.ts`, `event.service.int.test.ts` (T3.2: checks in the service, not the controller) |
| 15 | The RBAC matrix matches exactly | ✅ | `rbac-matrix.int.test.ts` — asserted against the same catalogue `seed-rbac` writes |
| 16 | A wrong webhook secret is rejected without processing | ⚠️ | Implemented in `webhook.controller.ts` with **constant-time** comparison of both the path and the token. **No test.** See §4 |

### Duplicates

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 17 | Two joins ⇒ one row + 409 | ✅ | `participation.service.int.test.ts` |
| 18 | Two consents ⇒ one row | ✅ | `consent` — `UNIQUE(user, version, context)`, one `INSERT … ON CONFLICT` |
| 19 | Two reports ⇒ one row + 409 | ✅ | `report.service.int.test.ts` |
| 20 | Two reviews ⇒ one row | ✅ | `review.service.int.test.ts` |
| 21 | A replayed `Idempotency-Key` returns the identical stored response | ❌ | **Not built.** See §3 |

### Concurrency

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 22 | 20 concurrent joins on capacity=5 ⇒ exactly 5/15, **50×**, zero failures | ✅ | `participation.service.int.test.ts`, 50 iterations, fresh event each |
| 23 | Two concurrent accepts for the last seat ⇒ one `CAPACITY_EXCEEDED` | ✅ | `participation.service.int.test.ts` |
| 24 | Two concurrent cancellations ⇒ two **distinct** promotions | ✅ | `waitlist.int.test.ts` — **raised from 25 to 50 iterations in M17**; §14 names this test and that number |
| 25 | Concurrent spends of the last coins ⇒ exactly one succeeds | ✅ | `coin.service.int.test.ts` — **raised from 1 run to 50 iterations in M17**. A single pass through a race is a coin flip that landed the way you wanted |
| 26 | Concurrent profile completions ⇒ exactly one reward | ✅ | `profile.service.int.test.ts` |

### Recovery

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 27 | Killing the worker mid-delivery and restarting delivers exactly once | ⚠️ | The mechanism is proven — `notification.dedupe_key` UNIQUE plus a deterministic BullMQ job id (ADR-0005's two layers), both tested in `relay.int.test.ts`. **Killing an actual process is not tested**; the test simulates the interruption rather than causing it |
| 28 | A crash between commit and enqueue still delivers via the outbox | ✅ | `relay.int.test.ts` — the backstop sweep drains rows the event-driven path never saw |
| 29 | 429 retried per `retry_after`; 403 stops | ⚠️ | 429 is handled by grammY's `auto-retry`, which reads `retry_after`; 403 (bot blocked) is classified and marked undeliverable. `classify.test.ts` covers the classification. **The retry timing itself is the plugin's, and is not asserted here** |
| 30 | Exhausted retries are visible and re-drivable | ✅ | `job-failure.int.test.ts` — the row survives a Redis flush, which is the point |
| 31 | A restore from last night's backup reproduces a working system, **timed and documented** | ⚠️ | Performed and documented: `docs/runbook-backup-restore.md`, **2 s** for a 144 kB development dump, 42 tables / 6 triggers / 4 extensions matching the live database. **At development scale only** — the runbook says so and names when to re-measure |
| 32 | Every job produces the same end state when run twice | ✅ | Idempotency asserted per sweep across `lifecycle`, `waitlist`, `review`, `retention` and `relay` |

**Tally** — 22 ✅ · 5 ⚠️ · 1 ❌ · with **8 of the 22 unreachable by a user** (🚧).

---

## 3. Blockers

### B1 — No Mini App beyond onboarding · **blocks launch**

A user can start the bot, accept the terms and complete a profile. Then the product
stops. Creating an event, browsing, joining, chatting, accepting and reviewing are all
implemented and all unreachable.

Roughly eleven screens are missing: event authoring, the discovery list, event detail,
join/waitlist state, the chat thread, contact-share confirmation, the participant list
with accept/reject, cancellation dialogs (the dry-run endpoints exist precisely to
back them), the review form, coins and trust, and the invite screen.

*Estimate: comparable to two or three backend milestones. This is the launch.*

### B2 — No admin panel · **blocks launch**

`apps/admin` does not exist. The admin API is complete and authorised (ADR-0010, 15/15
on the RBAC matrix), and the only way to reach it is an HTTP client.

The auto-hide at three reports works without a human. Everything after it does not: no
moderator can decide a case, adjust coins or trust, set a user's status, approve a role
change, or use the break-glass unseal. A product that takes reports and cannot act on
them is worse than one that takes none, because it has promised.

### B3 — `Idempotency-Key` is not built · **blocks launch of the coin sinks**

§6 says "Mutating endpoints accept `Idempotency-Key`; replay returns the stored
response". Criterion 21 tests it. Neither exists.

M9 recorded the consequence precisely and it has not changed: `VIP` is naturally
exactly-once because its key is the event, and **`BOOST` is not** — a second boost is a
second purchase of a second window, which is a thing a host may legitimately want, so
the service cannot tell "asked twice" from "arrived twice". Today the only protection
is the Mini App's in-flight disable, which is in the frontend that does not exist (B1),
over a flaky mobile network, on the one endpoint that spends 40 coins.

Every other duplicate path is defended in the database — a unique index on a natural
key — which is why 17–20 pass. Boost is the exception because the natural key is a
window, not a thing.

*Estimate: small. A `request_idempotency` table keyed on `(user, key)` storing the
response, plus an interceptor. It is a day, and it should be done before the coin sinks
are reachable.*

### B4 — The manual privacy gate has not been run · **blocks launch**

§14 makes it the M8 release gate: "a manual two-real-accounts chat test with raw
payload inspection". The five automated layers all pass, including the 65-endpoint leak
scan. Layer 5 cannot see what layer 5 does not serialise — the *bot's* outbound
payloads are constructed in the worker, and the assertion "zero identity leakage
verified against raw Telegram payloads" is about what Telegram actually receives.

It cannot be run until B1 exists.

---

## 4. Gaps that are not blockers, and are real

- **Criterion 16 has no test.** The webhook secret check is implemented correctly, with
  constant-time comparison of both the path and the token, and nothing asserts it. A
  refactor that replaced it with `===` would pass every test in the repository. Worth a
  test before launch; not a blocker, because the code is right today.
- **The replay refusal has no test either**, and it is the same shape of gap on the same
  kind of control. The replay guard works — the leak scan would fail without it, because
  it has to sign fresh `initData` for every call — but "works, and the suite would notice
  if it stopped" is weaker than an assertion, and it is being relied on as *the* defence
  against a captured `initData` being reused. Both of these are an afternoon.
- **Criterion 27 simulates the kill rather than performing it.** Both idempotency layers
  are tested. Nothing spawns a worker, kills it mid-delivery and restarts it.
- **No upload endpoint and no `media` table.** M15 shipped the T13 validator with
  nothing behind it. Nothing in MVP uploads, so this is only a gap against a future.
- **`audit_log` and `chat_message` are unpartitioned** by decision (M15), with partial
  indexes and a nightly indexed `DELETE`. Revisit past ~10 M rows.
- **Backups are verified for readability but never restored automatically.** The
  quarterly rehearsal is the control, and the restore duration at production scale is
  unmeasured.
- **Dumps are not encrypted at rest.** They contain display names, bios and
  `telegram_account` rows in the clear; `rsync --chmod=F600` is the whole protection.
- **No Playwright E2E** (§14 assigns it to M17). It drives the Mini App, so it is
  blocked on B1. Not written, rather than written and skipped — a skipped suite reads as
  coverage.

---

## 5. What M17 delivered

- **25 founding-team events**, Persian, across the two categories launch enables,
  spread over four weeks, capacities 4–8, some `FEMALE_ONLY`, two age-ranged. Start
  times are computed at Tehran +03:30 so «شب بازی» starts in the evening rather than
  after midnight. Normalized through the same `normalize()` the API uses, so they are
  findable by the ي/ك and half-space variants a hosted event is.
- **Hosts that can say yes.** In production the script refuses to invent hosts:
  `FOUNDING_TEAM_TELEGRAM_IDS` must name accounts that have started the bot and
  completed a profile. A seeded event with a fabricated host is an event whose first
  join request expires unanswered — the first real user's first action, ignored.
- **The production rail, all three parts** (§9 M17): `ALLOW_PROD_SEED=1`, an interactive
  typed confirmation of the *database name* (refused outright without a TTY, because
  piping a confirmation is not a confirmation), and an audit row written at the end with
  what actually happened. One shared gate in `tools/seed-guard.ts` rather than five
  copies. `seed-rbac` is the single documented exemption from the first two — it runs on
  every deploy — and still writes the audit row.
- **All 50 policy numbers in `app_setting`.** §11's heading says "all in `app_setting`,
  runtime-changeable"; two rows existed and forty-eight were code-only. They worked
  correctly and were *invisible*, which is not what runtime-changeable means. Create-only,
  so a tuned value is never reset by a seed.
- **Feature flags at launch scope**: Tehran active, Karaj and Isfahan inactive; two
  categories active (`cafe-boardgames`, `outdoor`), two inactive.
- **Criteria 24 and 25 raised to the 50 iterations §14 requires.**

---

## 6. Recommendation

Do not launch. Build the Mini App and the admin panel, add `Idempotency-Key` before the
coin sinks are reachable, then run the manual privacy gate and re-issue this report.

The backend is in good shape and that is worth saying plainly: 1300+ tests, the hard
concurrency invariants proven at 50 iterations against real row locks, both ledgers
reconciled over 1000 random operations, five layers of identity separation with an
automated scan over every endpoint, and a restore that somebody actually ran. None of
that is the thing standing between this repository and users.

**The next milestone is the frontend, and §9 does not have one. That is the finding.**
