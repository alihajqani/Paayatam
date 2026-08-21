# ADR-0016: Gift-code campaigns, a code as a bearer secret, and the admin panel that drives them

- **Status:** Accepted (2026-08-21)
- **Amends:** ADR-0015 (gift codes) — the redemption path is untouched; the *management* surface changes
- **Decides:** nothing frozen. D2 already names Vue 3 for the panel; §3.2 already names `apps/admin`
- **Invariant owned:** none new. Bound by invariants 2, 3, 7 and 12

## Context

Three things arrived at once and they are one decision, because all three are answers to the same
question: **what is a gift code, exactly?**

1. ADR-0015 shipped gift codes with no bulk minting and no analytics beyond `redeemed_count`, and said
   both were additive. They are — but "additive" was doing a lot of work: a campaign of 500 single-use
   codes is the *normal* case for a launch promotion, and one shared multi-use code is the unusual one.
2. B2 — no admin panel — meant every one of those operations was a `curl` session. `project-review.md`
   §13 documented the requests, which is what you write when the answer to "how does an operator do
   this?" is "carefully, at 2 a.m.".
3. `per_user_limit > 1` was supported, defaulted to 1, and described in the schema as "probably
   unwise". A knob nobody should turn is a knob somebody will turn.

Building the panel forced the first question to be answered properly. A screen has to decide what to
*show*, and the moment we wrote «کد» in a table cell it became obvious that ADR-0015 had been treating
a gift code as an identifier when it is a **bearer secret**: whoever holds the string gets the coins.
That single reclassification is what most of this record is about.

## Decision

### 1. A gift code is a bearer secret, and is handled like one

Three consequences, and each of them corrects something ADR-0015 shipped.

**A code is addressed by `public_id`, never by itself.** `POST /admin/v1/gift-codes/NOWRUZ1405/active`
writes a live code into the nginx access log, into any proxy in front of it, and into the operator's
browser history. ADR-0015's own threat section says *"never log raw gift codes"* and then routed on
one. `gift_code` gains a random UUIDv4 `public_id`, exactly as `user` and `event` have, and every admin
route and every response uses it.

**Reads mask the code; the plaintext is returned exactly once.** `GiftCodeSummary` carries
`codeMasked` — `NOWR••••4F2Z` — which is enough to recognise a code a user quoted at you and not enough
to redeem one. The full string comes back only from the call that *created* it. The property this buys
is worth stating plainly: a stolen admin session can see how every campaign is performing and cannot
spend a single code. Without it, one compromised cookie is the entire promotional budget.

Finding a specific code is still possible and is deliberately shaped: the list takes an **exact**
`code` filter, normalized before lookup. An operator holding a code can find its row; an operator
holding nothing cannot enumerate. A prefix search would have handed over the campaign.

**Nothing writes a code into `audit_log`, `coin_ledger.metadata`, a metric label, or a log line.** The
audit row carries `public_id` and the configuration; the ledger row already carries `ref_id`. M18's
`metadata: { code }` was the same mistake in a quieter place — `metadata` is read by the panel,
exported with the ledger, and pasted into support threads.

### 2. Bulk minting is server-side, transactional, and collision-tolerant

`POST /admin/v1/gift-codes/batch` takes a count, an amount, an optional prefix, a length and the usual
window, and returns every code **once**.

- **Generated on the server with `randomInt`**, reusing the referral alphabet — 31 characters with no
  `0/O` and no `1/I/L`, because a code is read off one screen and typed into another. Not in the
  browser (an entropy source nobody controls, and the codes cross the network twice), not from a
  sequence (enumerable by construction), and not from `Math.random` (seeded per process, so two API
  replicas minting at once produce the same batch).
- **Default length 12**, ≈ 7.7 × 10¹⁷ codes. Eight is fine for a referral code that records a
  relationship and is not fine for one that pays.
- **Collisions are re-drawn, not failed.** Each attempt inserts with `skipDuplicates`, counts what
  landed, and generates replacements for the shortfall, up to five rounds. The unique index decides,
  so a code minted by a concurrent request between the draw and the insert costs one retry.
- **One transaction.** A request that cannot place every code rolls the whole batch back. An operator
  must not be handed 970 codes and told they asked for 1000.
- **Capped at `giftcode.max_batch_size`, default 1000.** A thousand rows is a synchronous request that
  returns in well under a second; past it the honest answer is a second batch, not a longer transaction
  holding a unique index. BullMQ was considered and rejected — see *Alternatives*.
- **`batch_id`** is one `randomUUID` per request. The codes are gone from the operator's screen the
  moment they close the tab; the batch id is how they still find *which* codes they made, count them,
  and disable the lot.

### 3. `per_user_limit` is capped at 1 for new codes, and history is untouched

`giftcode.max_per_user_limit` defaults to **1**, enforced in the contract *and* in the service (a seed
script never passes through a zod pipe). The reasoning is that a campaign is bounded by two numbers and
loosening the second collapses them into one: with `per_user_limit = 3`, one account with a script
takes three slots of the global cap instead of one, and the "500 people get 50 coins" the campaign was
approved as becomes "167 people get 150 coins" at best and one person gets everything at worst.

**The column keeps `CHECK (per_user_limit > 0)` and is not tightened.** A constraint tightened over
live data is a migration that fails on the data it was meant to describe. Rows above 1 are history:
their redemptions are paid, their ledger rows are immutable, and rewriting the configuration that
explains them would make the ledger unexplainable. They keep working exactly as they did. The cap
governs what may be **created**.

### 4. Configuration is future-facing; reward history is immutable

