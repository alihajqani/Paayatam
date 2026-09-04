# Changelog

Every released version of پایه‌تَم, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) —
loosely, while the product is pre-1.0 and a minor number still carries features.

Releases are deployed by tag: `scripts/deploy.sh <tag>` checks out the tag,
builds the images from it and records it in `.deploy/current-release`. So the tag
is the unit this product is rolled back by, and an entry here is the record of
what a rollback would be undoing.

This file starts at v0.6.5. Earlier releases are in the git history and were not
reconstructed — the entries below are written from the commits they ship.

## [v0.9.0] — 2026-09-04

The launch campaign: the first thousand members to complete a profile get a
permanent rank, a tier badge and a one-time coin grant that declines by tier.

**It ships switched off.** `founding.enabled` defaults to `0`, so deploying this
starts nothing — an operator opens the campaign from the settings board when it
actually begins. That default is the feature's main safety property rather than a
convenience: a rank is irreversible, the counter never moves backwards, and a
campaign that began at deploy time would hand the first several dozen ranks to
whoever happened to sign up between the deploy and the announcement.

### Added

- **A rank, allocated inside the transaction that completes a profile.** The
  obvious implementation was a `gift_code` with `max_redemptions = 1000` — that
  machinery exists, caps under a row lock and needs no migration — and it was
  rejected because with a code, "member #427" means "the 427th person who typed a
  string". The number sits on a profile for months and gets published to the
  channel, so it has to count members rather than redemptions. It also costs the
  user nothing: no code to find, none to type. The gift-code system is untouched
  and stays available for other campaigns.
- **A gap-free allocator.** `founding_campaign` is a single counter row and the
  allocation is one conditional `UPDATE … SET next_rank = next_rank + 1
  RETURNING`. A Postgres sequence would have been shorter and wrong: it hands a
  number to a transaction that then rolls back and the number is gone, so rank 428
  could simply never exist. Invisible in most products, unexplainable in one that
  displays the number. Same pattern and same reasoning as `anonymous_chat.next_seq`.
- **Three tiers, declining.** «بنیان‌گذار» (1–100, 150 coins), «پیشگام» (101–400,
  80) and «همراه نخست» (401–1000, 40), all six boundaries in `app_setting`. The
  amounts are deliberately small: an active member is about twenty coins down over
  three months, so the existing fifty-coin onboarding reward already covers most of
  a year, and a grant large enough to feel like a prize would also be large enough
  to make `cancellation.coins_lt_3h` free — and that penalty is what stands between
  the product and a no-show problem. What is scarce here is the rank.
- **The badge, where it belongs.** The member's own profile screen shows the rank;
  every list a stranger reads shows the tier alone. One of a thousand is a unique
  number and would be exactly the pseudonym ADR-0009 layer 3 refuses to assign, so
  `ParticipationService` does not select it. `cross-event-correlation.int.test.ts`
  asserts the participant projection's key set and is what stops that changing by
  accident — its allowlist was widened for `foundingTier` deliberately, on the
  grounds that three values across a whole campaign is a far weaker correlation key
  than the 0–100 `trustScore` the list already admits.

### Changed

- `coin_ledger_type` gains `FOUNDING_REWARD`. Separate from `ONBOARDING_REWARD`
  even though one transaction writes both: folding them together would make
  `SUM(amount) WHERE type = 'ONBOARDING_REWARD'` mean two things at once and the
  campaign's cost unanswerable.
- The profile-completion audit row carries `foundingRank` and `foundingTier`
  rather than a second entry. One action, one row.

### Migrations

`00000000000046_founding_reward_ledger_type` and `00000000000047_founding_members`,
split because `ALTER TYPE … ADD VALUE` cannot run inside a transaction — the same
reason 0022, 0023, 0029, 0031, 0032, 0034 and 0043 are separate. Both additive:
two new tables and one enum value, nothing dropped, renamed or narrowed, so the
previous image runs against this schema and rollback stays safe.

