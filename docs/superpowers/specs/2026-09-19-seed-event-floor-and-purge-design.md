# Seed events: a floor that counts the city, variety, and cleanup

- **Status:** Implemented on `fix/seed-event-floor-and-purge` (2026-09-19)
- **Amends:** [2026-09-18-marketing-seed-events-design.md](2026-09-18-marketing-seed-events-design.md).
  That document stays as written; where the two disagree, this one wins.
- **Scope:** the seed-event scheduler (`packages/domain/src/seeding/`), one option on
  `EventService.create`, one guard in `EventLifecycleService.settleOne`, a new hourly
  job, and `isSeed` filters on every counter that reads users.

## What was reported

With a city's floor set to 3, the scheduler kept creating events without end, all at
once, one after another. The expectation: if a city already has 7 upcoming events and
the floor is 10, create only 3, each with a different title, topic, day and hour. And
the synthetic people who fill those events must not stay in the user table after the
event, or the user count is inflated with people who never existed.

## Root causes

All of this is on `master` as of v0.18.0.

1. **The floor counted the wrong set.** `topUp()` counted seed events that were
   `PUBLISHED` **and** `accepted_count < capacity`: seed events still *filling*. A seed
   event fills in `fillMinutes` (default 5), so it left that set almost at once. The
   next pass, five minutes later, saw a deficit again and created a fresh batch, forever,
   until the host ran out of quota or coins. Real events were never counted, and a full
   seed event that was still weeks from starting was not counted either.
2. **Every event of a pass was the same event.** `startsAt = now + 3h` and a fixed
   2-hour duration for all of them; the category was `findFirstOrThrow` with no order,
   so always the same one; the text was a 4 x 3 template grid over the category name.
3. **Nothing ever removed the synthetic users.** They were created per seat, "never
   reused", and lived in the `user` table for good. Every count that reads users
   included them.
4. Found while fixing it: the kill switch (`enabled = false`) stopped creation but not
   filling (`fill()` only checked that a config row existed); `is_seeded` was written by a
   second `UPDATE` after the event was created, so a crash between the two left a fake
   event that nothing would fill or clean up; and a failed seat left its just-created
   synthetic user stranded.

## Decisions

### D1. The floor is the number of upcoming events in the city, whoever hosts them

`upcomingEventsWhere(now, cityId?)` in `seed-floor.ts` is the one definition:
`status = PUBLISHED`, not deleted, `startsAt > now`, real and seeded, full or not. The
scheduler and the admin screen both use it. A city with 7 and a floor of 10 gets 3; a
city at 10 gets none.

There is no horizon on what counts: a real event three weeks away counts. Seed events
themselves are scheduled within 14 days.

### D2. At most 3 per city per pass, recounted before each

A city at zero with a floor of twenty is reached over several five-minute passes, not in
one burst of twenty coin charges and twenty channel posts. Recounting before each
creation means two overlapping passes overshoot by at most one, not by a whole deficit.

### D3. Variety is decided against the city's current upcoming events

Pure functions, randomness injected, in `seed-variety.ts` and `seed-content.ts`:

- **Category:** the eligible one with the fewest upcoming events in the city, ties broken
  at random. Eligible = active, not «سایر», not the custom-label category, and offered in
  the city (no `city_category` rows means everywhere, as in `resolveCategory`).
- **Topic:** a curated bank keyed by category `slug` (stable; `nameFa` may be renamed),
  2 to 4 topics for each of the 13 catalogue categories, with a generic fallback over the
  category name for a category the bank does not know. A title already on one of the
  city's upcoming events is skipped; it repeats only when every topic is taken.
- **Day and hour:** every (day, slot) in the next 14 days is a candidate. Dropped: less
  than 4 hours ahead, outside the parts of the day the topic allows (a sunrise walk is
  never at 19:30), within 2 hours of another event in the city. Weighted: nearer days,
  Thursday and Friday, and days with nothing on them. 12 local slots between 09:30 and
  20:30 in `APP_TIMEZONE`. If the city is so full that nothing survives, the clash rule is
  relaxed instead of failing.
- **Duration:** 90, 120, 150 or 180 minutes.
- No text names a day, date, venue or price; the event row carries the schedule.
  A unit test scans the whole bank against the real `STARTER_BLACKLIST`.

### D4. Seed events are exempt from the per-host quota

