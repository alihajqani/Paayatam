# Launch Readiness Report

*Prepared at the end of M17, 2026-08-17. **Revised 2026-08-17** after the bot's inbound
half was built — see §7 for what changed and what the first version of this document
got wrong. **Revised again 2026-08-20** after M18; see §9.*

The plan asks M17 to produce this document. Its job is to answer one question — **can
this launch?** — and the answer is worth stating before the evidence:

> **No, not yet. The backend is substantially complete and well tested. The Mini App
> a launch needs does not exist, and neither does the admin panel.**
>
> A user can now start the bot, be greeted, hold a full anonymous conversation in
> Telegram, and a host can accept or reject a request from a button. What no screen
> exists for is *getting into* a conversation: browsing events, creating one, asking
> to join, sharing contact details, leaving a review. There is no screen on which a
> moderator can act on a report.

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
| `packages/domain` | Complete for MVP | part of **1626** tests (1459 at M17), integration against real Postgres + Redis |
| `packages/db` | Complete | 45 tables, 6 triggers, 16 migrations (see the note below) |
| `apps/api` | Complete for §6 (`Idempotency-Key` landed with B3) | **71** endpoint probes in the response-leak scan, and the coverage assertion is derived from the routes Fastify actually registered rather than from a number |
| `apps/worker` | Complete | outbox relay, 8 repeatable sweeps, DLQ |
| Telegram bot — outbound | Complete, and **delivering for the first time** | notifications, keyboards, channel posts, block detection — see §7 |
| Telegram bot — inbound | Complete | `/start`, accept/reject/close buttons, text relay, edit propagation; 32 end-to-end tests |
| `apps/miniapp` | **13 screens** — B1 closed | splash, terms, profile, home, discover, event detail, create, edit, my events (with the participant queue), my requests, chats (with contact-share consent), reviews, wallet |
| `apps/admin` | **Does not exist** | — |

*Updated after M18:* `packages/db` is now **45 tables, 6 triggers and 16 migrations**
(numbered to `0017` — the sequence skips `0010`, see `project-review.md` §4). The two
new tables are `gift_code` and `gift_code_redemption`; `apps/api` gained four endpoints — one user-facing
(`POST /gift-codes/redeem`) and three admin — all four covered by the response-leak
scan. No new screen: M18's work landed inside the wallet, the event detail, the host's
queue and the chat list.

**Revised again, 2026-08-17.** The Mini App now covers the core loop: create → discover
→ detail → join → the host's decision → the conversation. B1 below is reduced rather
than closed, and §2's three 🚧 marks are cleared — the criteria they sat on are now
reachable by a user. What remains unreachable is the contact-share confirmation, the
review form, and everything a moderator does.

**The shape of what is missing is now specific**, and it is worth stating precisely
because it is easy to read the two "Complete" rows above as more than they are:
everything *inside* an anonymous conversation is reachable through Telegram, and
nothing that gets somebody *into* one is. A chat is created by a join; joining has no
surface. So the relay works, is tested against a real database, and can be exercised
end to end only if the join is made with an HTTP client.

---

## 2. The 32 acceptance criteria (§10)

**Legend** — ✅ proven by an automated test · ⚠️ implemented, not covered by a test ·
🚧 implemented, no user surface reaches it · ❌ not built.

Every remaining 🚧 is now *upstream* of a conversation rather than inside one.

