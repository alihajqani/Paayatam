# B4 — the two-account privacy gate

**Status: executed, automated, and green — with one clause still owed to a human.**
Last run: 2026-08-21, against a real PostgreSQL 16 and the real application module.

Acceptance criterion 4 is the product's central promise, written as a test:

> host and guest exchange **≥5 messages** with **zero identity leakage, verified against raw
> Telegram payloads**

It has been the one criterion nobody could tick since M8. `launch-readiness.md` recorded it as a
manual gate needing two real Telegram accounts, and it was never performed — which made it a launch
blocker (B4) rather than a gap.

This document is what replaced it: what the gate now checks, how to run it, what it found, and the
one thing it still cannot do.

---

## 1. Why an automated gate, when the criterion says "manual"

§7 of the launch-readiness report contains the finding that shapes everything here:

> the automated layers agreed with each other for four milestones while the feature they protect
> delivered empty messages

Agreement between things that share an assumption is not evidence. So the gate is automated **and**
deliberately shares as few assumptions with the rest of the suite as it can:

| The rest of the suite | The gate |
|---|---|
| Users inserted with Prisma | Two accounts created through `POST /api/v1/auth/telegram` with **signed `initData`**, real Telegram ids, a real `@username` |
| `ChatService` called directly | Messages sent over **both** surfaces — the Mini App API *and* the real webhook with **real Telegram update bodies** |
| Mappers asserted in isolation | Every **response body** collected as the walk runs, and every **stored payload** swept afterwards |
| One leaky fixture account | **Both** accounts carry identifiers, so a product that protects one and leaks the other fails |

The webhook half carries a `text_mention` entity with a raw numeric user id inside it — the exact
shape T2.2 exists for, and the one that cannot be produced by calling a service.

---

## 2. What it runs

`apps/api/src/privacy-gate.int.test.ts`, in the `integration` project against a real database.

```bash
make up            # Postgres + Redis
make db-test       # a separate database, so your dev data is not truncated
pnpm test:integration -- apps/api/src/privacy-gate.int.test.ts
```

Three accounts:

| | Telegram id | `@username` | Phone in bio | Role |
|---|---|---|---|---|
| **A** | `574113902` | `privacy_gate_host` | `+989121234567` | Host |
| **B** | `611884205` | `privacy_gate_guest` | `+989127654321` | Guest |
| **C** | `655010101` | — | — | Stranger, for the authorisation half |

The walk, in order:

1. All three sign in with signed `initData`. Profiles are written with a phone number in the bio —
   directly, because the onboarding endpoint's own moderation would reject a bio full of contact
   details, and what is under test is whether the *projections* leak it.
2. **A** creates two events.
3. **B** asks to join the first. The second join is deferred deliberately — see §5.
4. **Five messages**, across both surfaces: two through the Mini App API, three through the real
   webhook, one of them carrying the `text_mention` entity and one containing B's own phone number
   typed into the anonymous stage.
5. **A accepts.** Everything up to here is the *anonymous stage*, and is judged as such.
6. **B shares contact**, then sends their number deliberately.
7. **B joins the second event**, for the cross-event half.
8. Both sides read every surface either can reach: chats, messages, participations, own events,
   the event page, the participant queue, `/me`, referrals, coins, pending reviews, and each
   other's revealed reviews.

---

## 3. What it asserts

### The sweep

Four identifiers, across **every API response** *and* every stored payload —
`notification.payload` (which is what the worker hands to Telegram; ADR-0005 means this process
never calls Telegram itself), `outbox_event.payload`, the `chat_message` rows at rest, `audit_log`,
and `anonymous_chat` + `chat_participant`:

- account A's Telegram id
- account B's Telegram id
- an `@username`
- a `t.me/` link

Bigints are rendered as digits rather than thrown on. `JSON.stringify` refusing a `bigint` is the
useful accident the schema celebrates — it makes serialising one into a *response* fail loudly — but
in a sweep it would mean the payload was never read, and a sweep that cannot read a payload reports
clean on it.

### The phone number, which is different

A phone number is the one identifier a user is **allowed** to disclose, so it is checked over a
narrower slice and in both directions:

- **Before consent**: no response contains one. `GET /api/v1/me` is excluded, because it returns the
  caller their own bio — a sweep that failed on somebody's own data would be silenced rather than
  fixed, which is a mistake M5 already had to correct once.
- **After consent**: one *is* delivered. The gate asserts this too. A gate that treated the feature
  as a leak would be arguing with ADR-0009 rather than enforcing it.

### The specific controls

| Assertion | Control |
|---|---|
| ≥5 `TEXT` messages actually stored | Criterion 4's own number, so the gate cannot pass without exercising what it is named after |
| A phone typed in the anonymous stage was **masked** | T2.3 — asserted from the `redactions` record, since the body itself is ciphertext |
| No `text_mention` survived into any queued payload | T2.2 — all entities stripped before relay |
| The stranger gets **404**, not 403, on the chat and on the participant queue | T3.3 — a 403 confirms the thing exists |
| The event page names the host and never the guest | The narrowest projection in the product |
| The host reads the same `userPublicId` on both their queues | R8, accepted and disclosed — pinned so a change in either direction is deliberate |
| Searching discovery for the guest's name finds neither of their events | There is no query that turns a person into a list of events |
| Neither party can read an unrevealed review | Invariant 8 |
| The host's own messages stay masked after only the guest shared | Criterion 6 — sharing is one-sided until each side says so |

---

## 4. Results

**20 assertions, all passing**, 2026-08-21.

Three of them failed on the first run, and all three were the gate finding something:

1. **Only three messages were relayed, not five.** The guest had joined *both* events before the
   conversation started, so a plain Telegram message was ambiguous and the bot correctly asked them
   to use "Reply" instead of guessing which conversation they meant. Correct product behaviour; a
   badly ordered walk. Fixed by deferring the second join, which is why step 7 is where it is.
2. **The phone sweep failed on `GET /api/v1/me`** — the caller's own bio, returned to the caller.
   Not a leak. Fixed by scoping the phone check rather than by relaxing it.
3. **The phone sweep failed on the message sent after contact sharing.** Also not a leak: it is
   what the sharing was for. Fixed by splitting the walk at consent and asserting **both** halves.

No control was found broken. What was found is that a naive sweep cannot tell a disclosure from a
consent, and the fix was to make the gate express the difference rather than to lower the bar.

---

## 5. What this still does not cover

**One live capture from a real Telegram client.** The gate drives the real webhook with real update
bodies and inspects the payload the worker would send — which is as close to "the raw Telegram
payload" as a process that never calls Telegram can get. It does not:

- receive a message that Telegram itself constructed and delivered over the network;
- observe what a Telegram client *renders* — a forwarded-message header, a profile link on a name,
  a link preview that resolved;
- confirm that `link_preview_options.is_disabled` behaves as documented on a real send (T2.6).

### The manual procedure, for whoever performs it

1. `make up`, `make dev`, `make tunnel`, `make webhook` — a live bot with a public URL.
2. Two real Telegram accounts on two devices. Account A creates an event from the Mini App;
   account B requests to join.
3. Exchange **at least five** messages in both directions from inside Telegram, including:
   - one containing the sender's own `@username`;
   - one containing a phone number;
   - one where the sender taps a name to produce a `text_mention`;
   - one containing a `t.me/` link.
4. Accept from the inline button, not from the Mini App.
5. On each device, in the Telegram client: open every relayed message's context menu and check for a
   "forwarded from" attribution, tap the sender name in the header, and check for a link preview.
6. Capture the raw traffic: `getWebhookInfo`, and the bot's outbound calls from the worker log
   (`make logs SERVICE=worker`). Grep both for each account's Telegram id, `@username`, and phone.
7. Record the result — including the negative — at the bottom of this file.

**Nothing in the automated gate substitutes for step 5.** It is the only step that checks what a
human actually sees.

---

## 6. Release position

B4 is **no longer a blocker**: the criterion's checkable half is checked, automated, and runs on
every commit, and the three findings above were resolved rather than deferred. The manual capture in
§5 remains **recommended before launch** and is documented so it can be performed by somebody who is
not the author of this document.

The residual risk is narrow and named: a leak that exists only in what a Telegram *client* renders,
from data that never touches our payloads. Every layer under that is asserted.