### Also

- Three test suites finished during v0.8.1 and never committed are included:
  sealing an answered request's notification, `hostPriceFor` on an odd price, and
  the `participation.min_response_minutes` floor.

## [v0.8.1] — 2026-09-04

Eight QA findings. The largest is a wiring bug that had been switching off a
whole feature since M22, and most of the rest are fields, buttons or messages
that existed on one side of a boundary and not the other.

### Fixed

- **The mandatory-channel-membership gate has been letting everybody through
  since M22.** `MEMBERSHIP_PROBE` was registered in `AppModule`'s own
  `providers`, under a comment saying `ChannelMembershipService` would resolve it
  there. Nest scopes providers to the declaring module, and that service is
  declared in `ChannelModule` — so the injection, which is `@Optional()`, was
  always `undefined`. `probeFor` then answered `UNKNOWN/NO_PROBE` for every
  channel, and every outcome except an authoritative `NOT_MEMBER` fails open by
  design. Nothing reported a problem: the graph resolved (that is what optional
  means), `app.module.test.ts` passed, and an operator who switched the
  requirement on watched nothing happen. It is a `@Global()` module now, which is
  how every other cross-cutting port here is published. `PROJECT_MEMORY` §7.26.
- **`/start` never mentioned the channels.** `/start` is exempt from the
  `APP_ACCESS` *refusal*, deliberately — gating account creation would refuse the
  deep links the join screen sends people back through — and that exemption had
  quietly become "the one command that never shows the gate at all". A returning
  user met the requirement for the first time as a refusal of something else,
  several taps later.
- **A profile created through the bot had no interests.** `user_interest` has
  existed since M3 and `CompleteProfileView` had checkboxes for it; ADR-0017
  retired the view and the wizard that replaced it had no step, so `complete` was
  called with a hard-coded `[]` — on a product whose discovery ranking reads the
  column.
- **The review-window reminder had a template and no producer.**
  `REVIEW_WINDOW_OPEN` has had Persian copy, a notification category, a deep link
  and a `render()` case since M12 and **nothing ever emitted it**, so for the
  whole seven-day window the only way to learn a review was owed was to open
  `/reviews` and look. It matters more than a missed nudge usually would because
  the pair is blind: one person's silence costs two people their feedback.
  `PROJECT_MEMORY` §7.27.
- **The Trust Score history could not be paged.** `/wallet` grew a page control
  in v0.7.0 and `/trust` did not, so «سکه و امتیاز» had one half you could read
  all of and one you could not — twenty rows, fixed, with nothing to say there
  were more behind them.
- **A request nobody answered told the guest nothing at all.** An expiry moved
  the row to EXPIRED, freed its slot and emitted no notification of any kind — so
  the person who had asked simply never heard back. Survivable while asking was
  free; not survivable next to a refund, because the only trace would have been a
  coin movement labelled «برگشت تراکنش» with nothing to attach it to.
  `PARTICIPATION_EXPIRED` says the host did not answer in time — not that the
  guest was refused, which would attribute a decision to a host who made none.
- **The host's decision buttons stayed live after the decision.** A second tap
  was refused correctly by `assertParticipantTransition`, so the state was never
  at risk; what the host saw was a decision they had already taken, offered
  again, and then an error for taking it.

### Added

- **Interest tags in the bot.** A `multi` step kind — the first in the wizard
  machine whose answers do not advance it — plus `/interests`, which opens the
  same `EDIT_PROFILE` form with the other six steps `when`'d out. A tap adds, a
  second tap on the same button removes, «تمام» writes the set. The draft is
  prefilled from the profile, and `touchedFields` is what keeps «رد کردن»
  meaning "leave them alone" rather than "write back what you were shown".