### Successful flows

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 1 | Onboarding grants coins **exactly once** | ✅ | `profile.service.int.test.ts` — 10 concurrent completions, one ledger row |
| 2 | Clean event publishes, appears in discovery within 5 s | ✅ | `event.service.int.test.ts`, `discovery.service.int.test.ts`. Discovery is a synchronous Postgres read, so the 5 s budget is met by construction, not by tuning |
| 3 | Persian search with ي/ك and half-space variants finds it | ✅ | `discovery.service.int.test.ts`, `persian-normalizer.test.ts` (ADR-0012) |
| 4 | ≥5 messages, **zero identity leakage, verified against raw Telegram payloads** | ✅ | **Executed 2026-08-21** — `privacy-gate.int.test.ts` and [`b4-privacy-gate.md`](b4-privacy-gate.md). Two accounts created through signed `initData`, five messages across both surfaces including a real `text_mention` update, and a sweep of every response *and* every stored payload — `notification.payload` (what the worker hands to Telegram), the outbox, the ciphertext at rest, and `audit_log`. Also `chat.service.int.test.ts`, the leak scan, `webhook.int.test.ts`. **One clause is still owed to a human**: what a Telegram *client* renders, which no process that never calls Telegram can observe. The procedure is written down (§5 there) |
| 5 | Acceptance opens the chat and increments `accepted_count` | ✅ | `participation.service.int.test.ts`, `chat.service.int.test.ts`. The host's decision is now reachable from a button in the notification; the join that precedes it is not (see 9) |
| 6 | Contact sharing needs explicit confirmation and writes `consent` | ✅ | `chat.service.int.test.ts`, and **the screen now exists** (`ChatsView`): a two-step confirmation that states plainly what sharing does and does not do — the platform holds no phone number and surrenders no username; what changes is that the caller's own messages stop being masked. Deliberately not a callback button, which would make «مطمئنید؟» a single tap |
| 7 | T+24 h reviews reveal simultaneously | ✅ | `review.service.int.test.ts` (D7/D7a), and **the form now exists** (`ReviewsView`): rating, the closed tag vocabulary, optional comment, and an edit path that asks `editableUntil` rather than doing its own arithmetic. Nothing of the counterparty's review is fetched, because no contract to fetch it exists |
| 8 | Blacklisted title never publishes; case records the blacklist version | ✅ | `moderation.service.int.test.ts` |

### Error flows

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 9 | Full event returns `WAITLISTED` with a correct rank | ✅ 🚧 | `waitlist.int.test.ts`. **This is the one that blocks the rest**: joining has no surface, and a join is what creates a chat |
| 10 | Under-18 refused with a clear Persian message | ✅ | `participation.service.int.test.ts` (`NOT_ELIGIBLE_AGE`), `profile.service.int.test.ts` |
| 11 | Media in chat gets a Persian refusal and stores nothing | ✅ | `chat.service.int.test.ts` and `webhook.int.test.ts` — a real photo update is answered with «فقط ارسال متن امکان‌پذیر است» and stores no message |
| 12 | Every error carries a stable `code` and a Persian `messageFa` | ✅ | `errors.test.ts` asserts the mapping is **total** over `ErrorCode`. The bot's refusals read from the same catalogue rather than a second copy of it |

### Unauthorized

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 13 | Tampered/expired/replayed `initData` ⇒ 401; A cannot read B's data | ⚠️ | **Tampered and expired: ✅** — `init-data.validator.test.ts` covers a tampered hash, a foreign bot token, a modified user id, an unsigned added field, and both freshness bounds. **Replayed: not asserted.** The guard is *exercised* by the leak scan (which must re-sign `initData` per call because each hash is claimed once) but nothing asserts the refusal. **A cannot read B's data: ✅** — the leak scan authenticates as a separate clean account. See §4 |
| 14 | A non-host cannot accept/reject/cancel/edit | ✅ | `participation.service.int.test.ts`, `event.service.int.test.ts` (T3.2: checks in the service, not the controller) — and `webhook.int.test.ts` asserts the same through a forged inline button, which is the surface where the id is client-supplied |
| 15 | The RBAC matrix matches exactly | ✅ | `rbac-matrix.int.test.ts` — asserted against the same catalogue `seed-rbac` writes |
| 16 | A wrong webhook secret is rejected without processing | ✅ | `webhook.int.test.ts` — five wrong-secret shapes, including a prefix of the real token and a token one character out. Each must answer **200 with an identical body** *and* leave no user row, which is the only way "without processing" is observable from outside |

### Duplicates

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 17 | Two joins ⇒ one row + 409 | ✅ | `participation.service.int.test.ts` |
| 18 | Two consents ⇒ one row | ✅ | `consent` — `UNIQUE(user, version, context)`, one `INSERT … ON CONFLICT` |
| 19 | Two reports ⇒ one row + 409 | ✅ | `report.service.int.test.ts` |
| 20 | Two reviews ⇒ one row | ✅ | `review.service.int.test.ts` |
| 21 | A replayed `Idempotency-Key` returns the identical stored response | ✅ | `idempotency.int.test.ts` — replay is **byte-identical** (`response_body` is TEXT, not JSONB, so key order survives), carries `Idempotency-Replayed: true`, performs the work once, refuses the same key on a different body, cannot cross users, and leaves a *failed* request retryable |

