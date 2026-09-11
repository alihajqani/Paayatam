import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';

/**
 * Reads policy numbers out of `app_setting`.
 *
 * ADR-0007 and ADR-0011: every tunable number in the product — reward amounts,
 * penalty thresholds, the report threshold, ranking weights — lives in the
 * database so tuning is a config change rather than a deploy.
 *
 * The defaults below are not a second source of truth. They are what the system
 * does when a row is missing: on a fresh database, before the seed has run, or
 * after someone deletes a key by hand. The alternative — throwing — would mean a
 * missing config row takes onboarding down, which is a worse failure than
 * granting the documented default. Every default here matches plan §11.
 */
export const SETTING_DEFAULTS = {
  /**
   * Coins granted once, when a user first completes their profile.
   *
   * **Thirty-five since the economy rebalance**, down from fifty, and the number
   * is chosen against the **effective** price of an activity rather than on its
   * own. That effective price is `event_join_coins - review_reward_coins` —
   * fifteen at today's numbers — because somebody who joins also writes the
   * review, which is how the runway actually plays out: 35 → 20 → 5, two
   * evenings, dry around day 30.
   *
   * Read against the sticker price of twenty it looks like one activity and
   * fifteen wasted coins, and that reading is what makes this setting easy to
   * get wrong: two is the smallest number of evenings from which a person can
   * tell whether they want a third, and one is somebody meeting the product once
   * and leaving without ever seeing the pattern.
   *
   * So this number depends on **two** others. An operator who raises the join
   * price, or drops the review reward to zero, and leaves this alone has
   * shortened the free runway without touching it — which §10 names as one of
   * the two things that invalidate the whole plan.
   */
  'economy.onboarding_reward_coins': 35,

  /**
   * The launch campaign: the first N members to complete a profile get a
   * permanent rank, a tier and a one-time grant that declines by tier (v0.9.0).
   *
   * The declining schedule is deliberate and is the campaign's only urgency
   * mechanism: it makes arriving early worth something, throttles demand to
   * match how fast supply is being built, and turns each tier filling up into
   * something worth announcing.
   *
   * **The amounts are small on purpose, and are now much smaller.** They were
   * 150/80/40, which at today's prices is seven free activities for tier 1 and a
   * campaign that gives away about a month of the revenue target before the
   * product has earned a rial of it — to precisely the people who have not yet
   * shown they will stay. 30/20/10 keeps the 3:2:1 spacing and costs a seventh of
   * that.
   *
   * A grant large enough to feel like a prize would also be large enough to make
   * `cancellation.coins_lt_3h` free, and that penalty is the only thing standing
   * between the product and a no-show problem. What is actually scarce here is
   * the rank itself: there will only ever be `founding_campaign.max_rank` of
   * them, and minting one costs nothing — which is why the campaign's real prize
   * is the rank and the badge rather than the coins beside them.
   *
   * The cap is **not** here — it is `founding_campaign.max_rank`, because the
   * allocator has to read it under the same row lock that increments the
   * counter. See the model's comment.
   *
   * **Off by default, and that is the important one.** A rank is irreversible:
   * the counter never moves backwards, so every rank handed out before the
   * campaign was meant to start is one that cannot be given to the person it was
   * promised to. Defaulting this on would mean the campaign begins the moment
   * the code ships — if the deploy is on a Tuesday and the announcement is on
   * Friday, ranks 1 through 40 go to whoever happened to sign up in between, and
   * there is no way to take them back. An operator turns it on when the campaign
   * actually opens.
   *
   * The same discipline `economy.event_join_coins` follows in the schema: the
   * feature ships inert and a price, or here a campaign, starts when somebody
   * decides it does.
   */
  'founding.enabled': 0,

  /**
   * Say which cities are open, on the profile form's province step (v0.9.1).
   *
   * A switch, not the sentence: the copy lives in `edit-profile.ts` with every
   * other prompt, and what an operator needs on the day a third city opens is to
   * stop showing a sentence that has stopped being true — without a deploy.
   *
   * **Defaults to 1**, unlike `founding.enabled`, and the asymmetry is the
   * point. A rank is irreversible so the campaign ships inert; a sentence is
   * not, and the harm runs the other way — the catalogue is trimmed to two
   * provinces *today*, so shipping this off would mean a live product showing
   * two buttons and no reason for a whole release cycle.
   */
  'profile.location_notice': 1,

  /**
   * How many completed profiles open a city (v0.10.0).
   *
   * The number a person in a closed city is told they are counting towards, so
   * it has to be the *real* threshold rather than an aspiration — somebody who
   * watches their city reach 100 and stay shut has learned the product lies.
   *
   * Tunable because the right number is not knowable yet: 100 is the point at
   * which a single activity can plausibly fill from one city (see the liquidity
   * arithmetic in the launch plan), and the first city to actually cross it will
   * say whether that holds.
   */
  'city.launch_threshold': 100,
  'founding.tier1_max_rank': 100,
  'founding.tier1_coins': 30,
  'founding.tier2_max_rank': 400,
  'founding.tier2_coins': 20,
  /**
   * The last tier's boundary should match `founding_campaign.max_rank`. It is
   * restated here because the tier lookup is arithmetic over these six numbers
   * and needs an upper bound of its own; a rank past it gets the last tier
   * rather than no tier, so the two drifting apart degrades the labelling rather
   * than losing anybody their membership.
   */
  'founding.tier3_max_rank': 1000,
  'founding.tier3_coins': 10,

  /**
   * The referral pair (plan §11), paid only after the referred user **attends**
   * an event — not on signup. A referral that pays out for creating an account
   * pays out for creating accounts (T6).
   *
   * The referrer's half is **capped** as well as priced: `economy.referral_reward_cap`
   * referrals in `economy.earning_cap_days`. Uncapped, this was the largest
   * farmable source in the product — the attendance condition bounds how *fast* a
   * farm can run, not how *big* it can get, and a person with thirty willing
   * friends could mint six hundred coins in a month without breaking a rule.
   *
   * The referred user's ten are deliberately **not** capped. They are paid once
   * per lifetime by construction (`referral.referred_user_id` is UNIQUE), so
   * there is nothing to cap, and a cap that could withhold them would punish the
   * newcomer for the popularity of whoever invited them.
   */
  'economy.referral_referrer_coins': 20,
  'economy.referral_referred_coins': 10,

  /**
   * What the paid actions on an activity cost (M22 phase 5).
   *
   * Here rather than as constants for the reason §11 gives about every other
   * number in this table: an operator who finds that the price is too steep for
   * a first event has to be able to change it without a deploy, and a price that
   * only exists in a compiled bundle cannot be changed at all.
   *
   * **This is a deposit, not a fee**, as of the economy rebalance:
   * `economy.host_deposit_refund_coins` gives it back when the activity is
   * actually held. Supply is the scarce side of this marketplace and a host who
   * turns up should be net positive in coins; what the charge is really pricing
   * is the *ghost* activity, which is registered, listed, never held, and costs
   * every guest who planned an evening around it.
   *
   * **Zero is a legitimate value and means free**, which is how the feature is
   * rolled back: set `economy.event_create_coins` to 0 and creating an event stops
   * costing anything, with no code path removed and no migration. The services
   * skip the ledger write entirely at zero, so a free action leaves no row
   * claiming somebody paid nothing.
   */
  'economy.event_create_coins': 10,
  /**
   * The channel publication a new activity gets by default.
   *
   * Charged **with** `event_create_coins` in the same transaction, so registering
   * an activity costs `10 + 15 = 25` and puts it in the channel without the host
   * asking. Two settings rather than one `event_register_coins`, because the two
   * halves buy different things and an operator has to be able to price them
   * apart — and because the create charge already exists in the ledger under its
   * own type, which a merged number would have made unreadable.
   *
   * **The split is deliberately not shown to the user.** The bot quotes the sum
   * and stops; a host choosing between two line items they cannot decline is a
   * choice that does not exist. What the bot *does* now say beside the sum is
   * that it comes back if the activity happens — the difference between «۲۵ سکه
   * هزینه دارد» and «۲۵ سکه سپرده است» is the difference between having hosts and
   * not having them.
   */
  'economy.event_channel_publish_coins': 15,
  /**
   * Renewing a channel post — publishing the same activity again so it is seen
   * again. Cheaper than the original publication because the activity is already
   * in the channel's history; what is being bought is position, not reach.
   */
  'economy.event_channel_send_coins': 8,
  'economy.event_top_invite_coins': 30,
  /**
   * What asking to join an activity costs (v0.6.3; five from v0.7.0, **twenty
   * since the economy rebalance**).
   *
   * It shipped at zero, deliberately: joining had been free on every surface
   * since M6, and the channel post's «پایتم» button reaches the same
   * `ParticipationService.join` the in-bot button does, so a non-zero default
   * would have started charging for every join everywhere as a side effect of
   * adding a button to a channel post. The price existed so an operator could
   * set one without a deploy.
   *
   * Five was the product's first answer, and it was the wrong one: joining cost
   * five and reviewing the same activity paid ten, so every attendance left a
   * user **five coins richer**. The economy was a spring, not a sink, and no
   * amount of pricing elsewhere could fix a loop that pays more than it takes.
   *
   * Twenty is the backbone of the whole model. It is anchored to the evening
   * rather than to the software: going out costs 200–500 thousand toman in a café
   * and transport, and twenty coins is about 19 thousand — four to ten per cent of
   * a night out, less than the fare to get there. The rule that produced it, and
   * the one to keep if this ever moves: **a coin price never exceeds ten per cent
   * of what the activity itself costs the person.**
   *
   * With `economy.review_reward_coins` at five, the effective price of an
   * activity is fifteen, which is a 25% discount for writing a review rather than
   * a payment for consuming.
   *
   * **When the market is thin, lower this — never raise it.** If fill rate drops
   * below 60%, the problem is supply and every price is too high; the emergency
   * lever is this key back to 10, which is one settings change and no deploy.
   *
   * **Zero still works and still means free** — the service skips the ledger
   * write entirely, because `coin_ledger.amount` may not be zero and a row
   * claiming somebody paid nothing is worse than no row. That is the rollback.
   *
   * A waitlisted request is charged like an accepted one, and deliberately: what
   * is being paid for is the *ask*, which consumes the host's attention whether
   * or not a seat was free.
   *
   * **A rejected or expired request is refunded** — `refundJoinCharge` in
   * `ParticipationService`, since v0.8.1. This paragraph used to say the opposite
   * and was stale; only the guest's own withdrawal keeps the charge now. A
   * **host** cancelling the whole activity refunds it too, through
   * `PenaltyService.refundParticipant`, which reverses every charge whose subject
   * is that participation.
   */
  'economy.event_join_coins': 20,

  // ── The earning caps, and the three sources they bound ─────────────────────
  //
  // §2's first principle: **every grant must be finite and non-renewable.** Three
  // sources in this product are neither — a review per activity, a referral per
  // friend, a hosting bonus per event — and each grows with exactly the activity
  // the product is trying to encourage. That is not a reason to remove them; it
  // is a reason to put a ceiling on them.
  //
  // One window, three ceilings. A key per window would be three numbers an
  // operator has to keep equal, and the first one that drifts is the one nobody
  // reads.
  //
  // The three together are the answer to "how much can somebody who farms this
  // full-time take out?" — 60 from referrals, 20 from reviews, 20 from hosting,
  // so **100 coins a month, five activities**. That is the number §12 says to
  // measure: if the top earner in any thirty days is above it, a cap has been
  // left off something.

  /**
   * The rolling window every earning cap is measured over.
   *
   * Rolling rather than calendar, and deliberately: a calendar month resets at
   * midnight on the first, which turns a cap into a race and rewards whoever
   * noticed. A window that always looks back thirty days has no edge to game.
   *
   * **Zero disables every cap at once**, which is the rollback for all three in
   * one move — the services skip the whole lookup at zero rather than treating it
   * as a zero-length window that refuses everything.
   */
  'economy.earning_cap_days': 30,
  /** Coins from reviews inside `economy.earning_cap_days`. Four reviews a month. */
  'economy.review_reward_cap': 20,
  /**
   * **Referrals**, not coins, inside the window — the one cap counted in events
   * rather than in currency.
   *
   * Because the referrer's price is a separate setting an operator may move: a
   * cap of 60 coins would silently become "two referrals" the day
   * `economy.referral_referrer_coins` went to 30, and "how many friends may I
   * bring this month?" would have a different answer than anybody intended. Three
   * referrals is three referrals whatever they pay.
   *
   * At the default of 20 coins each this is 60 coins a month, which keeps
   * referrals comfortably the best way to earn — which is correct. Bringing
   * somebody who stays is worth more to this product than anything else a user
   * can do.
   */
  'economy.referral_reward_cap': 3,

  // ── Hosting: the deposit, and what makes it come back ──────────────────────
  //
  // §2's third principle: **supply is subsidised, demand pays.** Hosts are the
  // scarce side. A host who shows up should be net *positive* in coins and should
  // never be forced to buy any — if hosting is expensive there are no activities,
  // and with no activities nobody buys anything at any price.
  //
  // So `economy.event_create_coins` + `economy.event_channel_publish_coins` is a
  // deposit rather than a fee, and this is the half that returns it.

  /**
   * The registration deposit, returned when the activity was actually held.
   *
   * Matches `event_create_coins + event_channel_publish_coins` at the defaults
   * (10 + 15 = 25), and is a **separate key rather than a computed sum** for two
   * reasons: an operator has to be able to return less than was charged (a
   * partial deposit is a legitimate policy), and the sum is the *price today*
   * while a refund is about a charge made weeks ago.
   *
   * `HostRewardService` floors it at what the host was actually charged for that
   * specific event, read back from the ledger. Without that floor, raising this
   * above the registration price would turn hosting into a mint — and the check
   * is structural rather than a rule somebody has to remember.
   */
  'economy.host_deposit_refund_coins': 25,
  /** On top of the deposit, per guest who actually turned up. */
  'economy.host_reward_per_attendee_coins': 2,
  /**
   * How many guests must have attended before any of it is paid.
   *
   * Two, not one: one guest is a coffee with a friend, and a bonus that pays at
   * one is a bonus two people can trade back and forth all month. It is also the
   * point below which "was this a real activity?" stops being answerable from the
   * numbers alone.
   */
  'economy.host_reward_min_attendees': 2,
  /**
   * The per-guest bonus inside `economy.earning_cap_days`. **The deposit refund
   * is not counted against it** — returning what somebody paid is not earning.
   */
  'economy.host_reward_cap': 20,

  // ── The comeback grant ─────────────────────────────────────────────────────

  /**
   * One grant, once in an account's life, to somebody who has run out.
   *
   * The user this is for is specific and worth naming: they have been to at least
   * two activities, they behaved well enough for a trust score above the
   * threshold, and they now cannot afford a third. Every number in the plan says
   * that person should be converting to a purchase — and the honest reading of
   * why they might not is that the first payment is the hardest thing this
   * product ever asks for. This is the last thing offered before they leave.
   *
   * Not a retention loop: the ledger's UNIQUE `idempotency_key` on
   * `comeback:{userId}` makes "once in a lifetime" structural rather than a
   * counter somebody could reset. **Zero switches it off.**
   */
  'economy.comeback_grant_coins': 20,
  /** Attended activities required. Proof they used the product, not just joined it. */
  'economy.comeback_min_attended_events': 2,
  /**
   * Trust required.
   *
   * Above the 50 an account starts at, so it cannot be met by doing nothing, and
   * comfortably below what two clean attendances reach. Somebody who no-showed
   * their way to a low score is not who this grant is for.
   */
  'economy.comeback_min_trust': 55,

  /**
   * The reference price of one coin, in toman. **Reporting only.**
   *
   * Nothing in the product charges toman and nothing ever should: prices inside
   * the bot are in coins, always, and inflation is applied to the *package price*
   * outside the product. That is the single most structural decision in the
   * pricing plan — 950 becomes 1,200 becomes 1,500 without one number in the bot
   * changing and without any user seeing "the service got more expensive".
   *
   * It exists here so the panel's economy report can put a toman figure beside a
   * coin figure. Change it when the package prices are revised, and understand
   * that doing so re-prices **history** on that report: it is a conversion rate
   * applied at read time, not a rate anything was sold at.
   *
   * ── One thing charges nothing and still shows it (ADR-0019) ────────────────
   *
   * The purchase screen anchors on this number: «هر سکه حدود ۹۵۰ تومان» above a
   * table whose cheapest tier is 1,000. That is the comparison plan §6 designed
   * and it is still not a price — nothing is charged here, and the only toman
   * figure the product ever quotes is the package price a person pays a human
   * being by bank transfer. Everything the bot *sells* is priced in coins.
   */
  'economy.coin_reference_price_toman': 950,

  /**
   * The four packages somebody can buy, in coins and in toman (ADR-0019).
   *
   * ── Why eight numbers and not a table ───────────────────────────────────────
   *
   * `app_setting` holds numbers, one per row, and the alternative — a JSON blob
   * or a `coin_package` table — would buy a variable number of packages at the
   * cost of the only property that matters here: the economy plan requires a
   * price revision to be **a settings change and nothing else**, «نه یک عدد داخل
   * ربات، نه یک تست، نه یک دیپلوی». Four is the number the plan designed, and
   * four fits on a phone screen; a fifth is a deploy, and it should be, because
   * a fifth tier is a pricing decision rather than a price change.
   *
   * ── The ladder is a shape, not four independent numbers ────────────────────
   *
   * The small package is deliberately **above** the reference price. Its job is
   * to make the medium one look cheap — that is the whole of its role in plan
   * §6, and raising it is not a mistake to be corrected. The medium is the one
   * meant to carry 40% of sales and is the only one marked on the screen.
   *
   * ── Zero hides a package ────────────────────────────────────────────────────
   *
   * Either number at zero takes that row off the screen, which is how a tier is
   * retired or a promotion run without a release. All four at zero, or no
   * purchase contact configured, and the screen is not offered at all.
   *
   * Inflation is applied **here**, quarterly, and never inside the bot: a coin
   * costs what it costs in coins, and 950 becoming 1,200 changes this table and
   * nothing a user sees priced. The useful side effect the plan names is that a
   * coin already bought is immune to that — «قبل از گران‌شدن بخر» is an honest
   * sales argument, and the only place inflation works in this product's favour.
   */
  'economy.package_small_coins': 45,
  'economy.package_small_toman': 45_000,
  'economy.package_medium_coins': 110,
  'economy.package_medium_toman': 99_000,
  'economy.package_large_coins': 250,
  'economy.package_large_toman': 209_000,
  'economy.package_season_coins': 600,
  'economy.package_season_toman': 469_000,
  /**
   * How many people one paid invitation reaches (phase 11).
   *
   * A setting rather than the literal 20 the requirement names, because the
   * price and the reach are tuned against each other and changing one without
   * the other is how a promotion stops making sense. The selector never returns
   * more than this however many candidates qualify.
   */
  'events.top_invite_max_recipients': 20,

  /**
   * How the top-20 selector ranks candidates (phase 11).
   *
   * In `app_setting` for §11's reason — "all tunable numbers in the database" —
   * and because this particular set is a *product experiment*: whether previous
   * attendance in the same category predicts turnout better than living in the
   * right city is a question the numbers should be able to answer without a
   * deploy.
   *
   * The scale is arbitrary and the ordering is not. Every term is bounded, the
   * total is bounded, and the score is a plain sum — so "why was this person
   * chosen?" is answered by a breakdown stored beside the invitation rather than
   * by re-running a model. **Nothing here uses an attribute the product does not
   * already collect for another purpose**, and nothing infers one.
   */
  'invite.weight_same_city': 30,
  'invite.weight_interest_match': 20,
  'invite.weight_category_history': 25,
  'invite.weight_recent_activity': 15,
  /** Trust contributes at most this much, scaled by the 0–100 score. */
  'invite.weight_trust': 10,
  /**
   * Subtracted from anybody invited to *anything* recently.
   *
   * The one term that pushes down rather than up, and the reason it exists is
   * that a good score is otherwise self-reinforcing: the same twenty people would
   * be picked for every event until they muted the bot. A penalty is cheaper than
   * a quota and needs no second table.
   */
  'invite.penalty_recent_invite': 20,
  'invite.recent_invite_days': 14,
  /** How recently somebody must have taken part to count as active. */
  'invite.recent_activity_days': 30,

  /**
   * Where a new account starts (plan §11). The 0–100 *range* is deliberately not
   * here: ADR-0007 writes it into the schema as a CHECK, and a configurable clamp
   * over a fixed constraint would be a setting whose only possible effect is a
   * constraint violation.
   */
  'trust.initial_score': 50,
  /** Completing a profile is the first thing that moves the score (plan §11). */
  'trust.profile_complete_delta': 5,

  /**
   * Referral velocity, recorded in `fraud_signals` rather than enforced.
   *
   * T6 asks for velocity limits and for `fraud_signals` for admin review, and the
   * order matters: a false positive here silently steals somebody's reward, so
   * this flags for a human instead of refusing. The real control is that the
   * reward requires an attended event, which does not scale to a farm.
   */
  'referral.velocity_window_hours': 24,
  'referral.velocity_threshold': 10,
  /**
   * How long after signing up a referral code may still be entered (v0.7.0).
   *
   * A referral code is an *invitation*, and what it is supposed to reward is
   * bringing somebody new. Without a window it equally rewards an account that
   * has been here for months typing a friend's code — which costs the friend
   * nothing, pays them thirty coins, and is an arrangement between two existing
   * users rather than a recruitment.
   *
   * Seven days is long enough that somebody who joined, looked around and only
   * then found the link they were sent can still use it; short enough that an
   * established account cannot.
   *
   * **Zero means no window**, which is the rollback. Measured from
   * `user.created_at`, the one timestamp a claimer cannot influence.
   */
  'referral.claim_window_hours': 168,
  /** The legal minimum age for the platform. Enforced at profile write (plan §4.1). */
  'profile.min_age_years': 18,
  /** Events a host may create in one Tehran day (plan §11, T6.1). */
  'events.max_per_day': 5,
  /** Upcoming, non-retired events a host may hold at once (plan §11). */
  'events.max_concurrent_active': 3,

  /**
   * How long a host has to decide, and how close to the event a decision still
   * means anything: the deadline is `min(now + 24h, starts_at - 3h)` (plan §11).
   * Both matter because a PENDING request holds a seat — these numbers bound how
   * long an undecided request keeps one out of circulation.
   */
  'participation.host_response_hours': 24,
  'participation.min_hours_before_event': 3,
  /**
   * The floor under a host's decision window (v0.7.0).
   *
   * `min(now + 24h, starts_at - 3h)` goes **negative** for an activity starting
   * in under three hours, and the request was then born already expired: the
   * guest was told it had been sent, the host was notified with two buttons, and
   * whichever of them pressed first was refused with «این عملیات در وضعیت فعلی
   * ممکن نیست» about a state nobody had chosen.
   *
   * Thirty minutes is short, which is correct — the activity is soon — but it is
   * a window, and both sides can act inside it. Bounded by the start of the
   * activity itself, so this can never push a deadline past the thing being
   * decided about.
   */
  'participation.min_response_minutes': 30,
  /** Cancel within this many minutes of being accepted and it costs nothing. */
  'participation.grace_minutes': 15,

  /**
   * The promoted-request deadline: `min(now + 12h, starts_at - 3h)` (ADR-0011).
   *
   * Shorter than the 24 hours a fresh request gets, and deliberately so — a
   * promotion happens because a seat came free, which is later in the event's
   * life and leaves less room to dither. Separate keys from the
   * `participation.*` pair above even though the second number matches today,
   * because ADR-0011 names them separately and they are tuned against different
   * things.
   */
  'waitlist.promotion_deadline_hours': 12,
  'waitlist.min_hours_before_event': 3,

  /**
   * What a cancellation costs, by how late it was (plan §11, M10).
   *
   * Stored as **positive magnitudes**, negated at the point of charge. A signed
   * default is a setting an admin can accidentally make a *reward* by dropping a
   * minus sign, and "how much does a late cancellation cost?" is a question whose
   * answer should never be negative.
   *
   * `GRACE` is absent on purpose rather than present as a zero: the fifteen
   * minutes after being accepted are free by construction, and a key holding
   * zero would invite somebody to price a window the product promises is free.
   *
   * **`GT_24H` is now priced** (v0.7.0). §11 left it out and the product read
   * that as "a cancellation more than a day out costs nothing" — which, since
   * most activities are created a few days ahead and cancelled within hours of
   * being joined, meant most cancellations cost nothing at all. That is the
   * report: coins are not deducted when somebody drops out. Five is a token
   * rather than a deterrent, and the trust cost stays at zero, because standing
   * down early is the *good* version of not coming and should not damage a
   * reputation.
   *
   * **Rollback is a config change, no deploy**: set these to 0 and cancellation
   * stops costing anything, which is exactly what the plan's rollback line asks
   * for.
   */
  'cancellation.coins_gt_24h': 5,
  'cancellation.trust_gt_24h': 0,
  'cancellation.coins_h24_to_h3': 15,
  'cancellation.trust_h24_to_h3': 3,
  'cancellation.coins_lt_3h': 40,
  'cancellation.trust_lt_3h': 8,
  'cancellation.coins_no_show': 60,
  'cancellation.trust_no_show': 15,

  /**
   * The host's side (ADR-0011, D9).
   *
   * The multiplier applies to whatever a *participant* would have paid for the
   * same lateness, because one host cancellation harms N people rather than one.
   * It is a fraction, so it is read with `getNumber`; the two trust numbers are
   * the host's own and are not derived from the participant table at all — §11
   * splits them at 24 hours only, where a participant has three buckets.
   */
  'cancellation.host_penalty_multiplier': 1.5,
  'cancellation.host_trust_gt24h': 5,
  'cancellation.host_trust_lt24h': 12,

  /**
   * Attending something is the one routine way a score goes up (plan §11: +2,
   * capped at +2 per day).
   *
   * The cap is what stops a host and a friend running six events a day to farm
   * reputation off each other — the same reasoning that puts the referral reward
   * behind an attended event (T6).
   */
  'trust.attendance_delta': 2,
  'trust.attendance_daily_cap': 2,

  /**
   * The blind-review window (ADR-0011, D7). Measured from the event's **end**.
   *
   * ── Why the delay is now zero (v0.7.0) ──────────────────────────────────────
   *
   * It was 24 hours, on the argument that a review written in the car park is a
   * review of the last five minutes. That is true of the *review* and it was
   * false about the *product*: the window opens only once `settleAttendance` has
   * run, and that itself waits `participation.settlement_delay_hours` after the
   * end — so the two delays stacked, and a host whose activity finished on Friday
   * evening could not write a word about it until Sunday morning. What they saw
   * in the meantime was `/reviews` saying «نظر منتظری ندارید», which is the same
   * sentence it says when there is genuinely nothing, so the feature read as
   * broken.
   *
   * Zero means "as soon as attendance is settled", and the settlement delay —
   * two hours — is the only wait left. It is the one that earns its keep: it is
   * what gives a host time to report a no-show before the product decides
   * everybody turned up.
   *
   * Seven days to write one, and one hour to change your mind about what you
   * wrote.
   */
  'review.window_opens_hours': 0,
  'review.window_deadline_days': 7,
  'review.edit_window_minutes': 60,
  /**
   * D7a, and the one sub-decision the plan explicitly flags for override.
   *
   * At the deadline with only one side written, that review **is** revealed —
   * the reviewer's effort stays visible — but by default it does not move the
   * score, because somebody who never reviewed cannot have their reputation moved
   * by a counterparty they had no opportunity to answer. Set this true to change
   * that, with no deploy.
   */
  'review.partial_reveal_affects_trust': 0,
  /**
   * Coins for writing one. Paid on submission — see `ReviewService`.
   *
   * **Five, and capped**, since the economy rebalance. It was ten, against a join
   * price of five, which made every attended activity net *positive* for the
   * guest: this single pair of numbers is why coin revenue was zero, and it was
   * not the price and not the missing payment gateway.
   *
   * Five against twenty is a different thing entirely — a 25% rebate for writing
   * rather than a wage for consuming. The incentive that actually carries reviews
   * is not the coins at all: reviews are blind, and writing one is how you get to
   * *see* what the other side wrote about you (D7). That is stronger than any
   * number here, which is why halving this is safe and zeroing it would not be.
   *
   * `economy.review_reward_cap` bounds the total over
   * `economy.earning_cap_days`. Uncapped, this is a source that grows with
   * activity and has no ceiling — one activity, one review, five coins, forever —
   * and §2's first principle is that no such source may exist. Twenty coins a
   * month is four reviews, which is more than an ordinary member writes and less
   * than a ring of friends running fake activities needs.
   *
   * **Watch the review rate for two weeks after changing this.** If it falls
   * below 50%, the trust signal is degrading and this should go to seven — the
   * reviews are what separate this product from a group chat.
   */
  'economy.review_reward_coins': 5,
  /**
   * What a star is worth to the person receiving it (plan §11).
   *
   * Stored **signed**, unlike the cancellation penalties: these are not "how much
   * does it cost", they are "which way does it move", and a table where three of
   * five entries are negative reads more honestly with the signs in it than with
   * a magnitude and a rule about when to negate.
   */
  'trust.review_rating_5': 3,
  'trust.review_rating_4': 1,
  'trust.review_rating_3': 0,
  'trust.review_rating_2': -2,
  'trust.review_rating_1': -5,

  /**
   * The channel (plan §1, M14).
   *
   * `enabled` is a kill switch rather than a feature flag: a public surface the
   * product cannot stop writing to is a public surface that keeps posting through
   * an incident. `1` is on, `0` is off, and it is read on every pass.
   *
   * The trending threshold is deliberately a *request* count rather than a view
   * count — asking to join is a real signal a person produced, while a view is
   * mostly a measure of how often something was already shown.
   */
  'channel.enabled': 1,
  'channel.trending_request_threshold': 10,

  /**
   * Distinct reporters before a subject is auto-hidden and a case opened
   * (plan §11).
   *
   * Three is low on purpose. Hiding is reversible and a moderator decides what
   * actually happens; what the automation decides is only that enough people
   * objected for a human to look, and that in the meantime the thing should stop
   * being seen. `UNIQUE (target, reporter)` is what makes "three" mean three
   * people rather than three clicks.
   */
  'moderation.report_threshold': 3,
  /** How long a break-glass chat grant lasts (ADR-0010, T14: fifteen minutes). */
  'moderation.unseal_window_minutes': 15,

  /**
   * How long after an event ends before attendance is settled.
   *
   * A window rather than "immediately at the end": the host has to be able to
   * report a no-show, and nobody does that from the pavement outside the café.
   *
   * **Two hours since v0.7.0**, down from twenty-four. It used to match
   * `review.window_opens_hours`, and the two then stacked into a two-day wait
   * before anybody could review anything — the report that «بخش نوشتن نظر هیچ
   * چیزی نشان نمی‌داد». The review window is zero now, so this is the only delay
   * left: an evening ends, the host has the rest of it to say somebody did not
   * turn up, and by the next morning both sides can write.
   */
  'participation.settlement_delay_hours': 2,

  // Ranking weights (plan §11). Fractions, not integers — read with `getNumber`.
  // Trust is capped at 0.10 deliberately: §12 resolves "Trust Score in ranking"
  // against "no unfair discrimination" by keeping trust a tenth of the signal, so
  // a new host with a neutral score is never buried.
  'ranking.weight_time_proximity': 0.35,
  'ranking.weight_popularity': 0.2,
  'ranking.weight_recency': 0.15,
  'ranking.weight_trust': 0.1,
  'ranking.weight_interest_match': 0.05,

  /**
   * Gift-code campaign limits (M19, ADR-0016).
   *
   * ADR-0015 kept *every per-campaign* number on the `gift_code` row, and that is
   * unchanged: the coins, the window, the caps and the kill switch are columns,
   * because two simultaneous campaigns cannot share one setting. These two are
   * different in kind — they are **platform** limits on what a campaign may be,
   * which is exactly what §11 says belongs here.
   *
   * `max_batch_size` bounds one bulk mint. A thousand codes is a large campaign
   * and a synchronous request that still returns in well under a second; past it
   * the honest answer is a second batch, not a longer transaction holding a
   * unique index.
   *
   * `max_per_user_limit` is **1**, and it is a setting rather than a constant so
   * that raising it is a decision somebody makes, records and can undo — not a
   * deploy. ADR-0016 explains why 1 is the right default: a code redeemable twice
   * by one person is almost always a mistake, and the two protections that make a
   * campaign bounded (the global cap and the per-user limit) collapse into one
   * when the second is loosened.
   */
  'giftcode.max_batch_size': 1000,
  'giftcode.max_per_user_limit': 1,
  /**
   * The gift-code kill switch — `1` is on, `0` is off.
   *
   * A **platform** switch, which is what makes it belong here rather than on a
   * row: `gift_code.is_active` stops one campaign, and stopping one campaign is
   * not the thing an operator needs when a code has leaked to a channel with
   * forty thousand members and the answer is "no codes at all until we work out
   * what happened". Doing that today meant disabling every campaign one at a
   * time, in an order that leaves the last one live longest.
   *
   * Off refuses redemption on **every** surface — the bot's form, `/gift <code>`
   * and `POST /gift-codes/redeem` — because the check is in the service that owns
   * the act, which is where the channel-membership gate is and for the same
   * reason. Minting and disabling codes in the panel keep working while it is
   * off: an operator has to be able to clean up during the incident they turned
   * it off for.
   */
  'giftcode.enabled': 1,

  /**
   * Whether a deploy tells every user that it happened — `1` is on, `0` is off.
   *
   * The message is one sentence and one instruction («یک بار /start را بزنید»),
   * and it exists because a deploy silently invalidates things the user is
   * holding: reply-keyboard labels that moved, a half-finished wizard whose step
   * keys changed, inline buttons whose `callback_data` this build may no longer
   * parse. Without it, the release reaches people as «این دکمه دیگر کار نمی‌کند».
   *
   * A switch rather than a constant because a broadcast to the entire user base
   * is the single loudest thing this product can do, and an operator shipping
   * three hotfixes in an afternoon must be able to turn it off for the second
   * and third. `ReleaseAnnouncementService` reads it at boot, so flipping it
   * takes effect on the next deploy — which is exactly when it is decided.
   */
  'release.announce_enabled': 1,
} as const satisfies Record<string, number>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