- **«☰ منوی اصلی», one reply-keyboard button.** v0.7.0 removed seven labels
  because `reply_markup` holds one thing and they were crowding every inline
  keyboard off the screen; that is an argument about seven, not about one. A
  reply keyboard lives on the client, so this is attached where
  `remove_keyboard` used to go and stays put while messages carrying inline
  keyboards go past. `onText` resolves it before offering text to an open wizard,
  so it is also the way out of a form.
- **A page control on the Trust Score history**, five to a page, editing the
  message it is on — the same shape `/wallet` uses.

### Changed

- **Asking to join is a deposit, not a fee.** `economy.event_join_coins` is
  charged inside the join transaction as before and is now **reversed whenever
  the guest never got an answer** — the host rejected, or the deadline passed.
  The ledger row is undone rather than today's price credited, so a refund cannot
  drift from what was actually taken, and the two carry different reason codes
  because they are different answers to "why did this number move". A
  **withdrawal is still not refunded**: the guest changed their mind, and
  `cancel` prices that on its own thresholds. Both messages name the figure.
- **A review may carry up to five tags.** The wizard asked for exactly one, on
  the argument that accumulating into an array would need a step that loops and
  that «a loop is the one shape `progressOf` cannot count». The shape was right
  and the conclusion was wrong: a `multi` step loops and is still one step, so
  «گام ۱ از ۲» holds however many times the keyboard is redrawn.
- **A submitted review says what happens next.** Reviews are blind until both
  sides write, and somebody who goes looking for what a stranger said about them
  and finds nothing reads that as the feature being broken. The confirmation now
  says so — including for a reviewer who adds nothing beyond the rating, which
  previously got silence.
- **Decisions taken on the participants console redraw the console**
  (`ev:acc`/`ev:rej`), and decisions taken on the notification rewrite it to say
  what was decided, with no keyboard. `chat:accept`/`chat:reject` still work,
  because every notification already in a host's history encodes them.

### Database

- `00000000000045_review_window_reminder` — one nullable `review_pair.reminded_at`
  and one index. Additive; every existing row reads NULL, so the first sweep
  after the deploy reminds everybody whose window is open, which is the point
  rather than a side effect.

## [v0.8.0] — 2026-09-03

One feature removed and one bug fixed, and they are the same story: the product
had two ways for two people to write to each other, and the older one was in the
way of the newer one working.

### Fixed

- **The reply button under a direct message was never drawn.** Pressing «مشاهدهٔ
  پیام» built a «✍️ پاسخ به این پیام» row, serialised it into the payload, and
  handed it to `BOT_NOTICE` — which discards any keyboard it is given and returns
  the menu opener instead. That is deliberate there: it is the template every
  refusal and one-line answer uses, and the menu is the useful thing to spend a
  keyboard on. The consequence was an answer button that existed in the code, was
  correct, and reached nobody in either direction. `BOT_DIRECT_MESSAGE` is the
  passthrough the screen needed, shaped like `BOT_WIZARD`.

### Changed

- **«✉️ دایرکت» → «✉️ پیام مستقیم به میزبان».** The old label named the medium
  and not the addressee. On a screen that also offers «پایتم» and two report
  buttons, the question a reader has is who they are about to write to — and it
  matters more here than anywhere else on that screen, because this is the one
  control that sends a stranger a message.
- **A thread runs in both directions.** The permission was always there —
  `reply` is addressed to the parent's sender and only its recipient may write
  one — so what changed is that the control now arrives. Guest writes, host reads
  and answers, guest reads the answer and answers that, for as long as they need
  to.
- **Direct messages are never deleted on a timer, and it is now written down.**
  The purge never touched them, which was correct and stated nowhere. The chat's
  ninety-day clock followed from its anonymity; a thread people use to arrange a
  meeting must not take the address with it. `retention.int.test.ts` seeds a
  message older than every window in §8 and asserts it survives.
- **«پیام‌های گفتگو» → «پیام‌های مستقیم» in settings.** The preference column is
  unchanged; what it governs is now the only messaging there is.