A floor of ten cannot be reached by an account allowed three concurrent events and five a
day. `EventService.create(host, input, { seeded: true })` skips `assertWithinQuota`,
writes `isSeeded` in the same transaction as the row, and `readQuota` excludes seeded
events from both counts, so a team account that also hosts real evenings is not locked
out by its own seeds. **Coins are still charged**: creation and, since the content always
publishes, the channel post. The contract cap on `floorCount` moves from 3 to 50.

### D5. The synthetic people are deleted right after the event ends, before settlement

New job `seed-purge`, hourly at :50 (after `settle-attendance` at :40).
`SeedSchedulerService.purge()` selects seeded events that are cancelled, expired,
rejected or deleted, or `COMPLETED`/`HIDDEN` with `endsAt <= now`, and for each, in one
transaction under the event lock: deletes review pairs, reviews and participations of
`is_seed` users, then those users, filtered on `is_seed` and aborting if the count is
short. It writes a `seed.purged` audit row. The event row stays; it happened, and the
host's history and ledger refer to it. A real guest on the same event is untouched.
Orphans (a synthetic user with no seat, older than an hour) are swept in the same pass.

**Why before settlement, not after.** The first version waited for the settlement delay
and failed its own test: `trust_score_ledger` (like `coin_ledger`, `audit_log`, `consent`
and `chat_action`) is append-only by trigger, and `settleAttendance` credits trust to every
guest it settles. A synthetic user who had been settled could never be deleted. So:

1. The purge runs hours before settlement is due (`participation.settlement_delay_hours`,
   18 by default).
2. `settleOne` settles a seed guest's row (it must not stay `ACCEPTED`) but credits no
   trust and opens no review window, for a worker that was down long enough for the two
   sweeps to run in the other order. This is the one change to the lifecycle service, and
   it has the side effect the original design lacked: the real host is no longer asked to
   review guests who do not exist.

### D6. Every counter that reads users excludes `is_seed`

Synthetic guests live from the day they are seated until their event is over, which is now
up to two weeks. Excluded, with a test each: the admin dashboard (total, by status, new this
week, active this week), the admin user list, a closed city's «waiting» count, the founding
report's per-city profiles, the city admin's profile count, and the comeback-grant
candidates. Broadcast audiences and invite candidates already require a Telegram account,
which a synthetic user never has.

### D7. Smaller fixes made on the way

`fill()` honours `enabled` and isolates a failing event; `fillStep` discards the identity it
just made if the seat is refused; the admin screen shows `upcomingEventCount` (what the
floor is compared with) beside `fillingEventCount` (what is still short of capacity).

No migration: `user.is_seed`, `event.is_seeded` and `city_seed_config` already exist.

## Read this before deploying

- **`floor_count` changes meaning.** It was "seed events kept filling"; it is now "upcoming
  events the city should have". A city configured with 3 that already has 3 or more real
  upcoming events will create **no** seed events after this ships. Check each
  `city_seed_config` row against the city's real activity.
- The new job `seed-purge` is registered by the worker at boot. Synthetic users the old
  scheduler already left behind are removed as their events end, at up to 100 events an hour;
  an event that is still upcoming keeps its guests until then.
- Seed events are still charged to the host. Nothing refunds them: the host's deposit refund
  is gated on the host having reviewed every guest who attended (`HostRewardService.assess`),
  and nobody reviews people who do not exist. That was already true; it is now visible here.

## Known limits

- A synthetic guest given a ledger row by an operator action (for example a host marking one
  as a no-show) can never be deleted. The purge for that event rolls back whole, logs a
  warning every hour, and leaves the rest. Counters stay correct because they filter on
  `is_seed`. Nothing prevents the action; it is not worth a rule for a team-run account.
- `event.accepted_count` is left as it was on a purged event: a record of how many seats were
  filled, not a count of rows.
- The dashboard's event and participant tallies still include seed events and, until the
  purge, their seats. Only user counts were in scope.
- The event `title` uniqueness is per city and upcoming only; a title can recur once its
  earlier event has started.

## Verification

Recorded in the branch's final commit message and the hand-over note. New tests: unit
(`seed-variety`, `seed-content`, `time`, `seed-config`), integration (`seed-scheduler` with the
real lifecycle sweeps, `seed-event`, `seed-identity`, `seed-admin`, and one test each for the
counters in D6).