### Concurrency

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 22 | 20 concurrent joins on capacity=5 ⇒ exactly 5/15, **50×**, zero failures | ✅ | `participation.service.int.test.ts`, 50 iterations, fresh event each |
| 23 | Two concurrent accepts for the last seat ⇒ one `CAPACITY_EXCEEDED` | ✅ | `participation.service.int.test.ts` |
| 24 | Two concurrent cancellations ⇒ two **distinct** promotions | ✅ | `waitlist.int.test.ts` — raised from 25 to 50 iterations in M17; §14 names this test and that number |
| 25 | Concurrent spends of the last coins ⇒ exactly one succeeds | ✅ | `coin.service.int.test.ts` — raised from 1 run to 50 iterations in M17. A single pass through a race is a coin flip that landed the way you wanted |
| 26 | Concurrent profile completions ⇒ exactly one reward | ✅ | `profile.service.int.test.ts`. `webhook.int.test.ts` adds the equivalent for `/start`: ten simultaneous taps, one user |

### Recovery

| # | Criterion | State | Evidence |
| --- | --- | --- | --- |
| 27 | Killing the worker mid-delivery and restarting delivers exactly once | ⚠️ | Both of ADR-0005's layers are now tested where they actually live: `notification.dedupe_key` in `relay.int.test.ts`, and the deterministic BullMQ job id in `queue.int.test.ts` **against real Redis** — which it was not before, and which is how a job id nothing could ever add went four milestones unnoticed (§7). **Killing an actual process is still not tested**; the test simulates the interruption rather than causing it |
| 28 | A crash between commit and enqueue still delivers via the outbox | ✅ | `relay.int.test.ts` — the backstop sweep drains rows the event-driven path never saw. Note that until §7's fix the word "delivers" was false for *every* path, not only this one: the outbox → notification step worked and the notification → queue step threw |
| 29 | 429 retried per `retry_after`; 403 stops | ⚠️ | 429 is handled by grammY's `auto-retry`, which reads `retry_after`; 403 (bot blocked) is classified and marked undeliverable. `classify.test.ts` covers the classification, and `webhook.int.test.ts` now covers the *other* direction — `my_chat_member` marking and clearing `bot_blocked`. **The retry timing itself is the plugin's, and is not asserted here** |
| 30 | Exhausted retries are visible and re-drivable | ✅ | `job-failure.int.test.ts` — the row survives a Redis flush, which is the point |
| 31 | A restore from last night's backup reproduces a working system, **timed and documented** | ⚠️ | Performed and documented: `docs/runbook-backup-restore.md`, **2 s** for a 144 kB development dump, 42 tables / 6 triggers / 4 extensions matching the live database. **At development scale only** — the runbook says so and names when to re-measure |
| 32 | Every job produces the same end state when run twice | ✅ | Idempotency asserted per sweep across `lifecycle`, `waitlist`, `review`, `retention` and `relay`, and now for the enqueue itself: adding the same job id twice produces one job (`queue.int.test.ts`) |

**Tally** — 26 ✅ · 5 ⚠️ · 1 ❌ · with **3 of the 26 unreachable by a user** (🚧), all of
them upstream of a conversation. *(The first version of this document tallied "22 ✅ ·
5 ⚠️ · 1 ❌", which adds to 28 rather than 32. The arithmetic was wrong; the marks in
the table were not.)*

---

## 3. Blockers

### B1 — No Mini App beyond onboarding · **CLOSED, 2026-08-17**

All nine screens exist. The last four — contact-share confirmation, the review form,
the coins/trust/invite wallet and the report dialog — landed after the core loop, and
criteria 6, 7 and 21 are now reachable by a user rather than only by an HTTP client.

The original finding follows.

A user can start the bot, accept the terms and complete a profile. Then the product
stops. Creating an event, browsing, joining, sharing contact details and reviewing are
all implemented and all unreachable.

The bot narrows this but does not close it. **A conversation is now a real Telegram
conversation** — messages, edits, the host's decision, closing — and that is the
feature the product is built around. What has no surface is everything that leads to
one, and it is the join in particular: no join, no chat, so the whole conversational
half of the product is gated behind a screen that does not exist.

**Reduced, 2026-08-17.** Seven of the nine are built: event authoring, the discovery
list with its filters, event detail, join with its PENDING/WAITLISTED states, the
participant list with accept and reject, and both cancellation dialogs — host and
participant — fed by the dry-run endpoints that existed precisely to back them.

Two remain, and neither blocks the loop: **contact-share confirmation** (criterion 6,
deliberately a screen rather than a callback button) and the **review form**
(criterion 7). The coins/trust/invite screens are P2; the balance is on the home
screen and nothing else in the economy is reachable, which is fine while the only
sink — boost — is gated on B3 anyway.

