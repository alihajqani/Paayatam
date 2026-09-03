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
