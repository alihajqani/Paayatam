# Marketing seed events — design

- **Status:** Approved (2026-09-18)
- **Scope:** Admin-configurable, automatic creation of fake ("seed") events in
  open cities that fill to capacity quickly, so early browsers see an active
  marketplace instead of an empty one.

## Goal

Early on, an open city has few or no real events, which is a chicken-and-egg
problem: nobody joins an empty-looking city, so it stays empty. This feature
lets the team seed believable, fast-filling events per open city, hosted by a
real team Telegram account, so real users see genuine activity and cannot
request a seat on a seed event (it is already full by the time they see it).

## Decisions already made (do not re-litigate)

1. **Host identity:** a real, team-controlled Telegram account, configured
   per city. Every host-facing notification (reminder, attendance prompt,
   host-reward payout) is therefore a real Telegram message to a real account.
2. **Participant identity:** synthetic profiles with no real Telegram account
   behind them. No message is ever attempted toward them.
3. **Trigger model:** a continuous, automatic scheduler — not a one-off admin
   button — that keeps a configured floor of "filling" seed events per open
   city.
4. **Post-`startsAt` behaviour:** the seed event rides the *exact* real event
   lifecycle (`EventLifecycleService.retireStarted` /
   `promptAttendance` / `settleAttendance`, `HostRewardService.settle`,
   `ReviewService.openForParticipant`) with **no forked code path**. This is
   possible because none of those sweeps require host interaction to
   complete — they are purely time-driven, and a host who never reports a
   no-show is already the default "everyone attended" case (confirmed by
   reading `lifecycle.service.ts`: `retireStarted` transitions purely on
   `startsAt`/`endsAt`, and `settleAttendance`'s own doc comment: "Everyone
   still ACCEPTED on a COMPLETED event is treated as having turned up").
5. **Admin control:** per open city, a `SUPER_ADMIN`-only screen configures
   `enabled`, event capacity, floor count (minimum concurrently-filling seed
   events), and fill duration.

## Data model (additive migration `00000000000059_seed_events`)

```prisma
model User {
  // ...existing fields...
  /// Synthetic identity for a marketing seed event. A seed `User` is created
  /// with **no `TelegramAccount` row** (that relation is already optional —
  /// `telegramAccount TelegramAccount?` — so this needs no schema change of
  /// its own): there is structurally no chat id to resolve, which is a
  /// stronger guarantee than a flag alone. `isSeed` is kept anyway as an
  /// explicit, cheap-to-query marker for the outbox skip (belt-and-suspenders
  /// — see below) and for excluding these rows from admin/user-facing
  /// analytics.
  isSeed Boolean @default(false) @map("is_seed")
}

model Event {
  // ...existing fields...
  /// True for an admin/system-generated marketing event (see
  /// `docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md`).
  /// The host is always a real account; only the participants are synthetic.
  isSeeded Boolean @default(false) @map("is_seeded")
}

/// Per-city configuration for the seed-event scheduler. One row per city,
/// created on demand from the admin screen (not seeded for every city).
model CitySeedConfig {
  cityId         String   @id @map("city_id")
  enabled        Boolean  @default(false)
  /// How many "filling" seed events (PUBLISHED, not yet at capacity) the
  /// scheduler keeps alive at once for this city.
  floorCount     Int      @default(1) @map("floor_count")
  eventCapacity  Int      @default(6) @map("event_capacity")
  /// Target minutes from a seed event's creation to full capacity.
  fillMinutes    Int      @default(5) @map("fill_minutes")
  hostUserId     String   @map("host_user_id")
  updatedAt      DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  updatedByAdminId String @map("updated_by_admin_id")

  city City @relation(fields: [cityId], references: [id], onDelete: Cascade)
  host User @relation(fields: [hostUserId], references: [id], onDelete: Restrict)

  @@map("city_seed_config")
}
```

`hostUserId` must reference a **real** `User` row (`isSeed = false`) with a
completed profile in that city — enforced in the service layer, not the
database (consistent with how the rest of the admin layer enforces
cross-entity business rules).

## New domain module: `packages/domain/src/seeding/`

- `seed-identity.service.ts` — `createSeedParticipant(cityId, districtId?)`:
  creates a fresh, throwaway `User` + `UserProfile` row per participant slot
  (`isSeed: true`, a decrementing negative `telegramUserId` sequence, a
  believable Persian display name/gender/age drawn from a small local name
  bank — no external calls). Never reused across events.
- `seed-content.service.ts` — a small, curated, per-category bank of
  believable Persian titles/descriptions (hand-written, so nothing here can
  trip the blacklist scan `EventService` already runs on every create).
- `seed-event.service.ts`:
  - `createSeedEvent(cityId)` — reads `CitySeedConfig`, picks a category +
    content-bank entry, calls the **real** `EventService.createEvent` with
    the configured host, sets `isSeeded: true`, and (since the content is
    pre-vetted) it lands `PUBLISHED` through the existing moderation-scan
    path exactly like a real event.
  - `fillStep(eventPublicId)` — adds **one** synthetic participant, called
    repeatedly by the scheduler at a jittered cadence until `acceptedCount`
    reaches `capacity`, so the fill looks organic rather than instantaneous.
- `seed-scheduler.service.ts` — the worker-side cron entry point (see below).

### Reusing the real capacity lock (ADR-0006)

`ParticipationService` gets one new method, next to `accept()`:

```ts
/**
 * Seat a synthetic participant directly into ACCEPTED, under the same event
 * lock every other capacity-changing operation uses (ADR-0006). Used only by
 * the seeding module — there is no bot or HTTP path that calls this.
 */
async seatSeedParticipant(eventPublicId: string, userId: string): Promise<void>
```

It locks the event row, calls the existing private `takeSeat`, inserts the
`EventParticipant` row already `ACCEPTED` (skipping the `PENDING` step —
there is no real host to review a synthetic request), and writes an
`audit_log` row with `actorType: 'SYSTEM'`. It does **not** emit an outbox
notification — there is nobody real to tell.

This is the only change to `participation.service.ts`. `lifecycle.service.ts`,
`host-reward.service.ts`, `no-show-claim.service.ts` and `review.service.ts`
are **not touched** — seed events are ordinary rows to every one of them.

## The one safety-critical change: never message a seed identity

`packages/domain/src/outbox/relay.service.ts`, `resolveUserId()`:

```ts
private async resolveUserId(publicId: string): Promise<string | null> {
  const user = await this.prisma.user.findUnique({
    where: { publicId },
    select: { id: true, isSeed: true },
  });
  if (user === null || user.isSeed) return null;
  return user.id;
}
```

A seed identity is now resolved exactly like a deleted/anonymised account —
quietly skipped, nothing queued, nothing sent. This single change is what
makes it safe for seed events to ride every real notification-producing sweep
(reminders, attendance prompts to *participants* — the host still gets
theirs, since the host is real —, no-show dispute invites, review requests)
without ever attempting a Telegram call to an account that does not exist.
Because this sits at the transactional-outbox boundary, it covers every
current and future notification type with one change, per the architecture
rule that "every outbound Telegram call goes on the queue."

The existing `logger.warn('outbox … no user for …')` line stays for the
genuine no-user case; a seed skip is logged at `debug`, since it is expected
volume, not a symptom.

## Scheduler (worker-side)

A new BullMQ repeatable job in `apps/worker`, alongside the existing
lifecycle sweep jobs:

- **Top-up pass** (every few minutes): for each city with `CitySeedConfig.enabled`
  and `City.isLaunched`, count currently-filling seed events
  (`isSeeded, status: PUBLISHED, acceptedCount < capacity`); create new ones
  via `createSeedEvent` until the floor is met.
- **Fill pass** (frequent, e.g. every 30–60s): for each filling seed event,
  decide via `fillMinutes` and elapsed time whether it's due another seat;
  call `fillStep`. Jittered so seats don't land on a fixed clock tick.

Both passes are ordinary idempotent sweeps in the same style as
`EventLifecycleService` — safe to run concurrently with themselves because
each event/city operation takes its own lock.

## Admin panel

- New permission `PERMISSIONS.EVENT_SEED_MANAGE = 'event.seed.manage'`,
  granted only to `SUPER_ADMIN` (same sensitivity tier as `coin.adjust` /
  `giftcode.manage` — this tool fabricates public-facing platform data).
- New view `apps/admin/src/views/SeedEventsView.vue`, route `/seed-events`,
  nav entry behind `EVENT_SEED_MANAGE`. Lists every `isLaunched` city with:
  enable toggle, host picker (real users only), event capacity, floor count,
  fill minutes, and a live read-only table of that city's current seed
  events with fill %. Every field write goes through the admin API,
  authorised in the service layer and audited (`actorType: 'ADMIN'`), per
  the repo's standing rule that a guard alone is not authorisation.
- A city-level and a global kill switch (`enabled = false`): stops new
  creation/filling immediately. Already-`PUBLISHED` seed events need no
  special unwind — they are ordinary rows and finish their real lifecycle
  normally.

## Testing

- Unit: `seed-content.service.ts` (bank coverage per active category),
  `seed-scheduler` top-up/fill decision logic (pure functions where
  possible, in the style of `reminderWaveFor`).
- Integration (`*.int.test.ts`, real Postgres):
  1. A seed event fills to capacity within its configured window, and a real
     user's `join` on it is refused/waitlisted exactly as `ADR-0006` already
     guarantees for any full event — no new capacity logic to test, only that
     seed participants really occupy `acceptedCount`.
  2. No `outboxEvent` row destined for a seed participant ever becomes a sent
     notification (assert via the existing BullMQ job-by-id pattern this repo
     already uses for notification assertions).
  3. A seed event's real host is reminded, prompted, and rewarded through the
     unmodified `lifecycle.service.ts` / `host-reward.service.ts` sweeps —
     i.e. run the existing sweeps against a seed event and assert the same
     outcome as the existing real-event tests assert.
  4. `apps/api/src/response-leak.int.test.ts` gains the new admin endpoints
     (invariant 7: `telegram_user_id` never reaches a response).
  5. `apps/{api,worker}/src/app.module.test.ts` resolves the new providers
     (the module-wiring trap this repo has hit before).

## Known implementation risk to verify early

`createSeedEvent` calls the real `EventService.createEvent` as the configured
host, which means any existing per-host limit (e.g. a cap on concurrently
active events for one account, if `event.service.ts` has one) applies to the
seed host exactly as it would to a real one. If a city's `floorCount ×`
concurrent-fill-window bumps into such a limit, the fix is a small pool of
host accounts per city in `CitySeedConfig` rather than one — not a bypass of
the limit. Confirm this during implementation before assuming a single host
is sufficient.

## Explicitly out of scope

- Reusing synthetic identities across multiple events (fresh per event slot;
  the row growth is immaterial for an early-marketing feature with a finite
  useful life).
- Any change to `lifecycle.service.ts`, `host-reward.service.ts`, or
  `no-show-claim.service.ts` — the whole point of riding the real sweeps is
  that they need none.
- Hiding seed events from real discovery/search — the entire point is that
  real users see and cannot join them.
