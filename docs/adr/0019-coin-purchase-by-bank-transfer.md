# ADR-0019: Coins are bought from a person, by bank transfer

- **Status:** Accepted
- **Decides:** amends the "coins are never priced in toman inside the product" position held by
  `economy.coin_reference_price_toman`; bound by ADR-0007 (append-only ledgers) and ADR-0010
  (every mutating admin action authorised in the service layer and audited)
- **Invariant owned:** none. It deliberately introduces no new state.

## Context

`docs/coin-economy-plan.md` is a complete revenue model — packages, prices, a buyer window, a
monthly revenue table, «میانهٔ روز تا اولین خرید». The v0.11.0 rebalance shipped the **spend**
side of it: join costs, create costs, earning caps, the host deposit. The **entrance** was never
built, and nothing in the tree referred to it.

What that meant for a user is sharper than "a missing feature". Every route to a coin in this
product is an earning — onboarding gift, referral, review reward, gift code, founding tier,
comeback grant — and every one of them is capped, most once per lifetime. Somebody who spent to
the end of that was not offered anything. They were shown a balance, a price they could not pay,
and no way to change either. `CoinLedgerType` has sixteen members and not one of them means a
purchase, so the product could not have recorded a sale if somebody had insisted on making one.

So coin revenue was zero for a reason that was not pricing and not demand: the product never
mentioned that buying was possible.

Meanwhile the mechanism had already been decided. Plan §6 prices four packages, and plan §10
answers the "how" without a gateway at all: a bank transfer, confirmed by the operator in their
banking app, granted through `POST /admin/v1/coins/adjust` with the bank's tracking number in
`reference` — idempotent through `adminAdjustmentKey`, so one receipt can never pay twice. §12
puts a ceiling on it: **above 400 transactions a month, that stops being tenable** and a payment
gateway becomes mandatory. Today the product is nowhere near that number.

What breaks if we get this wrong is not a bug. It is either taking somebody's money with no
record of why, or building a payment integration — with a merchant account, a refund obligation
and a legal answer to "is a coin a prepayment or a good" — for a volume that does not exist.

## Decision

**The bot shows a price list. It never takes money, and it records no order.**

1. **A screen, reached from the wallet.** `/wallet` grows one button, «🪙 خرید سکه», which
   redraws the message as a price list: four tiers, each with its coin count, its toman price and
   what one coin costs in it; the reference price as the anchor above them; three steps telling
   the reader to message a person, transfer, and send the tracking number.
2. **`COIN_PURCHASE_CONTACT` is the feature switch.** Unset, the button is not drawn and the
   screen refuses. Purchase is a human being confirming a deposit, so "is there somebody on the
   other end" and "is buying open" are the same question, and a deploy must not be able to open a
   money channel nobody is watching.
3. **Prices are settings, not code.** Eight `app_setting` rows — coins and toman for each of the
   four tiers. Plan §6 requires a quarterly price revision to be a settings change and nothing
   else, «نه یک عدد داخل ربات، نه یک تست، نه یک دیپلوی». A zero on either side of a tier takes it
   off the screen, which is how one is retired without a release.
4. **The grant stays where it already was.** The operator sees the deposit in their bank app and
   credits the account from the panel with the tracking number as the reference. No new endpoint,
   no webhook, no `coin_purchase` table — because **no order exists**. The only records of a sale
   are the bank's and the `coin_ledger` row that follows it, and that row is already immutable,
   already audited and already idempotent on the reference.
5. **Toman appears on exactly one screen.** Everything the product *charges* stays priced in
   coins. This is the one place a toman figure is quoted, and it is quoted for a payment that
   happens outside the product entirely.

## Consequences

**Positive**

- The economy has an entrance. The answer to "I have run out" stops being a wall.
- Nothing to reconcile. There is no pending state, no half-finished checkout, no webhook that can
  arrive twice, and nobody stuck in a flow they walked away from — the cheapest correct version
  of this feature is the one that stores nothing.
- The defence against a forged receipt is the only one that works: a person looking at their own
  bank app before anything is granted. An automated flow would have to be *taught* that rule; this
  one cannot skip it, because there is no code path that grants a coin.
- A price revision costs no deploy, so inflation is absorbed where the plan wanted it absorbed.

**Negative — accepted, not solved**

- **It does not scale, and we know the number.** Roughly 11 transactions a day is tolerable at
  five minutes each; **400 a month is the ceiling**, and past it this ADR is superseded by one
  that names a gateway. That is a deliberate deferral, not an oversight.
- **The operator is a single point of failure.** Nobody can buy while they are asleep, and the
  screen says so only by implication. Acceptable while the operator and the founder are the same
  person.
- **No refund path.** Ledgers are append-only (ADR-0007), so a reversal would be a `REVERSAL` row
  written by hand. Untested, because nothing has been sold yet.
- **A personal account receiving 300+ transfers a month is visible**, as plan §10 says. Out of
  scope here and unchanged by this ADR — it is a decision about who owns the account, and it has
  to be answered before month nine rather than after.
- **`economy.coin_reference_price_toman` stops being reporting-only.** Its own comment said
  nothing in the product should work in toman. This screen does, on purpose, and that comment is
  amended rather than quietly contradicted.

## Alternatives considered

**A payment gateway now (Zarinpal or similar).** Genuinely close, and rejected on sequencing
rather than on merit. It needs a merchant account, an owner for it, and an answer to whether a
purchased coin is a prepayment — plan §6 promises that a bought coin is immune to inflation,
which is a commitment, and a commitment is a liability with a right of refund attached. Plan §12
says the volume that forces this question has not arrived. Building it first would mean answering
a legal question in order to serve a demand we have not yet observed.

**A `coin_purchase` table and an approval queue in the panel.** The shape plan 02 originally
sketched, and it is the right design *for an order*. There is no order: nothing is reserved,
nothing is promised, and a person who changes their mind after reading the prices leaves nothing
behind. A PENDING row per reader would be a queue of abandoned intentions for the operator to
clear, and a second place for "was this paid?" to disagree with the ledger. If the grant ever
becomes automatic, this is the first thing to add back.

**A new `PURCHASE` member on `CoinLedgerType`.** Cleaner to report on than `ADMIN_ADJUSTMENT`
filtered by a `sale:` prefix, and deferred for one reason: a new enum member is a migration, and a
migration for a distinction only a report reads is not worth spending while the number of sales is
zero. Plan §6's `reason` convention answers "what did we earn this month" as a single query today.
Worth revisiting the first month the report is read in earnest.

**Reusing `SUPPORT_CONTACT`.** One handle probably answers both today. Rejected because that key
is set on every environment that can ban an account, so reusing it would have opened purchases
everywhere the moment this shipped. Opening a money channel should be something somebody did on
purpose.

**Publishing the card number on the screen.** Fewer steps for the buyer, and rejected: it puts a
personal account number in front of every user of the bot, in a message that is forwardable, on
the one screen a scammer would most want to imitate. The number is given in the conversation where
somebody has already said which package they want.