- **The relay's rate limit moved to the feature that replaced it.** `CHAT_SEND`
  becomes `DIRECT_MESSAGE_SEND`, thirty a minute, spent when a message is sent
  rather than when the form opens. A removal that had taken the limit away would
  have left the one thing in the product that writes to a stranger unmetered.

### Removed

- **The anonymous conversation, entirely.** `ChatService` owned a conversation
  that belonged to a participation: it opened when somebody asked to join, used
  aliases instead of names, masked contact details until both sides consented,
  and carried a status machine, a per-chat sequence, a retention clock and a
  relay that guessed which conversation a typed message belonged to. All of it
  existed to let two strangers talk without either giving anything away — and it
  made the thing people actually wanted impossible: you had to join before you
  could ask a question, and once you had agreed to meet, the masking stood
  between you and the phone number you were trying to swap.

  Gone with it: `/chats` and its digest; the menu group that held it; the relay,
  the reply-routing and the edit propagation; `chat.message`,
  `chat.message_edited` and `chat.message_deleted`; `chat:close`, `chat:share`
  and `chat:shareyes`; five `/api/v1/chats` endpoints and `POST
  /chats/:id/report`; the Mini App's conversation screen, store and privacy copy;
  the optional note that used to ride along with a join; and the conversation
  hooks in `ParticipationService` and `EventService`, so joining, accepting,
  rejecting, cancelling and expiring stop writing rows.

  `chat:accept` and `chat:reject` **keep the prefix**. They never carried a chat
  id — they carry a participant one — and renaming would turn every host-decision
  button already sitting in somebody's Telegram history into «این دکمه دیگر کار
  نمی‌کند» on a request that expires in twenty-four hours.

- **Three error codes** — `CHAT_CLOSED`, `CHAT_NOT_OPEN` and
  `CHAT_MESSAGE_EMPTY` — described states only a conversation could be in.
  `CHAT_MEDIA_UNSUPPORTED` survives on its own merit: the bot still refuses a
  photo sent to a form that does not want one.

### Migrations

- `00000000000044_retire_conversations` — **closes** every remaining
  conversation; it drops nothing. `retention_expires_at` is set when a chat
  closes and the nightly purge keys on it, so a chat left open by a build that
  can no longer close one would never expire and the ninety-day promise would
  quietly become "forever" for whoever had a live conversation on deploy day.
  Every non-closed chat is closed now with the standard clock from ADR-0009 §8,
  and every message without an expiry gets one. Nothing is deleted today;
  everything is deleted on the schedule it was promised, and a moderator keeps a
  break-glass window in the meantime.

### Notes

- **The tables stay.** `anonymous_chat` and its four dependents still hold real
  conversations between real people, a report filed while the feature existed
  still points at one, and a moderator can still be granted a break-glass unseal
  under an open case. Dropping them would destroy the evidence for complaints
  that are open now. The admin dashboard's tile is relabelled «گفت‌وگوهای
  بایگانی‌شده», says what it is, and hides itself when the count reaches zero.
- **B4's privacy gate is rebuilt, not dropped.** Five messages through the real
  webhook, the same sweep for four identifiers over every API response and stored
  payload, plus two assertions the old gate could not make: a number its owner
  typed reaches its recipient **unmasked**, and it is ciphertext at rest. The one
  exclusion from the sweep is the reader's own copy of a message — masking that
  would be asserting the opposite of what this feature is for.
- `MessageCipher` moves to its own `CryptoModule` and `sanitizeInbound` to
  `privacy/`. Both were provided beside `ChatService`; three things still hold
  the key and `AdminInsightService` still masks a bio.

## [v0.7.0] — 2026-09-03

The third QA round, and the largest release since M22. Two features are removed
outright, one is rebuilt from scratch, and six of the fixes are bugs whose
mechanism worked exactly as written and produced the wrong thing in front of a
user. Three of them were only findable by reading production rows.