@Injectable()
export class SettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * An integer policy number.
   *
   * Falls back to the documented default when the row is absent, and also when
   * the stored value is not an integer. A garbled `app_setting` row is an admin
   * mistake; letting it become `NaN` coins would turn that mistake into a
   * corrupted ledger, which no amount of later correction fully undoes.
   *
   * **Pass `tx` when reading inside a transaction.** Without it this borrows a
   * second connection from the pool while the caller still holds the first, and
   * N concurrent callers doing that exhaust the pool and wait on each other
   * forever. It shows up as "Unable to start a transaction in the given time" —
   * a message that describes the symptom and hides the cause completely.
   */
  async getInt(key: SettingKey, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return this.read(key, (value) => Number.isInteger(value), tx);
  }

  /**
   * A fractional policy number — a ranking weight, a penalty multiplier.
   *
   * Same fallback discipline as `getInt`, minus the integrality requirement.
   * Kept as a separate method rather than relaxing `getInt`, because a coin
   * amount that arrives as 12.5 is a bug and should still be rejected.
   */
  async getNumber(key: SettingKey, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    return this.read(key, (value) => Number.isFinite(value), tx);
  }

  /** Reads several keys at once. One round trip instead of one per weight. */
  async getNumbers<K extends SettingKey>(
    keys: readonly K[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<Record<K, number>> {
    const rows = await tx.appSetting.findMany({ where: { key: { in: [...keys] } } });
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    return Object.fromEntries(
      keys.map((key) => {
        const value = stored.get(key);
        return [
          key,
          typeof value === 'number' && Number.isFinite(value) ? value : SETTING_DEFAULTS[key],
        ];
      }),
    ) as Record<K, number>;
  }

  private async read(
    key: SettingKey,
    accept: (value: number) => boolean,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const row = await tx.appSetting.findUnique({ where: { key } });
    if (!row) return SETTING_DEFAULTS[key];

    const value = row.value;
    return typeof value === 'number' && accept(value) ? value : SETTING_DEFAULTS[key];
  }
}