The loop is verified end to end against a real API with two accounts and database
assertions at every step: 44 checks covering the seat held at request time, invariant 1
holding, aliases in place of names, ciphertext at rest, no Telegram identifier in any
payload, and delivery going through the queue rather than inline.

*Estimate for what is left: small, and no longer on the critical path.*

### B2 — No admin panel · **blocks launch**

`apps/admin` does not exist. The admin API is complete and authorised (ADR-0010, 15/15
on the RBAC matrix), and the only way to reach it is an HTTP client.

The auto-hide at three reports works without a human. Everything after it does not: no
moderator can decide a case, adjust coins or trust, set a user's status, approve a role
change, or use the break-glass unseal. A product that takes reports and cannot act on
them is worse than one that takes none, because it has promised.

### B3 — `Idempotency-Key` · **CLOSED, 2026-08-17**

Built: migration 0016 (`request_idempotency`), a global `IdempotencyInterceptor` that
does nothing unless a request carries the header, and the boost button that sends one.
Verified end to end — two identical boost requests with one key spend **40 coins
exactly once**, produce one `BOOST_SPEND` ledger row and one stored response.

The original finding, kept because it explains why this and nothing else needed it:

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

### B4 — The manual privacy gate · **CLOSED, 2026-08-21**

Executed and automated. `privacy-gate.int.test.ts` walks two accounts created through
signed `initData` — real Telegram ids, a real `@username`, a phone number in each
bio — through five messages across **both** surfaces, including three real Telegram
update bodies posted to the real webhook and one carrying a `text_mention` entity
with a raw numeric user id inside it. It then sweeps every response *and* every
stored payload: `notification.payload`, which is what the worker hands to Telegram
and is as close to a raw Telegram payload as a process that never calls Telegram can
get; the outbox; the ciphertext at rest; `audit_log`; and the chat tables.

Twenty assertions, all green. Three failed on the first run and all three were the
gate finding something — a walk that had made the bot's disambiguation kick in, a
sweep that could not tell a caller's own bio from a disclosure, and a sweep that could
not tell a disclosure from a consent. Full account in
[`b4-privacy-gate.md`](b4-privacy-gate.md) §4.

**What is still owed to a human** is one live capture from a real Telegram client:
what it *renders* — a forwarded-from attribution, a profile link on a name, a resolved
link preview — which is the only thing no automated gate on this side can see. The
procedure is written down step by step so it can be performed by somebody who did not
write it. It is a **pre-launch recommendation**, not a blocker: every layer beneath
what a client renders is now asserted on every commit.

The original finding, kept because it explains why the automated version was built
the way it was:

### ~~B4 — The manual privacy gate has not been run~~ · *superseded above*

§14 makes it the M8 release gate: "a manual two-real-accounts chat test with raw
payload inspection". This is the item whose status changed most.

Before the bot's inbound half, the gate was **impossible**: there was no surface on
which two people could hold a conversation at all, so the previous version of this
document recorded "it cannot be run until B1 exists". It can be run now. Two real
Telegram accounts, a bot token, `setWebhook`, and one HTTP call each to create the
join — the conversation itself, the aliases, the masking, the edits and the host's
accept are all real Telegram traffic that can be captured and inspected.

**It should be run before anything else on this list**, and the reason is §7's finding:
the automated layers agreed with each other for four milestones while the feature they
protect delivered empty messages. A live payload capture is the one check that has no
shared assumption with the rest.

---

## 4. Gaps that are not blockers, and are real

- ~~**The replay refusal has no test.**~~ **Closed, 2026-08-17**:
  `replay-guard.int.test.ts` asserts it against real Redis — a second use refused, every
  later use refused, exactly one of ten *concurrent* claims accepted, and a TTL that
  expires the claim. Criterion 13's "replayed ⇒ 401" is now asserted rather than
  inferred.
- **An edit is delivered as a new message, not as an edit of the recipient's copy.**
  `chat_message.telegram_message_ids` exists for exactly this and is written by
  nothing, so the product cannot find the delivered copy to edit. The corrected text
  does arrive, marked «ویرایش شد».
- **Delete propagation has no trigger and cannot be reached.** The Bot API sends **no
  update** when a user deletes a message in a private chat, so D10's delete half can
  only ever be driven from a Mini App screen — and `POST /chats/:id/messages` has no
  delete sibling. The domain method, its outbox event and its template are built and
  tested; nothing calls them.