### Added

- **«دایرکت» — a message to the other party, about one activity.** Built from
  scratch rather than on the anonymous chat, because the chat is a conversation
  that belongs to a participation, uses aliases, and *masks contact details* —
  and this exists so two people can exchange a phone number to arrange a lift.
  «✉️ دایرکت» under the activity, a one-field form with «انصراف», a notification
  to the host naming who and what but **not the words**, «👁 مشاهدهٔ پیام» that
  marks it read and tells the sender so, and «✍️ پاسخ» that runs the same form
  back the other way. Bodies are AES-256-GCM under the existing chat key.
  Addressing is derived, never taken from the caller: a thread goes to the host,
  a reply to the parent's sender, and only the parent's recipient may write one.
- **A guest can stand down from an activity they were accepted to.** «لغو» was
  offered on pending and waitlisted requests only. A guest who could not come and
  had no way to tell the *product* kept a seat nobody could fill and was settled
  as having attended. Two steps, quoting what it costs from the same function
  that charges it.
- **The moderation queue is reviewable.** A case opened in the panel now carries
  the activity's title, description and status, its owner, and every complaint
  with the words the reporter wrote — never who wrote them, and the screen says
  so. Claim, release and escalate close two gaps `docs/admin-panel.md` had
  recorded since M12: `assigned_admin_id` and `ESCALATED` existed and nothing
  wrote either.
- **A host is told when a case goes their way.** `CONTENT_RESTORED` is the
  counterpart `CONTENT_HIDDEN` never had, and a moderator hiding an activity by
  hand now notifies like the automatic hide already did. The paid channel
  placement comes back with the activity — it could not before, because the claim
  row survives a takedown and the unique index then refused every future claim.
- **Both sides are told when a referral pays out.** The condition — the referred
  user attended something — is the whole reason referrals are not a farm, and
  nothing ever announced that it had been met.
- **The wallet ledger pages.** Five rows with «قبلی»/«بعدی» on the same message,
  where it was twenty in one wall with thirty more unreachable behind it.
- **Capacity of one, and «بدون محدودیت».** Seven buttons — ۱ ۲ ۳ ۴ ۵ ۱۰ ۱۵ — an
  unlimited option, and a prompt that says a number may be typed. Unlimited is a
  sentinel rather than a nullable column, because `accepted_count <= capacity` is
  a CHECK and four renderers subtract from it.

### Changed

- **The channel post asks instead of listing.** «پایه واسه <b>…</b> میخوام / کیو
  داریم اینجا؟ بگه!», with the disclaimer first and the five facts under it. The
  kind label is gone from the body; prices are grouped in threes.
- **The button that joins says «🤝 پایتم»** on every surface. One action had three
  phrasings, none of them the product's own word.
- **Joining costs five coins**, and **cancelling more than a day out is no longer
  free** (`cancellation.coins_gt_24h`, 5, with no trust cost). Both are
  `app_setting` rows and both roll back to zero without a deploy. D9a went live
  with them: a host who cancels now refunds every accepted guest's join fee.
- **A referral code is for a new account.** `referral.claim_window_hours` (168)
  is measured from `user.created_at`; the three structural guarantees — one
  referrer for life, never yourself, paid once — are unchanged.
- **The review window opens when the activity is over.**
  `review.window_opens_hours` 24 → 0 and `participation.settlement_delay_hours`
  24 → 2. The two used to stack into a two-day wait.
- **The settings board's emoji is the state, not the tap.** Every switch drew 🔕
  while it was *on*, contradicting the line above it.
- **A toast with something to say stays on screen.** The Bot API has no duration
  parameter; `show_alert` is the only lever, applied to anything long enough to
  be an explanation rather than an acknowledgement.

### Removed

