# ADR-0015: Gift and discount codes as a sibling of the referral, not a second economy

- **Status:** Accepted (2026-08-20)
- **Decides:** nothing frozen — this is new surface
- **Invariant owned:** none new. It is bound by invariants 2, 3 and 12.

## Context

The product needs a code somebody can type in exchange for coins: a launch promotion, a recovery
gesture from support, a partnership. Nothing in the plan covers it — §4.5 has `coin_account`,
`coin_ledger` and `referral`, and no notion of a campaign.

The failure mode is well known and specific. A promotion feature that grows its own balance column, or
credits without writing a ledger row, breaks ADR-0007's reconciliation
(`balance = SUM(coin_ledger.amount)`) on its first redemption — and it does so silently, because the
balance still looks right to the user who redeemed. The second failure mode is a code that can be
redeemed twice by one person on a flaky connection, which is the same double-credit the onboarding
reward was designed against in M3.

## Decision

### It is a sibling of `referral`, and it moves coins the only way anything does

`gift_code` and `gift_code_redemption` sit beside `referral` in the economy slice. Every coin they
grant goes through `CoinService.apply` with a derived idempotency key, exactly as the onboarding
reward, the review reward and both halves of a referral do. There is no second balance, no second
ledger, and no path to a user's coins that does not produce a `coin_ledger` row.

`coin_ledger_type` gains `GIFT_CODE_REDEEM` rather than reusing `ADMIN_ADJUSTMENT`. "Somebody typed a
campaign code" and "a human moved a balance by hand" answer different questions in an audit and have
different people to ask about them.

### Three guards, in the database, in this order

1. **`SELECT … FOR UPDATE` on the `gift_code` row**, as the first statement of the transaction. Every
   redeemer of one code serialises there, which is what makes the global cap a count rather than a
   race — the same argument ADR-0006 makes for the event row and capacity.
2. **`UNIQUE (gift_code_id, user_id, seq)`** is the per-user limit. `seq` is the 1-based ordinal of
   this person's redemptions of this code, allocated under the lock. A plain `UNIQUE (code, user)`
   could only ever express `per_user_limit = 1`; with an ordinal, one index expresses every limit.
3. **`coin_ledger.idempotency_key`**, derived as `gift-code:{codeId}:{userId}:{seq}`, is the
   exactly-once guarantee for the coins themselves.

Any one of the three stops the ordinary double-tap. All three are present because they fail in
different directions, and the one that turns out to be load-bearing on the day somebody refactors is
never the one you expected. `CHECK (redeemed_count <= max_redemptions)` is the backstop for the day a
future code path forgets guard 1 — it should never fire, which is exactly why the tests assert it
directly rather than only through the service that respects it.

**Lock ordering is `gift_code → coin_account`, never the reverse.** That is the second ordered pair in
the product after `event → coin_account`, and consistency is what keeps it deadlock-free (ADR-0006).

### Case-insensitivity is a property of the column

Codes are stored **already normalized** — upper-cased, spaces and dashes removed — by the same
`normalizeCode` referral codes use. «summer-24» and «SUMMER24» are therefore one row, decided by one
unique index, rather than a rule every query has to remember. `citext` would also work and is an
extension installed for one column's sake.

### Four refusals, not one

`GIFT_CODE_INVALID`, `GIFT_CODE_EXPIRED`, `GIFT_CODE_ALREADY_REDEEMED`, `GIFT_CODE_EXHAUSTED`. They are
separate because they are things a user can act on differently: retype it, ask for a new one, stop
trying, or discover they already have the coins.

`GIFT_CODE_INVALID` deliberately covers **both** "no such code" and "disabled", for the reason
`INVALID_REFERRAL_CODE` covers both "unknown" and "banned referrer": telling them apart turns the
endpoint into a way to enumerate which campaigns exist.

### Management is an admin operation, guarded by its own permission

`GiftCodeAdminService` lives in `adminaccess` — not with the redemption path — because it needs
`AdminAccessService`, and `AdminAccessModule` already imports `EconomyModule`. One service doing both
would make that import a cycle. `ChatUnsealService` makes exactly this split against `ChatModule`.

The permission is **`giftcode.manage`, held only by `SUPER_ADMIN`**. Minting coins out of nothing is
the same class of capability as `coin.adjust`, and ADR-0010's reasoning applies unchanged: the role
most exposed to "please just give them the coins" is the role that must not be able to.

Every method asserts the permission first and writes `audit_log` last (invariant 12). `redeemedCount`
against `maxRedemptions` on the list is the monitoring surface.

### Guessing is rate-limited harder than anything else a user does

`GIFT_CODE_REDEEM` is 10 an hour, against `PARTICIPATION_JOIN`'s 20 a day and `CHAT_SEND`'s 30 a
minute. This is the only endpoint in the product where **guessing pays**: a campaign code is short
enough to be typed by a human, therefore short enough to be enumerated by a script, and unlike a
referral code a hit credits coins rather than recording a relationship.

Refusals are also counted — `payetam_gift_code_redemptions_total{result}` — because a burst of
`invalid` leaves no row anywhere and is the only externally visible sign of a sweep. The ledger already
records everything that succeeded; a counter would be a worse copy of it.

## Consequences

**Positive**
- The reconciliation test keeps passing without knowing gift codes exist.
- Every limit is enforced by a constraint, so the service being wrong is not sufficient to double-credit.
- A campaign is retunable and killable with no deploy — the same property ADR-0007 gives every other
  policy number.
- The admin API can create, disable, list and monitor codes today, with no panel.

**Negative**
- **There is no admin panel to drive it from** (blocker B2 is still open). Codes are managed over
  `admin/v1` with a session cookie and a CSRF token, which in practice means `curl` or a script until
  B2 closes. Documented in the project review; not a reason to defer the backend.
- No bulk minting, and no per-code analytics beyond a redeemed count. Both are additive.
- `perUserLimit > 1` is supported and probably unwise; the default is 1 and the schema comment says so.
- A code's coin amount is snapshotted onto the redemption row, so retuning `gift_code.coins` does not
  rewrite history — which is correct, and means the list's `coins` and an old ledger row can disagree.

## Alternatives considered

- **A `promotion` table with a discount percentage.** Rejected: the product has no prices to discount.
  Coins are the currency and a code that grants coins is the whole feature.
- **Reuse `ADMIN_ADJUSTMENT` for the ledger type.** Rejected: it makes "how much did the launch
  campaign cost us?" unanswerable without joining on metadata, and conflates an automated grant with a
  human decision somebody signed.
- **`UNIQUE (gift_code_id, user_id)` with no ordinal.** Simpler, and cannot express a multi-use code.
  Adding the column later would mean backfilling a unique index on a table with live rows.
- **An advisory lock keyed on the code, instead of a row lock.** Equivalent under contention and worse
  to reason about: the row already exists and already has to be read.
- **Trusting the idempotency key alone.** It is sufficient for the double-tap and says nothing about
  the global cap, which is the limit an operator actually cares about.
