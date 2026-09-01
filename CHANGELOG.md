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