- **Event promotion — the boost window and the VIP flag.** The endpoint, the
  bot's confirmation, the Mini App call, the two prices, the ranking term and the
  two channel-post kinds. `event.boosted_until`, `event.is_vip` and the
  `BOOST_SPEND` / `VIP_SPEND` ledger types stay: rows written before today still
  have to read as what they were.
- **The keyboard under the text box.** `/menu` and the `☰` opener are the menu
  now. Every message carries `remove_keyboard`, because deleting the code that
  drew it would have left it on every client that had one; the label resolver
  stays, so a stale tap is understood rather than relayed into somebody's chat.
- **The «تبلیغات» switch on the settings board.** The preference behind it —
  `user_settings.notify_campaigns` and the delivery check — is untouched.

### Fixed

- **«این عملیات در وضعیت فعلی ممکن نیست» when accepting a guest.** Two causes.
  A waitlisted request had no `ACCEPTED` or `REJECTED` edge while «مهمان‌ها» drew
  both buttons on it; and `min(now + 24h, starts_at - 3h)` goes *behind* `now` for
  an activity starting within three hours, so the request was born expired.
  `participation.min_response_minutes` (30) floors it.
- **A full activity was invisible, so its waiting list was unreachable.**
  `/discover` filtered on `hasCapacity: true`, hard-coded, hiding the activities
  the waitlist applies to. The button on a full one now says «⏳ ثبت در نوبت
  انتظار».
- **The report threshold subtracted agreement.** It counted only `OPEN` reports,
  so an activity with four distinct reporters — two of whose complaints a
  moderator had already *actioned* — never reached three. Found in the production
  rows. It now counts everything except `DISMISSED`, which is the one status that
  means somebody looked and said there was nothing in it.
- **`/reviews` said «نظر منتظری ندارید» in three different situations**, and a
  host who had just held an activity read "not open yet" as "nothing". Unopened
  windows are listed with the date they become writable.
- **The footer under a numbered list** says which button belongs to which row.

### Migrations

- `0041_capacity_up_to_unlimited` — widens `event_capacity_range` from `1..50` to
  `1..1000`. Widening a CHECK rejects nothing already stored.
- `0042_direct_messages` — the `direct_message` table.
- `0043_direct_message_wizard` — `conversation_kind` gains `DIRECT_MESSAGE`. Its
  own file because `ALTER TYPE … ADD VALUE` cannot run inside a transaction.

All three are additive and none moves existing data.

## [v0.6.7] — 2026-09-01

The second QA round against the live bot. Two of the findings were bugs whose
mechanism worked exactly as written and produced the wrong thing in front of a
user; the rest is the two list screens rebuilt around a control Telegram already
has and this product was not using — a `/command` on the line it belongs to.

### Added

- **A numbered list you open by link.** «فعالیت‌های نزدیک شما» and «فعالیت‌های
  من» both end each activity with `/event_…` or `/myevent_…`, which Telegram
  renders as a tap target *on that line*. Entries are separated by a rule, and
  the keyboard is freed for the controls that are about the list rather than one
  activity: «قبلی», «بعدی», and one button that opens the filters.
- **Filters that open in place.** The discovery list and its filter panel are one
  message with two faces. Applying a filter redraws it; «بازگشت به فهرست» turns
  it back into the list, on the page the reader was on. Nothing sends a second
  message.
- **A way back that leaves the list last.** Closing an activity deletes the
  activity *and the command that opened it*, so the list is the last thing in the
  conversation again.
- **The grouped menu on the keyboard under the text box.** The inline menu's five
  categories now sit under the compose box beside «ساختن فعالیت» and «دیدن
  فعالیت‌ها», so the eleven commands that had a button nowhere gained a route
  that does not require knowing they exist.
- **A host is told when the scanner holds their activity.** A blocked activity is
  created, held and never published; the bot used to answer «فعالیت ثبت شد ✅ …
  در کانال منتشر می‌شود» and offer to sell two ways of being seen more.

### Changed

- **A settings switch edits its board** instead of sending another one. So does
  the moderation queue's «بازگشت».