- **No integration test drives a live BullMQ *worker*.** The producer side is covered
  now (`queue.int.test.ts`), which is what §7's bug needed, and `WorkerFactory` — the
  consumer, its retry mirroring and its DLQ write — is still exercised by nothing. M13
  named this gap; half of it is closed.
- **A relayed message is deduped by a read, not by an index.** A redelivered Telegram
  update finds the message it already stored, which covers the sequential retries
  Telegram actually produces; two *simultaneous* deliveries of one update would still
  relay twice. Making the partial index UNIQUE cannot be expressed in `schema.prisma`.
- **Criterion 27 simulates the kill rather than performing it.** Both idempotency
  layers are tested. Nothing spawns a worker, kills it mid-delivery and restarts it.
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

## 6. What the bot's inbound half delivered

Built after M17 and recorded in the plan as *M13-inbound*. §6's five surfaces, none of
which existed:

- **`/start [payload]`** — creates exactly one user under ten simultaneous taps, greets
  in Persian with a button into the Mini App, and claims a referral code from the
  deep-link payload. A stale or mistyped code still greets somebody: an error as the
  first thing a new user reads loses the user over a link they did not write.
- **`chat:accept|reject|close:<id>`** — the host decides from the notification itself,
  which for a request that expires in 24 hours (D9) is the difference between an
  answered request and an expired one. The button carries no authority: the id is
  client-supplied, so a forged tap names a resource somebody does not own and
  `ParticipationService` refuses it (asserted).
- **The `message:text` relay** — resolved to a conversation by reply-first, then by
  "exactly one live chat", and otherwise **refused with an explanation**. Delivering a
  private message to the wrong stranger is the worst outcome available to this path, so
  it is the one case that is not guessed.
- **`edited_message` propagation** — the stored message follows the sender's edit, and
  the recipient is told.
- **`my_chat_member`** — a block marks the account and stops the sender burning the
  rate budget on somebody who is gone; unblocking clears it. A membership change in our
  own channel is ignored rather than read as a block.

Plus the four things found on the way, which matter more than the surfaces:

1. **Not one notification had ever been enqueued.** See §7 — this is the larger of the
   two findings.
2. **The relayed chat message was being delivered with an empty body.** Also §7.
3. **`chat.message_edited` and `chat.message_deleted` reached the outbox and stopped
   there** — `planNotifications` matched neither, and `fanout.test.ts` asserted that as
   intended behaviour.
4. **The CI integration job could not boot the real application** — `CHAT_ENCRYPTION_KEY`
   and the JWT secrets come from `.env`, which CI does not have, so the response-leak
   scan had been failing at construction rather than scanning anything.

---

## 7. What the first version of this report got wrong

Worth recording plainly, because the error and the two bugs it hid are the same shape:
**a status assembled from what the code contains rather than from what a user receives.**

### The claim

§1 said "Telegram bot | Complete | onboarding, notifications, anonymous chat, channel".
Only the outbound half existed. The bot could send; it could not receive. `/start` did
nothing, the accept and reject buttons did not exist, and a message typed to the bot was
discarded by a webhook whose handler read:

> `// Update dispatch to the grammY bot lands with the /start handler.`

M13's own deviation note said so in as many words — "**None of that exists**" — and the
report still carried "Complete".

### The first bug: nothing was ever enqueued

BullMQ composes its Redis keys as `prefix:queue:jobId`, and version 6 refuses a custom
job id containing a colon: `Custom Id cannot contain :`. Every producer in the
repository built its id as `notify:${notificationId}`.

So `queue.add` threw — and it threw *after* `relay.drain()` had already marked the
outbox row processed. The row looked delivered, the notification sat `PENDING` with
**zero attempts**, and the backstop sweep had nothing left to recover. **Every
acceptance, every rejection, every relayed message, every review reminder: queued in
Postgres, never handed to a queue, never sent.** The outbound half of the bot — the row
this report called "Complete" — had never delivered a single message.

Nothing caught it because nothing drove a real queue. M13 said so in its deviations and
the note was left standing: *"No integration test drives a live BullMQ worker."*
Everything either side of the queue was tested; the queue was where it broke.

**It was found by starting the API, sending one `/start`, and asking why nothing
arrived.**

### The second bug: the messages that did get through said nothing

M8 deliberately wrote the chat outbox payload with ids and an alias and no message text,
so that a plain jsonb column would never hold a sentence somebody wrote, and left a
note: *"M13's relay decrypts the row the payload points at."* Nothing did.
`render(CHAT_MESSAGE)` interpolated an absent `text`, so every relayed message would
have gone out as «میهمان ۱:» followed by nothing — had any of them gone out at all.