Editing a code changes what the **next** redemption grants. It cannot change what a past one did, and
this is structural rather than a rule anybody has to follow:

- `gift_code_redemption.coins` is the amount snapshotted at the moment of the grant (ADR-0015 already
  did this; M19 is what makes it *visible*).
- `coin_ledger` is append-only under a `BEFORE UPDATE OR DELETE` trigger (invariant 3).
- Nothing in `GiftCodeAdminService` writes to either table.

So a campaign retuned from 50 coins to 80 shows 80 on its configuration and 50 against every redemption
that happened at 50, and the two disagreeing is correct. The panel says so in Persian, next to the
field, because a discrepancy an operator cannot explain is a support ticket and then a bug report.

### 5. Refusals become durable, not only counted

`payetam_gift_code_redemptions_total{result}` stays exactly as ADR-0015 designed it and remains the
alerting surface for a brute-force sweep. It is the wrong thing to report a campaign from: it resets on
deploy, it is per-replica, and it carries no time.

So a refused redemption now also writes one `audit_log` row — `giftcode.redeem_failed`, with the reason
code and **never the code that was tried**. `target_id` is the `gift_code.id` when the code resolved
and null when it did not, which is the case that matters: recording near-miss guesses would turn the
audit trail into a list of almost-valid codes.

The row is written **outside** the transaction that failed, and necessarily so — a row written inside
it would roll back with the refusal it was recording. It is the one place in the product where an audit
row must not commit with the thing it describes, because the thing it describes is the absence of a
commit. A failure to write it is swallowed: the user is being told "that code is not valid" either way,
and the counter still moved.

### 6. The panel is `apps/admin`, and it authorises nothing

Vue 3 + Vite + Pinia + Tailwind — the stack §3.2 has named since M0 — as a conventional data-table
layout rather than the Telegram-native one (§3.7). RTL Persian, because the people who work the
moderation queue read Persian; logical CSS properties throughout, so an LTR locale is a `dir`
attribute rather than a rewrite.

It holds the CSRF token in memory and never in storage, reads `/admin/v1/me` for its permission list,
and **hides what the session cannot do as a courtesy only**. Every one of those checks is performed
again in the service layer, which is ADR-0010 rule 2 and invariant 12. The panel is a client; it is not
a control.

## Consequences

**Positive**
- A compromised admin session cannot redeem a single code. That is a new property, not a preserved one.
- No live code reaches an access log, an audit row, a metric label or a ledger `metadata` blob.
- "How did the Nowruz campaign go?" is one query against durable rows, including the refusals.
- A campaign is bounded by two numbers that cannot be collapsed into one.
- Every operation B2 blocked — deciding a case, adjusting a balance, banning an account, approving a
  role change, unsealing a chat, minting a campaign — is a screen.

**Negative**
- **`GET /admin/v1/gift-codes` no longer returns codes, and `POST /admin/v1/gift-codes/:code/active` is
  gone.** Both are breaking changes to a surface documented in `project-review.md` §13, and both are
  the fix rather than a cost of it. The replacement routes take `public_id`.
- **A bulk batch is unrecoverable.** An operator who closes the tab has lost the codes and can only
  disable the batch and mint another. That is the direct consequence of not storing anything a stolen
  session could read, and the panel warns before generating rather than after.
- **`audit_log` grows with refused redemptions.** Bounded by the 10-an-hour bucket per user, so a
  determined sweep produces 240 rows a day per account — visible, which is the point, and inside
  M15's retention purge either way.
- **`per_user_limit > 1` cannot be re-enabled without changing a setting**, which is deliberate friction
  and will annoy somebody with a legitimate use for it exactly once.
- The panel is a fourth surface to keep in step with the contracts. It shares `packages/shared`, so a
  contract change breaks its build rather than its behaviour.

## Alternatives considered

- **Keep returning plaintext codes in the list.** Simplest, and it is what M18 did. Rejected once the
  question was asked directly: a read-only admin session is worth the whole promotional budget, and
  "the session is HttpOnly and CSRF-protected" is a control against theft, not a reason to store
  something valuable behind it.
- **Hash the codes at rest, like passwords.** Considered seriously and rejected. Redemption looks a
  code up by equality, so a hash would work — but the lookup would have to be over a *deterministic*
  hash to use the unique index, which is a hash with a fixed pepper, which is reversible for a
  31-character alphabet at length 12 by anybody who takes the database and the pepper. It buys
  protection against a database dump *without* the application secret, and costs the ability to ever
  show an operator a code again. The masking above addresses the threat that is real: a stolen session.
- **BullMQ for bulk minting, with a job status endpoint.** The plan's own suggestion for large batches.
  Rejected at 1000: the insert is one statement, it returns in well under a second, and a job would
  mean the codes live in a Redis payload — which is a second place a stolen credential can read them,
  reintroducing exactly what the once-only return exists to prevent. If a batch ever needs to be
  100 000, the answer is a job that streams to a signed download, and that is a different ADR.
- **A `campaign` table with a foreign key.** Rejected: a campaign has no attribute that is not already
  on its codes, so the table would be a join whose only column is the name, and renaming a campaign
  would be a migration instead of an `UPDATE`.
- **Tighten `CHECK (per_user_limit = 1)` in the database.** Rejected: it fails on the data it describes,
  and it would make the historical rows unrepresentable rather than merely uncreatable.
- **Auto-reverse the coins from a code that turns out to have been a mistake.** Rejected here and
  deferred to `CoinService.reverse`, which already exists, is audited, and requires somebody to decide.
  A campaign being disabled must not claw back coins people have already been told they have.