- **«فعالیت‌های من» is a list, not a console.** Five buttons per activity meant
  thirty buttons for six activities, two of which spend coins; the actions moved
  under the activity they act on, where there is one of each and no number to
  match. Four of them: guests, republish, special invite, cancel.
- **A wizard refusal says what the bot received.** «نام فعالیت باید دست‌کم ۳
  نویسه باشد» is a rule restated at somebody who believes they satisfied it. The
  answer is quoted back, bounded to forty characters; an empty answer after the
  trim says so rather than quoting «»; a tap and a photo are told apart from
  text. At the end of the form, an incomplete draft names the questions still
  unanswered and a `VALIDATION_FAILED` names its field.
- **The blocklist goes from eight terms to thirty-four** — alcohol, narcotics,
  gambling, solicitation, weapons, and two ways of routing around the anonymous
  chat — and «صیغه» is raised from FLAG to BLOCK. It also moves out of the seed
  script into the domain and ships through a migration, because `openSeed`
  refuses production without a typed confirmation and the deployed list was
  therefore whatever it was on the day somebody last gave one.
- Guidance names a button somebody can see: `menuPathFor` resolves a command to
  the drawn button that reaches it, which since the keyboard grew categories is a
  different question from what the command's own label is.

### Removed

- **Editing an activity.** The flow was the create wizard, prefilled, with all
  fourteen steps made skippable and a picker in front — a lot of machinery to
  change a title, and every part of it a place to get lost. A host who wants a
  different activity cancels this one and makes another.
- **The category a host names themselves.** «سایر» invited a name of its own and
  nothing in production ever carried one. The flag had to go with the question:
  `resolveCategory` treats it as a requirement, so «سایر» would otherwise have
  become unpickable.
- «ارتقا» is no longer on the host's console. The callback still works, so any
  message that still carries the button still spends.

### Fixed

- **A contact share closed the terms gate for good.** `hasAcceptedCurrentPolicies`
  counted `consent` rows and compared the total with the number of required
  documents — but the table is UNIQUE on `(user, version, context)` precisely so
  one person can accept one document under more than one circumstance, and
  sharing contact details writes exactly such a row. Two documents and three rows
  measured as `3 === 2`, so every write reopened the terms screen and accepting
  again changed nothing. Found on the live bot, on the account that had done the
  one thing this product's safety model exists to lead people to.
- **The acceptance screen would have refused the acceptance** the day a
  `COMMUNITY` guideline was published: the bot submitted every *current* policy
  and `acceptPolicies` takes only the required subset.
- **«شرابخواری» published**, because the list held «مشروب» and «شراب» is a
  different string.
- **The coin refusal printed its own markup.** «ثبت فعالیت <b>۱۵ سکه</b> هزینه
  دارد» is what a host with an empty wallet read: `BOT_NOTICE` escapes its body,
  correctly, and the sentence was built with `<b>` in it.

### Database

- `0037_blacklist_expansion` — data only, idempotent. Upserts the thirty-four
  terms and raises «صیغه» to BLOCK; publishes one new `blacklist_version`.
- `0038_retire_event_editing` — deletes open `EDIT_EVENT` drafts. `user_id` is
  UNIQUE, so a stale row is not dead weight — it is the form that user is in.
- `0039_no_custom_category_label` — turns `category.allows_custom_label` off. The
  column stays; events that carry a label keep it.
- `0040_event_public_id_prefix` — additive. An expression index on
  `substr(public_id, 1, 11)`, so opening an activity by its short code is an
  indexed equality rather than a `LIKE` no btree can serve.

## [v0.6.6] — 2026-09-01

### Added

- **Every command is a button.** All nineteen bot commands are reachable from an
  inline menu, grouped into five categories by what the user is trying to do and
  never more than two taps deep. Opened with `/menu`, from the welcome message,
  and from under any message that has no keyboard of its own. Buttons are
  labelled with each command's description rather than its slash form, so a user
  who does not know the commands can still find what they want.