### The lesson

Five layers of leak protection, a 65-endpoint scan and 1459 tests all passed, because
every one of them asserts what must *not* be in a message and none of them asserted that
a message arrives and says something. Both bugs are fixed and covered now — one by
`jobId()` and a real-Redis test, the other by decrypting at delivery — but the general
point is the one §14 already made and this document under-weighted: **the manual gate is
not a formality.** Two real accounts and one conversation would have found both in an
afternoon, years before any user did.

---

## 8. Recommendation

0. **Rewrite the `ChatsView` anonymity sentence** (added after M18, §9). It is a false
   statement to users and it is five minutes' work.
1. ~~**Run the manual privacy gate now** (B4).~~ **Done, 2026-08-21** — automated as
   `privacy-gate.int.test.ts`, documented in [`b4-privacy-gate.md`](b4-privacy-gate.md),
   with one live-client capture left as a pre-launch recommendation. The original
   reasoning, which still holds for that remaining step: it is possible for the first time, it is
   cheap, and §7 is the argument for doing it before anything else.
2. Build the Mini App (B1), starting with discovery → event detail → **join**: that one
   path is what makes the conversational half of the product reachable at all.
3. Add `Idempotency-Key` (B3) before the coin sinks are reachable.
4. Build the admin panel (B2).
5. Re-issue this report.

Do not launch. The backend is in good shape and that is worth saying plainly: 1459
tests, the hard concurrency invariants proven at 50 iterations against real row locks,
both ledgers reconciled over 1000 random operations, five layers of identity separation
with an automated scan over every endpoint, a restore somebody actually ran, and a bot
that now answers. None of that is the thing standing between this repository and users.

It is worth saying the other half too, because §7 earns it: **a suite this size proved
nothing about whether a message reaches a person.** Two of the four things found while
building the bot were total failures of delivery sitting behind green tests. Whatever is
built next, the first check should be somebody receiving something.

**The next milestone is the frontend, and §9 does not have one. That is still the
finding.**

---

## 9. What M18 changed (2026-08-20)

Three user-visible gaps and one absent capability. None of them moves the
recommendation above: **the answer is still no, and for the same two reasons** — B2 (no
admin panel) and B4 (the manual privacy gate has never been run).

| Change | Effect on readiness |
|---|---|
| Trust Score on the event page and in the host's request queue | Closes a real hole in the product's own logic: §11 has priced reputation since M9 and it reached no screen where anybody decides. Nothing about launch readiness turns on it |
| Conversations titled «name — event», in the Mini App **and** the bot's relay | Fixes the one place where the anonymous-chat surface was genuinely unusable: a single Telegram thread carrying several conversations all headed «میهمان ۱» |
| Gift codes, end to end | A new capability. **Inherits B2**: with no panel, minting and disabling a campaign is a `curl` session, documented in `project-review.md` §13 |
| Referral sharing and status in the wallet | UI only; the backend has been complete since M9 |

**Two findings worth recording, because both are the kind this document exists for.**

1. **A stated control was not doing what it claimed.** ADR-0009 layer 3 said per-chat
   aliases stop a host correlating a guest across events. They do not, and have not
   since M6: the participant list returns every requester's display name in the same
   order alias indices are assigned. The control was costing real usability — an
   unreadable conversation list — and buying nothing. ADR-0014 accepts the risk
   explicitly and the threat model now carries it as **R8** with T2.5 downgraded from ✅
   to ⚠️. Nothing about `telegram_account` changed; invariant 7 is untouched.
2. **A user-facing privacy promise is now wrong, and was left wrong on purpose.**
   `ChatsView` tells the user their identity is hidden «تا زمانی که خودشان نخواهند».
   True of contact details, never true of display names. Changing that sentence is a
   product-voice decision, and the commit that made it inaccurate is the wrong place to
   make it. **It should be rewritten before launch** — added to the recommendation list
   as item 0, because it is a five-minute change that is currently a false statement to
   users.

**Tests:** 1626 across 70 files, of which 21 are new in M18 — a gift-code integration
suite (concurrency at 50 and 25 iterations, both caps, both windows, the CHECK
constraints asserted directly), an admin gift-code suite, the Trust-Score pairing
assertion in the participant queue, the conversation-title cases in chat, the relay
header unit tests, and the wallet store's redemption path.