- **A renewal for a channel post.** A host can publish an activity to the channel
  again so it is seen again, as many times as they like. The post it replaces is
  taken down, so the channel never holds two copies of one activity.
- **The two ways to reach further, explained after registering.** The success
  message names the paid invitation and the renewal, with their prices, and both
  have buttons under the activity in «فعالیت‌های من».

### Changed

- **Registering an activity costs 15 coins**, and buys both the listing in
  Discover and a placement in the channel. The host is quoted one number; the
  two halves are priced separately in `app_setting` so an operator can tune them,
  and are charged as two ledger rows so the ledger can still say what the coins
  bought.
- **A paid invitation costs 20 coins** (was 10) and a channel renewal costs 5.
- **Preconditions are checked before the work, not after it.** Creating an
  activity checks the price before the first question rather than after the
  fourteenth; the promotion dialogs check it before asking for a confirmation
  they would then refuse. Joining is checked the same way, which matters on the
  day an operator gives it a price.
- The host console in «فعالیت‌های من» is two rows — what a host reads, and what
  costs coins or cannot be undone — with prices in the labels.

### Fixed

- **A guest cancelling before the host decides now notifies the host.** The
  request used to disappear from «درخواست‌ها» with no message, leaving the host
  believing they still owed an answer to something that was gone.
- **The worker learns which release it is on.** `PAYETAM_VERSION` reached only
  the API, so the update broadcast keyed itself on `local` — which named «local»
  to users, and would have made every future release find that row and announce
  nothing at all.

### Database

- `0036_channel_republish` — additive. `channel_post` gains `republish_seq` and
  `superseded_at`, and its unique index widens to include the sequence. Every
  existing row is sequence 0 and behaves exactly as before, including staying
  blocked against a free re-post after a moderator takes it down.

## [v0.6.5] — 2026-09-01

The first QA round against the live bot: sixteen findings from an operator
working through the product end to end. Most were not missing features but places
where a mechanism worked as written and the thing in front of the user was still
wrong.

### Added

- Bug reports with screenshots (`/bug`), and a queue for them in the admin panel.
- A release announcement on every deploy, with `release.announce_enabled` to
  suppress it.
- Paging for `/discover`, which had been showing five activities and no way to
  the rest.
- A gift-code kill switch (`giftcode.enabled`) and a disable button on the code
  list.
- A typeable neighbourhood, because the district catalogue is empty in every
  deployment and «کدام محله؟» therefore had no answers.

### Changed

- **A seat is consumed when a host accepts, and at no other moment.** An
  undecided request used to hold one, so an activity with two places showed
  «ظرفیت تکمیل» while one request had been rejected and another had expired. The
  waiting list is now bounded by seats plus outstanding questions.
- **A gift code is matched exactly** — case, spaces and dashes all count. The
  shared normalizer meant `test1` was also redeemable as `test 1`.
- Dates are Persian on every surface, including the profile form's birth year.
- Profile edits are capped at ten an hour.

### Fixed

- The channel membership requirement is enforced on the bot, on every update,
  with the join links in the refusal.
- Suspension does something: a suspended account can read but not write.
- A blocked account receives one final message naming the support contact.
- The daily-activity-limit message named the wrong quota, so an operator who
  raised `events.max_per_day` watched the product carry on refusing.
- Event filters edit the message instead of sending a new one.
- The activity-creation limit is stated before the form, not after it.
- «انتشار نسخه» in the admin panel could never be enabled, because the version
  was rendered in Persian digits and parsed as Latin ones.

### Database

- `0033_bot_qa_round_one`, `0034_bug_report_wizard`, `0035_seat_accounting_backfill`
  — all additive. 0035 rewrites `event.accepted_count` to match the new meaning;
  it is idempotent and only ever lowers a count.
