# Marketing Seed Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin configure, per open city, an automatic scheduler that
creates fake ("seed") events hosted by a real team Telegram account, fills
them with synthetic participants within a configured window, and lets them
ride the product's real event lifecycle unmodified — so early, empty cities
look like an active marketplace and a real user cannot request a seat on one.

**Architecture:** A new `packages/domain/src/seeding/` module creates seed
events through the *existing* `EventService.createEvent` and seats synthetic
participants through one new method on `ParticipationService` that reuses the
ADR-0006 capacity lock. A worker cron pair (top-up, fill) drives it. The only
change to existing notification code is a one-line skip for synthetic users
in the outbox relay, which is what makes it safe to let seed events flow
through `lifecycle.service.ts`, `host-reward.service.ts` and
`no-show-claim.service.ts` completely unmodified.

**Tech Stack:** NestJS 11, Prisma 7 / Postgres 16, BullMQ 6, Vue 3 + Pinia
(admin), Vitest 4, zod (`@payetam/shared` contracts).

**Spec:** `docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md`

## Global Constraints

- Hand-written, sequentially-numbered, **additive-only** migrations
  (`packages/db/prisma/migrations/`) — next number is
  `00000000000059_seed_events`. Update `schema.prisma` to match, then
  `pnpm db:generate`.
- `packages/domain` imports no HTTP framework and no grammY; business logic
  lives there, `apps/api` and `apps/worker` stay thin adapters.
- Every mutating admin method starts with
  `this.access.assertPermission(session, PERMISSIONS.X)` and ends with an
  `AuditService.record(...)` call (`actorType: 'ADMIN'`); every
  system-triggered mutation writes its own audit row with
  `actorType: 'SYSTEM'`.
- Validation on every admin route is a zod schema in
  `packages/shared/src/contracts/`, applied via `ZodValidationPipe`.
- `AuditModule` and `OutboxModule` are `@Global` — no explicit import needed
  to inject `AuditService` / `OutboxService`.
- Never log or return `telegram_user_id`. New endpoints must be added to
  `apps/api/src/response-leak.int.test.ts`.
- New providers must be reachable from both `apps/api/src/app.module.test.ts`
  and `apps/worker/src/app.module.test.ts` wherever they are wired in.
- Run `make typecheck` (not bare `rtk pnpm typecheck`, which masks failures)
  before any test run that crosses package boundaries.
- Prettier: single quotes, semicolons, trailing commas, width 100.

---

## File Structure

**New files:**
- `packages/db/prisma/migrations/00000000000059_seed_events/migration.sql`
- `packages/domain/src/seeding/seed-content.ts` — pure Persian title/description generator (no DB, no I/O)
- `packages/domain/src/seeding/seed-content.test.ts`
- `packages/domain/src/seeding/seed-identity.service.ts` — creates a throwaway synthetic `User` + `UserProfile`
- `packages/domain/src/seeding/seed-identity.service.int.test.ts`
- `packages/domain/src/seeding/seed-event.service.ts` — `createSeedEvent`, `fillStep`
- `packages/domain/src/seeding/seed-event.service.int.test.ts`
- `packages/domain/src/seeding/seed-scheduler.service.ts` — top-up/fill sweep, called by the worker cron
- `packages/domain/src/seeding/seed-scheduler.service.int.test.ts`
- `packages/domain/src/seeding/seeding.module.ts`
- `packages/domain/src/adminaccess/seed-admin.service.ts` — admin CRUD over `CitySeedConfig` + read model
- `packages/domain/src/adminaccess/seed-admin.int.test.ts`
- `apps/admin/src/views/SeedEventsView.vue`

**Modified files:**
- `packages/db/prisma/schema.prisma` — `User.isSeed`, `Event.isSeeded`, `CitySeedConfig` model
- `packages/domain/src/outbox/relay.service.ts` — skip seed users in `resolveUserId`
- `packages/domain/src/outbox/relay.int.test.ts` — new test case
- `packages/domain/src/participation/participation.service.ts` — new `seatSeedParticipant` method
- `packages/domain/src/participation/participation.service.int.test.ts` — new test case
- `packages/domain/src/adminaccess/adminaccess.module.ts` — provide/export `SeedAdminService`
- `packages/domain/src/index.ts` — export `SeedingModule`, `SeedAdminService`, related types
- `packages/shared/src/contracts/permissions.ts` — `EVENT_SEED_MANAGE`
- `packages/shared/src/contracts/` — new `seed-events.ts` contract file, exported from `packages/shared/src/index.ts`
- `apps/api/src/admin/admin.controller.ts` — new endpoints
- `apps/api/src/app.module.ts` — wire `SeedingModule` if not already reachable through `AdminAccessModule`
- `apps/api/src/response-leak.int.test.ts` — cover new endpoints
- `apps/api/src/app.module.test.ts` — resolve new providers
- `apps/worker/src/app.module.ts` — import `SeedingModule`
- `apps/worker/src/queues/processors.service.ts` — dispatch the two new jobs
- `apps/worker/src/app.module.test.ts` — resolve new providers
- `packages/platform/src/queue/queues.ts` — `JOBS.SEED_TOPUP`, `JOBS.SEED_FILL`, `SCHEDULE` entries
- `apps/admin/src/router.ts` — new route behind `EVENT_SEED_MANAGE`

---

### Task 1: Migration and schema

**Files:**
- Create: `packages/db/prisma/migrations/00000000000059_seed_events/migration.sql`
- Modify: `packages/db/prisma/schema.prisma`

**Interfaces:**
- Produces: `User.isSeed: boolean`, `Event.isSeeded: boolean`,
  `CitySeedConfig { cityId, enabled, floorCount, eventCapacity, fillMinutes, hostUserId, updatedAt, updatedByAdminId }`

- [ ] **Step 1: Add the three schema changes**

In `packages/db/prisma/schema.prisma`, inside `model User`, add next to
`deletedAt`:

```prisma
  /// Synthetic identity for a marketing seed event (see
  /// docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md). Has
  /// no `telegramAccount` row — there is structurally no chat id to send to.
  isSeed Boolean @default(false) @map("is_seed")
```

Inside `model Event`, add next to `isVip`:

```prisma
  /// True for an admin/system-generated marketing event. The host is always
  /// a real account; only the participants are synthetic.
  isSeeded Boolean @default(false) @map("is_seeded")
```

Add a new model, near `model City`:

```prisma
/// Per-city configuration for the seed-event scheduler (one row per
/// configured city, created on demand — not seeded for every city).
model CitySeedConfig {
  cityId           String   @id @map("city_id")
  enabled          Boolean  @default(false)
  /// How many "filling" seed events (PUBLISHED, acceptedCount < capacity)
  /// the scheduler keeps alive at once for this city.
  floorCount       Int      @default(1) @map("floor_count")
  eventCapacity    Int      @default(6) @map("event_capacity")
  /// Target minutes from a seed event's creation to full capacity.
  fillMinutes      Int      @default(5) @map("fill_minutes")
  hostUserId       String   @map("host_user_id")
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
  updatedByAdminId String   @map("updated_by_admin_id")

  city City @relation(fields: [cityId], references: [id], onDelete: Cascade)
  host User @relation(fields: [hostUserId], references: [id], onDelete: Restrict)

  @@map("city_seed_config")
}
```

Add the back-reference on `model City` (next to `districts`):
`seedConfig CitySeedConfig?`, and on `model User` (next to `hostedEvents`):
`seedConfigsHosted CitySeedConfig[]`.

- [ ] **Step 2: Write the migration SQL**

```sql
-- Migration 0059: marketing seed events (see
-- docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
--
-- `user.is_seed` marks a synthetic identity created only to occupy a seat on
-- a fake event; it never has a `telegram_account` row, so no code path can
-- resolve a chat id for it even if a future call site forgets to check the
-- flag. `event.is_seeded` marks the event itself, for admin filtering.
-- `city_seed_config` is the admin-tunable, per-city scheduler configuration;
-- absence of a row means the scheduler leaves that city alone.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "is_seed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "event" ADD COLUMN IF NOT EXISTS "is_seeded" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "city_seed_config" (
  "city_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "floor_count" INTEGER NOT NULL DEFAULT 1,
  "event_capacity" INTEGER NOT NULL DEFAULT 6,
  "fill_minutes" INTEGER NOT NULL DEFAULT 5,
  "host_user_id" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  "updated_by_admin_id" TEXT NOT NULL,

  CONSTRAINT "city_seed_config_pkey" PRIMARY KEY ("city_id")
);

ALTER TABLE "city_seed_config"
  ADD CONSTRAINT IF NOT EXISTS "city_seed_config_city_id_fkey"
  FOREIGN KEY ("city_id") REFERENCES "city"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "city_seed_config"
  ADD CONSTRAINT IF NOT EXISTS "city_seed_config_host_user_id_fkey"
  FOREIGN KEY ("host_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "city_seed_config_host_user_id_idx" ON "city_seed_config" ("host_user_id");
```

- [ ] **Step 3: Generate the client and build**

```bash
pnpm db:generate
make typecheck
```

Expected: both succeed. `make typecheck` will fail until later tasks add the
code that uses these new fields — if it fails only on files this task did not
touch, that is expected at this point; re-run it after Task 1's own files
compile (schema/client only, no application code yet, so it should be clean).

- [ ] **Step 4: Apply to the local and test databases**

```bash
pnpm db:migrate
```

(Follow the integration-tests skill for `payetam_test` — this task does not
run integration tests itself, but every later task's `*.int.test.ts` depends
on this migration being applied there too.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/00000000000059_seed_events
git commit -m "feat(db): add seed-event schema (user.is_seed, event.is_seeded, city_seed_config)"
```

---

### Task 2: Outbox safety — never message a seed identity

**Files:**
- Modify: `packages/domain/src/outbox/relay.service.ts:147-153`
- Test: `packages/domain/src/outbox/relay.int.test.ts`

**Interfaces:**
- Consumes: `User.isSeed` (Task 1)
- Produces: no interface change — `resolveUserId` keeps its
  `(publicId: string) => Promise<string | null>` signature; a seed user now
  resolves to `null`, identically to a deleted/anonymised one.

- [ ] **Step 1: Read the existing test file's setup helpers**

Open `packages/domain/src/outbox/relay.int.test.ts` and find its user-creation
helper (it will look like the `seedUser` helpers used elsewhere in this repo's
integration tests) — reuse it, don't duplicate it.

- [ ] **Step 2: Write the failing test**

Add to `packages/domain/src/outbox/relay.int.test.ts`:

```ts
it('quietly skips a seed identity, exactly like a deleted user', async () => {
  const seedUser = await prisma.user.create({
    data: { isSeed: true, onboardingState: 'PROFILE_COMPLETE' },
  });

  const row = await prisma.outboxEvent.create({
    data: {
      aggregateType: 'event_participant',
      aggregateId: 'irrelevant-for-this-test',
      eventType: 'participation.accepted',
      payload: { userPublicId: seedUser.publicId },
    },
  });

  const result = await relay.drain();

  expect(result.processed).toBe(1);
  expect(result.created).toBe(0);
  expect(result.queued).toHaveLength(0);
  const updated = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
  expect(updated.processedAt).not.toBeNull();
});
```

Adjust `eventType`/`payload` shape to match whatever `planNotifications` in
`packages/domain/src/notifications/fanout.ts` actually expects for a
single-recipient plan (read that file if the shape above does not compile —
the point of the test is a real plan that resolves to exactly one recipient).

- [ ] **Step 2: Run it, confirm it fails**

```bash
pnpm test:integration -- relay.int.test.ts
```

Expected: FAIL — today a seed user still resolves and a notification gets
queued, so `result.created` is `1`, not `0`.

- [ ] **Step 3: Implement the fix**

In `packages/domain/src/outbox/relay.service.ts`, replace `resolveUserId`:

```ts
private async resolveUserId(publicId: string): Promise<string | null> {
  const user = await this.prisma.user.findUnique({
    where: { publicId },
    select: { id: true, isSeed: true },
  });
  if (user === null) {
    return null;
  }
  if (user.isSeed) {
    // Expected, high-volume, and not a symptom of anything broken — a debug
    // line rather than the warn given to a genuinely unresolvable user.
    this.logger.debug(`outbox: skipping seed identity ${publicId}`);
    return null;
  }
  return user.id;
}
```

- [ ] **Step 4: Run it, confirm it passes**

```bash
pnpm test:integration -- relay.int.test.ts
```

Expected: PASS, and the pre-existing "no user for" test in the same file
still passes unmodified.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/outbox/relay.service.ts packages/domain/src/outbox/relay.int.test.ts
git commit -m "fix(outbox): never resolve a seed identity to a notifiable user"
```

---

### Task 3: `ParticipationService.seatSeedParticipant`

**Files:**
- Modify: `packages/domain/src/participation/participation.service.ts`
- Test: `packages/domain/src/participation/participation.service.int.test.ts`

**Interfaces:**
- Consumes: `lockEventByPublicIdForUpdate` (existing, `./event-lock`),
  private `takeSeat`/`assertSeatAvailable` (existing, same class)
- Produces:
  `async seatSeedParticipant(eventPublicId: string, userId: string): Promise<void>`
  — throws `AppError(ErrorCode.CAPACITY_EXCEEDED)` if the event is already
  full (same error real `accept()` throws), so callers do not need a
  separate capacity pre-check.

- [ ] **Step 1: Write the failing test**

Add to `packages/domain/src/participation/participation.service.int.test.ts`,
reusing that file's existing event/user seed helpers:

```ts
describe('seatSeedParticipant', () => {
  it('seats a participant directly into ACCEPTED and takes a seat', async () => {
    const host = await seedUser('میزبان');
    const event = await seedEvent(host, { capacity: 2 });
    const seed = await prisma.user.create({ data: { isSeed: true } });

    await service.seatSeedParticipant(event.publicId, seed.id);

    const participant = await prisma.eventParticipant.findFirstOrThrow({
      where: { eventId: event.id, userId: seed.id },
    });
    expect(participant.status).toBe('ACCEPTED');
    expect(participant.acceptedAt).not.toBeNull();

    const updatedEvent = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(updatedEvent.acceptedCount).toBe(1);
  });

  it('refuses once the event is full', async () => {
    const host = await seedUser('میزبان');
    const event = await seedEvent(host, { capacity: 1 });
    const first = await prisma.user.create({ data: { isSeed: true } });
    const second = await prisma.user.create({ data: { isSeed: true } });

    await service.seatSeedParticipant(event.publicId, first.id);

    await expect(service.seatSeedParticipant(event.publicId, second.id)).rejects.toThrow(
      /CAPACITY_EXCEEDED/,
    );
  });

  it('writes a SYSTEM audit row and emits no outbox notification', async () => {
    const host = await seedUser('میزبان');
    const event = await seedEvent(host, { capacity: 2 });
    const seed = await prisma.user.create({ data: { isSeed: true } });

    await service.seatSeedParticipant(event.publicId, seed.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetType: 'event_participant', action: 'participation.seed_seated' },
    });
    expect(audit.actorType).toBe('SYSTEM');

    const outboxCount = await prisma.outboxEvent.count({
      where: { aggregateType: 'event_participant', createdAt: { gte: event.createdAt } },
    });
    expect(outboxCount).toBe(0);
  });
});
```

Match `seedUser`/`seedEvent` helper names and signatures to whatever this
test file already defines — do not invent new ones if equivalents exist.

- [ ] **Step 2: Run, confirm failure**

```bash
pnpm test:integration -- participation.service.int.test.ts
```

Expected: FAIL — `seatSeedParticipant` does not exist yet (TypeScript
compile error surfaced as a test failure).

- [ ] **Step 3: Implement**

In `packages/domain/src/participation/participation.service.ts`, add a public
method near `accept()`:

```ts
/**
 * Seat a synthetic participant directly into ACCEPTED, under the same event
 * lock every other capacity-changing operation uses (ADR-0006). Used only by
 * the seeding module (`packages/domain/src/seeding/`) — there is no bot or
 * HTTP path that calls this, and it never emits an outbox notification:
 * there is nobody real on the other end to tell.
 */
async seatSeedParticipant(eventPublicId: string, userId: string): Promise<void> {
  const now = this.clock.now();
  const graceMinutes = await this.settings.getInt('participation.grace_minutes');

  await this.prisma.$transaction(
    async (tx) => {
      const event = await lockEventByPublicIdForUpdate(tx, eventPublicId);
      if (!event) throw new AppError(ErrorCode.NOT_FOUND);

      this.assertSeatAvailable(event);
      await this.takeSeat(tx, event);

      const participant = await tx.eventParticipant.create({
        data: {
          eventId: event.id,
          userId,
          status: 'ACCEPTED',
          requestedAt: now,
          decidedAt: now,
          acceptedAt: now,
          graceExpiresAt: new Date(now.getTime() + graceMinutes * 60_000),
        },
      });

      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'participation.seed_seated',
          targetType: 'event_participant',
          targetId: participant.id,
          before: null,
          after: { status: 'ACCEPTED' },
        },
        tx,
      );
    },
    { isolationLevel: 'ReadCommitted' },
  );
}
```

Check this class's existing imports already include `AppError`, `ErrorCode`
and `lockEventByPublicIdForUpdate`; if `assertSeatAvailable` throws a
different error than `CAPACITY_EXCEEDED` for this class, match the test to
whatever it actually throws rather than the other way around.

- [ ] **Step 4: Run, confirm pass**

```bash
pnpm test:integration -- participation.service.int.test.ts
```

Expected: PASS, all three new cases plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/participation/participation.service.ts packages/domain/src/participation/participation.service.int.test.ts
git commit -m "feat(participation): add seatSeedParticipant for the seeding module"
```

---

### Task 4: `seed-content.ts` — believable Persian text, no I/O

**Files:**
- Create: `packages/domain/src/seeding/seed-content.ts`
- Test: `packages/domain/src/seeding/seed-content.test.ts`

**Interfaces:**
- Produces:
  `pickSeedContent(input: { categoryNameFa: string; cityNameFa: string; random: () => number }): { title: string; description: string }`
  — pure function, no Prisma, no clock, an injected `random` (`() => number`
  in `[0, 1)`, same shape as `Math.random`) so the test is deterministic.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { pickSeedContent } from './seed-content';

describe('pickSeedContent', () => {
  it('is deterministic for a fixed random source', () => {
    const random = () => 0;
    const a = pickSeedContent({ categoryNameFa: 'کوهنوردی', cityNameFa: 'اصفهان', random });
    const b = pickSeedContent({ categoryNameFa: 'کوهنوردی', cityNameFa: 'اصفهان', random });
    expect(a).toEqual(b);
  });

  it('embeds the category and city names in the output', () => {
    const result = pickSeedContent({
      categoryNameFa: 'بازی رومیزی',
      cityNameFa: 'شیراز',
      random: () => 0.5,
    });
    expect(result.title).toContain('بازی رومیزی');
    expect(result.description).toContain('شیراز');
  });

  it('varies with the random source', () => {
    const results = new Set(
      [0, 0.2, 0.4, 0.6, 0.8].map(
        (r) =>
          pickSeedContent({ categoryNameFa: 'پیاده‌روی', cityNameFa: 'تبریز', random: () => r })
            .title,
      ),
    );
    expect(results.size).toBeGreaterThan(1);
  });

  it('never produces an empty title or description', () => {
    for (const r of [0, 0.1, 0.33, 0.5, 0.75, 0.99]) {
      const result = pickSeedContent({ categoryNameFa: 'یوگا', cityNameFa: 'مشهد', random: () => r });
      expect(result.title.trim().length).toBeGreaterThan(0);
      expect(result.description.trim().length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
pnpm test --project unit -- seed-content.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * A small, curated bank of believable Persian event text, filled in with a
 * category and city name — deliberately generic rather than per-category
 * slug, so it needs no catalogue data of its own and cannot go stale when
 * categories are renamed.
 *
 * `random` is injected (same shape as `Math.random`) so the picker is a pure,
 * deterministically-testable function — the caller supplies real randomness.
 */

const TITLE_TEMPLATES: ReadonlyArray<(category: string) => string> = [
  (category) => `دورهمی ${category}`,
  (category) => `${category} دوستانه، همه خوش‌ان`,
  (category) => `یک عصر با ${category}`,
  (category) => `${category} برای آشنایی با آدم‌های جدید`,
];

const DESCRIPTION_TEMPLATES: ReadonlyArray<(category: string, city: string) => string> = [
  (category, city) =>
    `یک برنامه‌ی ${category} کوچک و دوستانه در ${city}. اگر تازه‌کار هم باشید مشکلی نیست، فضا صمیمی‌ست.`,
  (category, city) =>
    `دنبال بهانه‌ای برای بیرون اومدن از خونه در ${city} هستید؟ این یک ${category} ساده و بی‌تکلف است.`,
  (category, city) =>
    `جمع کوچیکی برای ${category} در ${city} — هدف آشنایی و گذروندن وقت خوبه، نه رقابت.`,
];

export function pickSeedContent(input: {
  categoryNameFa: string;
  cityNameFa: string;
  random: () => number;
}): { title: string; description: string } {
  const titleIndex = Math.floor(input.random() * TITLE_TEMPLATES.length) % TITLE_TEMPLATES.length;
  const descriptionIndex =
    Math.floor(input.random() * DESCRIPTION_TEMPLATES.length) % DESCRIPTION_TEMPLATES.length;

  return {
    title: TITLE_TEMPLATES[titleIndex]!(input.categoryNameFa),
    description: DESCRIPTION_TEMPLATES[descriptionIndex]!(input.categoryNameFa, input.cityNameFa),
  };
}
```

Note: calling `random()` twice with a *constant* function (as in the
"varies with the random source" test, which passes a different constant each
call) still selects the same pair of indices both times within one call to
`pickSeedContent` — that's fine, the test asserts variation *across* calls
with different constants, not within one call.

- [ ] **Step 4: Run, confirm pass**

```bash
pnpm test --project unit -- seed-content.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/seeding/seed-content.ts packages/domain/src/seeding/seed-content.test.ts
git commit -m "feat(seeding): add pickSeedContent, a pure Persian text generator"
```

---

### Task 5: `SeedIdentityService`

**Files:**
- Create: `packages/domain/src/seeding/seed-identity.service.ts`
- Test: `packages/domain/src/seeding/seed-identity.service.int.test.ts`

**Interfaces:**
- Consumes: `User.isSeed` (Task 1)
- Produces:
  `async createSeedParticipant(cityId: string): Promise<{ userId: string }>`
  on `SeedIdentityService`

- [ ] **Step 1: Check `UserProfile`'s required fields**

Read `packages/db/prisma/schema.prisma`'s `model UserProfile` in full before
writing this task's code — confirm exactly which fields are required
(`displayName`, `cityId` are certain; confirm `gender`/`birthYear` nullability)
so the create call below does not omit a required field. Adjust the
implementation step to match what you find; the test does not need to change.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from 'vitest';
// ...this repo's standard int-test bootstrap imports...

describe('SeedIdentityService', () => {
  it('creates a User with isSeed=true and no telegramAccount row', async () => {
    const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });

    const { userId } = await service.createSeedParticipant(city.id);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { telegramAccount: true, profile: true },
    });
    expect(user.isSeed).toBe(true);
    expect(user.telegramAccount).toBeNull();
    expect(user.profile).not.toBeNull();
    expect(user.profile?.cityId).toBe(city.id);
    expect(user.onboardingState).toBe('PROFILE_COMPLETE');
  });

  it('produces a different display name on repeated calls', async () => {
    const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
    const a = await service.createSeedParticipant(city.id);
    const b = await service.createSeedParticipant(city.id);

    const [userA, userB] = await Promise.all([
      prisma.userProfile.findUniqueOrThrow({ where: { userId: a.userId } }),
      prisma.userProfile.findUniqueOrThrow({ where: { userId: b.userId } }),
    ]);
    expect(userA.displayName).not.toBe(userB.displayName);
  });
});
```

- [ ] **Step 3: Run, confirm failure**

```bash
pnpm test:integration -- seed-identity.service.int.test.ts
```

Expected: FAIL — service does not exist.

- [ ] **Step 4: Implement**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Gender } from '@payetam/db';

const FIRST_NAMES: Record<Gender, readonly string[]> = {
  MALE: ['علی', 'حسین', 'محمد', 'امیر', 'رضا', 'سامان', 'بهزاد', 'کیان'],
  FEMALE: ['سارا', 'نگین', 'مریم', 'الهام', 'پریسا', 'رها', 'یاسمن', 'ترانه'],
  PREFER_NOT_SAY: ['نیک', 'آرمان', 'شایان', 'رهام'],
};

const LAST_INITIALS = ['ر.', 'م.', 'ک.', 'ص.', 'ن.', 'ب.', 'ت.', 'ح.'];

const GENDERS: readonly Gender[] = ['MALE', 'FEMALE', 'PREFER_NOT_SAY'];

@Injectable()
export class SeedIdentityService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * A fresh, throwaway synthetic participant for one seed-event seat.
   *
   * Never reused across events (see the design spec's "explicitly out of
   * scope" section) — row growth is immaterial for a feature with a finite
   * useful life, and freshness avoids any bookkeeping about which identity
   * is "busy" on which event.
   */
  async createSeedParticipant(cityId: string): Promise<{ userId: string }> {
    const gender = GENDERS[Math.floor(Math.random() * GENDERS.length)]!;
    const firstName = pick(FIRST_NAMES[gender]);
    const lastInitial = pick(LAST_INITIALS);
    const birthYear = 1370 + Math.floor(Math.random() * 15); // Persian calendar, ~20–35 y/o

    const user = await this.prisma.user.create({
      data: {
        isSeed: true,
        onboardingState: 'PROFILE_COMPLETE',
        profile: {
          create: {
            displayName: `${firstName} ${lastInitial}`,
            gender,
            birthYear,
            cityId,
          },
        },
      },
      select: { id: true },
    });

    return { userId: user.id };
  }
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}
```

Adjust field names to whatever Task 5 Step 1 actually found on
`UserProfile` (e.g. if `birthYear` has a different valid range check
elsewhere, or `gender` has a different enum import path).

- [ ] **Step 5: Run, confirm pass**

```bash
pnpm test:integration -- seed-identity.service.int.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/seeding/seed-identity.service.ts packages/domain/src/seeding/seed-identity.service.int.test.ts
git commit -m "feat(seeding): add SeedIdentityService"
```

---

### Task 6: `SeedEventService` — create and fill

**Files:**
- Create: `packages/domain/src/seeding/seed-event.service.ts`
- Test: `packages/domain/src/seeding/seed-event.service.int.test.ts`

**Interfaces:**
- Consumes: `EventService.create(hostUserId: string, input: CreateEventInput): Promise<EventDetail>`
  (existing, `../events/event.service` — note `hostUserId` is the **internal**
  id, not the public id: `create()` writes it straight onto `Event.hostUserId`
  with no resolution step), `ParticipationService.seatSeedParticipant`
  (Task 3), `SeedIdentityService.createSeedParticipant` (Task 5),
  `pickSeedContent` (Task 4), `CitySeedConfig` (Task 1)
- Produces on `SeedEventService`:
  - `async createSeedEvent(cityId: string): Promise<{ eventPublicId: string }>`
  - `async fillStep(eventPublicId: string): Promise<{ done: boolean }>` — adds
    exactly one seat if the event is not yet full; `done: true` once
    `acceptedCount === capacity` (including when called on an already-full
    event, which is a no-op).

- [ ] **Step 1: Confirm the category source, and write a funded-host test helper**

Read `packages/domain/src/catalog/catalog.service.ts` for however it lists
active categories today (grep `isActive` in that file) — `createSeedEvent`
must pick from real, currently-active categories, not a hardcoded id.

`EventService.create` charges the host real coins (creation cost, plus a
channel-post charge once published — confirmed by reading
`event.service.ts:324-529`), so this file's `seedRealHost(cityId)` helper —
reused by every later task's tests too — must leave the returned user with
enough `CoinAccount` balance to survive several `create()` calls, not just a
real, complete profile. Check how this repo's existing event-creation
integration tests (grep `economy.event_create_coins` in
`event.service.int.test.ts`) fund a test host, and match that pattern
exactly rather than inventing a new one.

- [ ] **Step 2: Write the failing test**

```ts
describe('SeedEventService', () => {
  it('creates a PUBLISHED, isSeeded event hosted by the configured account', async () => {
    const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
    const host = await seedRealHost(city.id); // this file's own helper: a real, complete-profile, non-banned user
    await prisma.citySeedConfig.create({
      data: {
        cityId: city.id,
        enabled: true,
        eventCapacity: 4,
        floorCount: 1,
        fillMinutes: 5,
        hostUserId: host.id,
        updatedByAdminId: host.id, // any valid FK target for this test
      },
    });

    const { eventPublicId } = await service.createSeedEvent(city.id);

    const event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.isSeeded).toBe(true);
    expect(event.hostUserId).toBe(host.id);
    expect(event.status).toBe('PUBLISHED');
    expect(event.acceptedCount).toBe(0);
  });

  it('fillStep adds exactly one seat per call and reports done at capacity', async () => {
    const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
    const host = await seedRealHost(city.id);
    await prisma.citySeedConfig.create({
      data: {
        cityId: city.id,
        enabled: true,
        eventCapacity: 2,
        floorCount: 1,
        fillMinutes: 5,
        hostUserId: host.id,
        updatedByAdminId: host.id,
      },
    });
    const { eventPublicId } = await service.createSeedEvent(city.id);

    const first = await service.fillStep(eventPublicId);
    expect(first.done).toBe(false);
    let event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.acceptedCount).toBe(1);

    const second = await service.fillStep(eventPublicId);
    expect(second.done).toBe(true);
    event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.acceptedCount).toBe(2);

    const third = await service.fillStep(eventPublicId);
    expect(third.done).toBe(true);
    event = await prisma.event.findUniqueOrThrow({ where: { publicId: eventPublicId } });
    expect(event.acceptedCount).toBe(2); // unchanged — no-op past capacity
  });
});
```

- [ ] **Step 3: Run, confirm failure**

```bash
pnpm test:integration -- seed-event.service.int.test.ts
```

- [ ] **Step 4: Implement**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { EventService } from '../events/event.service';
import { ParticipationService } from '../participation/participation.service';
import { pickSeedContent } from './seed-content';
import { SeedIdentityService } from './seed-identity.service';

const EVENT_DURATION_MS = 2 * 60 * 60 * 1000; // 2-hour activity, consistent with the content bank's tone
const STARTS_IN_MS = 3 * 60 * 60 * 1000; // starts 3 hours after creation — enough time to actually fill

@Injectable()
export class SeedEventService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly events: EventService,
    private readonly participation: ParticipationService,
    private readonly identities: SeedIdentityService,
  ) {}

  async createSeedEvent(cityId: string): Promise<{ eventPublicId: string }> {
    const config = await this.prisma.citySeedConfig.findUniqueOrThrow({ where: { cityId } });
    const [city, category] = await Promise.all([
      this.prisma.city.findUniqueOrThrow({ where: { id: cityId }, select: { nameFa: true } }),
      this.prisma.category.findFirstOrThrow({
        where: { isActive: true, allowsCustomLabel: false },
        select: { id: true, nameFa: true },
      }),
    ]);

    const content = pickSeedContent({
      categoryNameFa: category.nameFa,
      cityNameFa: city.nameFa,
      random: Math.random,
    });

    const now = this.clock.now();
    // `create()` is the real path the bot wizard calls — same quota
    // (5/day, 3 concurrent per host), same coin charge for creation and,
    // since this content always scans CLEAN and resolves PUBLISHED, the
    // same automatic channel-post charge. Both quota and coin exhaustion
    // are expected, handled failure modes at the scheduler layer (Task 7),
    // not something this method should catch — a config error at the
    // per-event level should surface, not be swallowed here.
    const created = await this.events.create(config.hostUserId, {
      title: content.title,
      description: content.description,
      categoryId: category.id,
      cityId,
      startsAt: new Date(now.getTime() + STARTS_IN_MS),
      endsAt: new Date(now.getTime() + STARTS_IN_MS + EVENT_DURATION_MS),
      capacity: config.eventCapacity,
      costType: 'FREE',
    });

    await this.prisma.event.update({
      where: { publicId: created.publicId },
      data: { isSeeded: true },
    });

    return { eventPublicId: created.publicId };
  }

  /** Adds one synthetic seat. A no-op, reporting `done: true`, once full. */
  async fillStep(eventPublicId: string): Promise<{ done: boolean }> {
    const event = await this.prisma.event.findUniqueOrThrow({
      where: { publicId: eventPublicId },
      select: { id: true, cityId: true, acceptedCount: true, capacity: true },
    });

    if (event.acceptedCount >= event.capacity) {
      return { done: true };
    }

    const { userId } = await this.identities.createSeedParticipant(event.cityId);
    await this.participation.seatSeedParticipant(eventPublicId, userId);

    return { done: event.acceptedCount + 1 >= event.capacity };
  }
}
```

`EventService.create`'s return is `EventDetail`, which carries `publicId`
(confirmed from `event.service.ts:324-529`, read in full while writing this
plan — `create()` ends `return this.findOwned(hostUserId, created)` where
`created` is the new event's `publicId`; `EventDetail`'s exact field list is
defined further up that file, grep `interface EventDetail` if the property
name needs re-confirming at implementation time). `CostType.FREE` is
confirmed valid (`schema.prisma:1069-1075`).

- [ ] **Step 5: Run, confirm pass**

```bash
pnpm test:integration -- seed-event.service.int.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/seeding/seed-event.service.ts packages/domain/src/seeding/seed-event.service.int.test.ts
git commit -m "feat(seeding): add SeedEventService (createSeedEvent, fillStep)"
```

---

### Task 7: `SeedSchedulerService` — the sweep the worker calls

**Files:**
- Create: `packages/domain/src/seeding/seed-scheduler.service.ts`
- Test: `packages/domain/src/seeding/seed-scheduler.service.int.test.ts`

**Interfaces:**
- Consumes: `SeedEventService` (Task 6), `CitySeedConfig`/`City.isLaunched` (Task 1)
- Produces on `SeedSchedulerService`:
  - `async topUp(): Promise<{ created: number }>` — for every
    `enabled && city.isLaunched` config, create seed events until the
    floor is met
  - `async fill(): Promise<{ steps: number }>` — one `fillStep` per
    not-yet-full seed event that is due another seat, given `fillMinutes`
    and its `createdAt`

- [ ] **Step 1: Write the failing tests**

```ts
describe('SeedSchedulerService', () => {
  describe('topUp', () => {
    it('creates events up to the floor for an enabled, launched city', async () => {
      const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
      const host = await seedRealHost(city.id);
      await prisma.citySeedConfig.create({
        data: {
          cityId: city.id,
          enabled: true,
          floorCount: 3,
          eventCapacity: 4,
          fillMinutes: 5,
          hostUserId: host.id,
          updatedByAdminId: host.id,
        },
      });

      const result = await scheduler.topUp();

      expect(result.created).toBe(3);
      const count = await prisma.event.count({
        where: { cityId: city.id, isSeeded: true, status: 'PUBLISHED' },
      });
      expect(count).toBe(3);
    });

    it('does nothing for a disabled config', async () => {
      const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
      const host = await seedRealHost(city.id);
      await prisma.citySeedConfig.create({
        data: {
          cityId: city.id,
          enabled: false,
          floorCount: 2,
          eventCapacity: 4,
          fillMinutes: 5,
          hostUserId: host.id,
          updatedByAdminId: host.id,
        },
      });

      const result = await scheduler.topUp();
      expect(result.created).toBe(0);
    });

    it('does not exceed the floor once it is already met', async () => {
      const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
      const host = await seedRealHost(city.id);
      await prisma.citySeedConfig.create({
        data: {
          cityId: city.id,
          enabled: true,
          floorCount: 1,
          eventCapacity: 4,
          fillMinutes: 5,
          hostUserId: host.id,
          updatedByAdminId: host.id,
        },
      });

      await scheduler.topUp();
      const second = await scheduler.topUp();

      expect(second.created).toBe(0);
    });
  });

  describe('fill', () => {
    it('advances an event that is due another seat and skips one that is not', async () => {
      const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
      const host = await seedRealHost(city.id);
      await prisma.citySeedConfig.create({
        data: {
          cityId: city.id,
          enabled: true,
          floorCount: 1,
          eventCapacity: 4,
          fillMinutes: 5,
          hostUserId: host.id,
          updatedByAdminId: host.id,
        },
      });
      await scheduler.topUp();
      const event = await prisma.event.findFirstOrThrow({ where: { cityId: city.id, isSeeded: true } });
      // Backdate creation so "due for a seat" is unambiguously true for a
      // 5-minute fill window.
      await prisma.event.update({
        where: { id: event.id },
        data: { createdAt: new Date(Date.now() - 4 * 60 * 1000) },
      });

      const result = await scheduler.fill();

      expect(result.steps).toBeGreaterThanOrEqual(1);
      const updated = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(updated.acceptedCount).toBeGreaterThanOrEqual(1);
    });
  });
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
pnpm test:integration -- seed-scheduler.service.int.test.ts
```

- [ ] **Step 3: Implement**

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { SeedEventService } from './seed-event.service';

@Injectable()
export class SeedSchedulerService {
  private readonly logger = new Logger(SeedSchedulerService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly seedEvents: SeedEventService,
  ) {}

  /**
   * Create seed events for every enabled, launched city, up to its floor.
   *
   * `floorCount` is contract-capped at 3 (`packages/shared/src/contracts/seed-events.ts`)
   * because that is `EventService`'s own concurrent-active-per-host quota —
   * see the spec's "confirmed constraint" section. One city's host running
   * out of coins or quota (`INSUFFICIENT_COINS` / `EVENT_QUOTA_EXCEEDED`)
   * must not stop the sweep for every other city, so each attempt is
   * isolated.
   */
  async topUp(): Promise<{ created: number }> {
    const configs = await this.prisma.citySeedConfig.findMany({
      where: { enabled: true, city: { isLaunched: true } },
      select: { cityId: true, floorCount: true },
    });

    let created = 0;
    for (const config of configs) {
      const filling = await this.countFillingEvents(config.cityId);
      const toCreate = Math.max(0, config.floorCount - filling);
      for (let i = 0; i < toCreate; i += 1) {
        try {
          await this.seedEvents.createSeedEvent(config.cityId);
          created += 1;
        } catch (error) {
          // Expected under quota/coin exhaustion — log and move on to the
          // next city rather than losing the rest of the pass. A city stuck
          // this way is visible in the admin screen as `fillingEventCount`
          // staying below `floorCount`.
          this.logger.warn(
            `Seed top-up failed for city ${config.cityId}: ${String(error)}`,
          );
          break; // further attempts for this same city will fail the same way
        }
      }
    }
    return { created };
  }

  /** Seed events not yet at capacity — a plain column comparison via `$queryRaw`,
   * since Prisma's query builder cannot express `accepted_count < capacity`. */
  private async countFillingEvents(cityId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count FROM "event"
      WHERE "city_id" = ${cityId}
        AND "is_seeded" = true
        AND "status" = 'PUBLISHED'
        AND "accepted_count" < "capacity"
    `;
    return Number(rows[0]?.count ?? 0n);
  }

  /** Advance every seed event that is due its next seat. */
  async fill(): Promise<{ steps: number }> {
    const now = this.clock.now();
    const candidates = await this.prisma.event.findMany({
      where: { isSeeded: true, status: 'PUBLISHED' },
      select: {
        publicId: true,
        cityId: true,
        createdAt: true,
        capacity: true,
        acceptedCount: true,
      },
    });

    let steps = 0;
    for (const event of candidates) {
      if (event.acceptedCount >= event.capacity) continue;

      const config = await this.prisma.citySeedConfig.findUnique({
        where: { cityId: event.cityId },
        select: { fillMinutes: true },
      });
      if (!config) continue;

      if (isDueForSeat({ event, config, now })) {
        await this.seedEvents.fillStep(event.publicId);
        steps += 1;
      }
    }
    return { steps };
  }
}

/**
 * Whether a seed event has "waited its turn" for another seat, given a
 * target fill window spread evenly across its remaining seats. Pure and
 * exported so the pacing decision is unit-testable without a database.
 */
export function isDueForSeat(input: {
  event: { createdAt: Date; capacity: number; acceptedCount: number };
  config: { fillMinutes: number };
  now: Date;
}): boolean {
  const { event, config, now } = input;
  const elapsedMs = now.getTime() - event.createdAt.getTime();
  const windowMs = config.fillMinutes * 60_000;
  const targetFraction = Math.min(1, elapsedMs / windowMs);
  const targetSeats = Math.ceil(targetFraction * event.capacity);
  return targetSeats > event.acceptedCount;
}
```

`countFillingEvents` above uses `$queryRaw` for the column-to-column
comparison (`accepted_count < capacity`) that Prisma's query builder cannot
express — confirm this repo's `$queryRaw` usage elsewhere (e.g.
`event-lock.ts`) uses the same tagged-template parameterization style before
finalizing, so this matches existing convention rather than introducing a
second style.

- [ ] **Step 4: Add the unit test for `isDueForSeat`**

Create/extend `packages/domain/src/seeding/seed-scheduler.service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isDueForSeat } from './seed-scheduler.service';

describe('isDueForSeat', () => {
  const config = { fillMinutes: 5 };

  it('is not due immediately after creation', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const event = { createdAt: now, capacity: 4, acceptedCount: 0 };
    expect(isDueForSeat({ event, config, now })).toBe(false);
  });

  it('is due once enough of the window has elapsed for the next seat', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 3 * 60_000); // 3 of 5 minutes, capacity 4
    const event = { createdAt, capacity: 4, acceptedCount: 1 };
    expect(isDueForSeat({ event, config, now })).toBe(true);
  });

  it('is not due again immediately after reaching the expected pace', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 3 * 60_000);
    const event = { createdAt, capacity: 4, acceptedCount: 3 }; // already ahead of pace
    expect(isDueForSeat({ event, config, now })).toBe(false);
  });

  it('is due for the last seat once the window has fully elapsed', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const now = new Date(createdAt.getTime() + 5 * 60_000);
    const event = { createdAt, capacity: 4, acceptedCount: 3 };
    expect(isDueForSeat({ event, config, now })).toBe(true);
  });
});
```

- [ ] **Step 5: Run everything, confirm pass**

```bash
pnpm test --project unit -- seed-scheduler.service.test.ts
pnpm test:integration -- seed-scheduler.service.int.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/seeding/seed-scheduler.service.ts packages/domain/src/seeding/seed-scheduler.service.test.ts packages/domain/src/seeding/seed-scheduler.service.int.test.ts
git commit -m "feat(seeding): add SeedSchedulerService (topUp, fill)"
```

---

### Task 8: `SeedingModule` and domain barrel export

**Files:**
- Create: `packages/domain/src/seeding/seeding.module.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: `SeedingModule` (Nest module), exporting
  `SeedEventService`, `SeedSchedulerService`, `SeedIdentityService`

- [ ] **Step 1: Write the module**

```ts
import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EventsModule } from '../events/events.module';
import { ParticipationModule } from '../participation/participation.module';
import { SeedEventService } from './seed-event.service';
import { SeedIdentityService } from './seed-identity.service';
import { SeedSchedulerService } from './seed-scheduler.service';

// `EventsModule` for `EventService` (real event creation) — `AppModule`
// importing both is not enough; Nest scopes providers to the module that
// declares them. `ParticipationModule` for `seatSeedParticipant`.
// `CatalogModule` only if `CatalogService` ends up used directly by a later
// task; `SeedEventService` as written in Task 6 queries `city`/`category`
// via `PrismaService` directly, so drop this import if nothing in the
// finished module actually needs `CatalogService`.
@Module({
  imports: [EventsModule, ParticipationModule, CatalogModule],
  providers: [SeedEventService, SeedIdentityService, SeedSchedulerService],
  exports: [SeedEventService, SeedIdentityService, SeedSchedulerService],
})
export class SeedingModule {}
```

- [ ] **Step 2: Export from the domain barrel**

In `packages/domain/src/index.ts`, add (matching the existing alphabetical/
grouped style around the `EventsModule`/`ParticipationModule` exports):

```ts
export { SeedingModule } from './seeding/seeding.module';
export { SeedEventService } from './seeding/seed-event.service';
export { SeedIdentityService } from './seeding/seed-identity.service';
export { SeedSchedulerService } from './seeding/seed-scheduler.service';
```

- [ ] **Step 3: Build and typecheck**

```bash
make typecheck
```

Expected: PASS. Fix any import-cycle or unused-import errors now — this is
the task where module wiring mistakes surface.

- [ ] **Step 4: Commit**

```bash
git add packages/domain/src/seeding/seeding.module.ts packages/domain/src/index.ts
git commit -m "feat(seeding): add SeedingModule and export it from the domain barrel"
```

---

### Task 9: Permission and admin API contracts

**Files:**
- Modify: `packages/shared/src/contracts/permissions.ts`
- Create: `packages/shared/src/contracts/seed-events.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `PERMISSIONS.EVENT_SEED_MANAGE`, and zod schemas/types:
  `citySeedConfigView`, `CitySeedConfigView`, `updateCitySeedConfigRequest`,
  `UpdateCitySeedConfigRequest`, `seedEventsCitiesResponse`,
  `SeedEventsCitiesResponse`

- [ ] **Step 1: Add the permission**

In `packages/shared/src/contracts/permissions.ts`, inside the `PERMISSIONS`
object, add (after `ROLE_MANAGE`, before the closing `} as const;`):

```ts
  /**
   * Configure and run the marketing seed-event scheduler for a city.
   *
   * `SUPER_ADMIN` only, at the same sensitivity tier as `coin.adjust` and
   * `giftcode.manage`: this tool fabricates public-facing platform data
   * (see docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
   */
  EVENT_SEED_MANAGE: 'event.seed.manage',
```

- [ ] **Step 2: Write the contract file**

```ts
import { z } from 'zod';

export const citySeedConfigView = z.object({
  cityId: z.string(),
  cityNameFa: z.string(),
  isLaunched: z.boolean(),
  enabled: z.boolean(),
  floorCount: z.number().int().min(0),
  eventCapacity: z.number().int().min(1),
  fillMinutes: z.number().int().min(1),
  hostUserPublicId: z.string().nullable(),
  hostDisplayName: z.string().nullable(),
  fillingEventCount: z.number().int().min(0),
});
export type CitySeedConfigView = z.infer<typeof citySeedConfigView>;

export const seedEventsCitiesResponse = z.object({
  cities: z.array(citySeedConfigView),
});
export type SeedEventsCitiesResponse = z.infer<typeof seedEventsCitiesResponse>;

export const updateCitySeedConfigRequest = z.object({
  enabled: z.boolean().optional(),
  // Capped at 3, not a round product number: `EventService` allows at most
  // 3 concurrently-active (not-yet-started) events per host, so a
  // `floorCount` above 3 could never actually be reached by one dedicated
  // host account (see the design spec's "confirmed constraint" section).
  floorCount: z.number().int().min(0).max(3).optional(),
  eventCapacity: z.number().int().min(1).max(50).optional(),
  fillMinutes: z.number().int().min(1).max(240).optional(),
  hostUserPublicId: z.string().optional(),
});
export type UpdateCitySeedConfigRequest = z.infer<typeof updateCitySeedConfigRequest>;
```

- [ ] **Step 3: Export from the shared barrel**

In `packages/shared/src/index.ts`, add the export line for
`./contracts/seed-events` next to the other `./contracts/*` exports, matching
the existing style (check whether this file re-exports `*` or named symbols
per contract file, and match it).

- [ ] **Step 4: Typecheck**

```bash
make typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/contracts/permissions.ts packages/shared/src/contracts/seed-events.ts packages/shared/src/index.ts
git commit -m "feat(shared): add event.seed.manage permission and seed-events contracts"
```

---

### Task 10: `SeedAdminService`

**Files:**
- Create: `packages/domain/src/adminaccess/seed-admin.service.ts`
- Test: `packages/domain/src/adminaccess/seed-admin.int.test.ts`
- Modify: `packages/domain/src/adminaccess/adminaccess.module.ts`

**Interfaces:**
- Consumes: `AdminAccessService.assertPermission`,
  `PERMISSIONS.EVENT_SEED_MANAGE` (Task 9), `AuditService.record`
  (`@Global`, no import needed)
- Produces on `SeedAdminService`:
  - `async listCities(session: AdminSession): Promise<CitySeedConfigView[]>`
  - `async updateConfig(session: AdminSession, cityId: string, input: UpdateCitySeedConfigRequest): Promise<CitySeedConfigView>`

- [ ] **Step 1: Read the neighboring pattern**

Read `packages/domain/src/adminaccess/geography-admin.service.ts` in full
before writing this task — match its constructor injection style
(`PrismaService`, `AdminAccessService` as `this.access`, `AuditService` as
`this.audit`, `CLOCK`), its `assertPermission` placement, and its audit-call
shape exactly.

- [ ] **Step 2: Write the failing tests**

```ts
describe('SeedAdminService', () => {
  describe('listCities', () => {
    it('refuses a session without event.seed.manage', async () => {
      const session = await sessionWithout(PERMISSIONS.EVENT_SEED_MANAGE);
      await expect(service.listCities(session)).rejects.toThrow(/FORBIDDEN|PERMISSION/);
    });

    it('lists every launched city, configured or not', async () => {
      const session = await sessionWith(PERMISSIONS.EVENT_SEED_MANAGE);
      const launchedCount = await prisma.city.count({ where: { isLaunched: true } });

      const cities = await service.listCities(session);

      expect(cities).toHaveLength(launchedCount);
      expect(cities.every((c) => c.enabled === false)).toBe(true); // none configured yet
    });
  });

  describe('updateConfig', () => {
    it('creates a config row on first write and audits it', async () => {
      const session = await sessionWith(PERMISSIONS.EVENT_SEED_MANAGE);
      const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
      const host = await seedRealHost(city.id);

      const result = await service.updateConfig(session, city.id, {
        enabled: true,
        floorCount: 2,
        eventCapacity: 5,
        fillMinutes: 5,
        hostUserPublicId: host.publicId,
      });

      expect(result.enabled).toBe(true);
      expect(result.floorCount).toBe(2);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { targetType: 'city_seed_config', targetId: city.id },
      });
      expect(audit.actorType).toBe('ADMIN');
    });

    it('refuses a host that is itself a seed identity', async () => {
      const session = await sessionWith(PERMISSIONS.EVENT_SEED_MANAGE);
      const city = await prisma.city.findFirstOrThrow({ where: { isLaunched: true } });
      const fakeHost = await prisma.user.create({ data: { isSeed: true } });

      await expect(
        service.updateConfig(session, city.id, { hostUserPublicId: fakeHost.publicId }),
      ).rejects.toThrow();
    });
  });
});
```

Match `sessionWith`/`sessionWithout`/`seedRealHost` to whatever helpers this
test suite (or a sibling `*-admin.int.test.ts` in the same directory) already
defines for building an `AdminSession` with a given permission set — reuse,
don't duplicate.

- [ ] **Step 3: Run, confirm failure**

```bash
pnpm test:integration -- seed-admin.int.test.ts
```

- [ ] **Step 4: Implement**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode, PERMISSIONS } from '@payetam/shared';
import type { CitySeedConfigView, UpdateCitySeedConfigRequest } from '@payetam/shared';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class SeedAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  async listCities(session: AdminSession): Promise<CitySeedConfigView[]> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_SEED_MANAGE);

    const cities = await this.prisma.city.findMany({
      where: { isLaunched: true },
      select: {
        id: true,
        nameFa: true,
        isLaunched: true,
        seedConfig: {
          select: {
            enabled: true,
            floorCount: true,
            eventCapacity: true,
            fillMinutes: true,
            host: { select: { publicId: true, profile: { select: { displayName: true } } } },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });

    const fillingCounts = await this.prisma.event.groupBy({
      by: ['cityId'],
      where: { isSeeded: true, status: 'PUBLISHED' },
      _count: { _all: true },
    });
    const fillingByCity = new Map(fillingCounts.map((row) => [row.cityId, row._count._all]));

    return cities.map((city) => ({
      cityId: city.id,
      cityNameFa: city.nameFa,
      isLaunched: city.isLaunched,
      enabled: city.seedConfig?.enabled ?? false,
      floorCount: city.seedConfig?.floorCount ?? 0,
      eventCapacity: city.seedConfig?.eventCapacity ?? 6,
      fillMinutes: city.seedConfig?.fillMinutes ?? 5,
      hostUserPublicId: city.seedConfig?.host.publicId ?? null,
      hostDisplayName: city.seedConfig?.host.profile?.displayName ?? null,
      fillingEventCount: fillingByCity.get(city.id) ?? 0,
    }));
  }

  async updateConfig(
    session: AdminSession,
    cityId: string,
    input: UpdateCitySeedConfigRequest,
  ): Promise<CitySeedConfigView> {
    this.access.assertPermission(session, PERMISSIONS.EVENT_SEED_MANAGE);

    const city = await this.prisma.city.findUnique({ where: { id: cityId } });
    if (!city || !city.isLaunched) throw new AppError(ErrorCode.NOT_FOUND);

    const existing = await this.prisma.citySeedConfig.findUnique({ where: { cityId } });

    let hostUserId = existing?.hostUserId;
    if (input.hostUserPublicId !== undefined) {
      const host = await this.prisma.user.findUnique({
        where: { publicId: input.hostUserPublicId },
        select: { id: true, isSeed: true, status: true },
      });
      if (!host || host.isSeed || host.status !== 'ACTIVE') {
        throw new AppError(ErrorCode.VALIDATION_ERROR);
      }
      hostUserId = host.id;
    }
    if (hostUserId === undefined) {
      // First write for this city must name a host — there is no default.
      throw new AppError(ErrorCode.VALIDATION_ERROR);
    }

    const saved = await this.prisma.citySeedConfig.upsert({
      where: { cityId },
      create: {
        cityId,
        enabled: input.enabled ?? false,
        floorCount: input.floorCount ?? 1,
        eventCapacity: input.eventCapacity ?? 6,
        fillMinutes: input.fillMinutes ?? 5,
        hostUserId,
        updatedByAdminId: session.adminId,
      },
      update: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.floorCount !== undefined ? { floorCount: input.floorCount } : {}),
        ...(input.eventCapacity !== undefined ? { eventCapacity: input.eventCapacity } : {}),
        ...(input.fillMinutes !== undefined ? { fillMinutes: input.fillMinutes } : {}),
        hostUserId,
        updatedByAdminId: session.adminId,
      },
      select: {
        enabled: true,
        floorCount: true,
        eventCapacity: true,
        fillMinutes: true,
        host: { select: { publicId: true, profile: { select: { displayName: true } } } },
      },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminId,
      action: existing ? 'seed_config.updated' : 'seed_config.created',
      targetType: 'city_seed_config',
      targetId: cityId,
      before: existing ?? null,
      after: saved,
    });

    return {
      cityId,
      cityNameFa: city.nameFa,
      isLaunched: city.isLaunched,
      enabled: saved.enabled,
      floorCount: saved.floorCount,
      eventCapacity: saved.eventCapacity,
      fillMinutes: saved.fillMinutes,
      hostUserPublicId: saved.host.publicId,
      hostDisplayName: saved.host.profile?.displayName ?? null,
      fillingEventCount: 0,
    };
  }
}
```

Match `AdminSession`'s actual shape (`session.adminId` vs. some other field
name — check `admin-access.service.ts`) and `AppError`/`ErrorCode` member
names (`VALIDATION_ERROR` may be spelled differently — grep
`packages/shared/src/errors.ts`) before finalizing; adjust both the test and
implementation together if either assumption is wrong.

- [ ] **Step 5: Wire into `AdminAccessModule`**

In `packages/domain/src/adminaccess/adminaccess.module.ts`, add
`SeedAdminService` to both `providers` and `exports`.

- [ ] **Step 6: Export from the domain barrel**

In `packages/domain/src/index.ts`, add:
`export { SeedAdminService } from './adminaccess/seed-admin.service';`

- [ ] **Step 7: Run, confirm pass**

```bash
pnpm test:integration -- seed-admin.int.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/adminaccess/seed-admin.service.ts packages/domain/src/adminaccess/seed-admin.int.test.ts packages/domain/src/adminaccess/adminaccess.module.ts packages/domain/src/index.ts
git commit -m "feat(adminaccess): add SeedAdminService"
```

---

### Task 11: Admin API endpoints

**Files:**
- Modify: `apps/api/src/admin/admin.controller.ts`
- Modify: `apps/api/src/response-leak.int.test.ts`
- Modify: `apps/api/src/app.module.test.ts`

**Interfaces:**
- Consumes: `SeedAdminService` (Task 10), contracts from Task 9
- Produces: `GET /admin/v1/seed-events/cities`,
  `PATCH /admin/v1/seed-events/cities/:cityId`

- [ ] **Step 1: Add the constructor dependency**

Find `AdminController`'s constructor (near line 239) and add
`private readonly seedAdmin: SeedAdminService,` alongside the other injected
admin services, plus the corresponding import at the top of the file.

- [ ] **Step 2: Add the endpoints**

Near the `cities`/catalog endpoints (~line 1840), add:

```ts
@Get('seed-events/cities')
async listSeedCities(@CurrentAdmin() admin: AdminSession): Promise<SeedEventsCitiesResponse> {
  return { cities: await this.seedAdmin.listCities(admin) };
}

@Patch('seed-events/cities/:cityId')
async updateSeedCity(
  @Param('cityId') cityId: string,
  @Body(new ZodValidationPipe(updateCitySeedConfigRequest)) body: UpdateCitySeedConfigRequest,
  @CurrentAdmin() admin: AdminSession,
): Promise<CitySeedConfigView> {
  return this.seedAdmin.updateConfig(admin, cityId, body);
}
```

Add `updateCitySeedConfigRequest`, `UpdateCitySeedConfigRequest`,
`CitySeedConfigView`, `SeedEventsCitiesResponse` to the file's existing
`@payetam/shared` import block.

- [ ] **Step 3: Add to the response-leak test**

In `apps/api/src/response-leak.int.test.ts`, find how an existing
`GET`/`PATCH` pair under `/admin/v1/` is asserted (grep e.g. `'cities'` in
that file) and add the same shape of assertion for
`GET /admin/v1/seed-events/cities` and
`PATCH /admin/v1/seed-events/cities/:cityId`, confirming neither response
body contains a `telegramUserId`/`telegram_user_id` key at any depth.

- [ ] **Step 4: Confirm module wiring resolves**

Run:

```bash
pnpm test --project unit -- app.module.test.ts
```

If it fails to resolve `SeedAdminService`, trace which module
`AdminController` lives in (`apps/api/src/admin/*.module.ts` or the root
`apps/api/src/app.module.ts`) and confirm `AdminAccessModule` (which now
exports `SeedAdminService` per Task 10) is imported there — add the import if
missing, matching how every other `*AdminService` already reaches this
controller.

- [ ] **Step 5: Run the full API integration slice**

```bash
make typecheck
pnpm test:integration -- response-leak.int.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/admin/admin.controller.ts apps/api/src/response-leak.int.test.ts apps/api/src/app.module.test.ts
git commit -m "feat(api): add admin endpoints for the seed-event scheduler"
```

---

### Task 12: Worker scheduling

**Files:**
- Modify: `packages/platform/src/queue/queues.ts`
- Modify: `apps/worker/src/queues/processors.service.ts`
- Modify: `apps/worker/src/app.module.ts`
- Modify: `apps/worker/src/app.module.test.ts`

**Interfaces:**
- Consumes: `SeedSchedulerService` (Task 7)
- Produces: `JOBS.SEED_TOPUP`, `JOBS.SEED_FILL` dispatched on their own cron
  cadence

- [ ] **Step 1: Add the job names**

In `packages/platform/src/queue/queues.ts`, inside the `JOBS` object (near
`SETTLE_HOST_REWARDS`), add:

```ts
  /**
   * Create seed events up to each configured city's floor (marketing seed
   * events, see docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
   */
  SEED_TOPUP: 'seed-topup',
  /** Advance every filling seed event that is due its next seat. */
  SEED_FILL: 'seed-fill',
```

- [ ] **Step 2: Add the schedule entries**

In the `SCHEDULE` array, add:

```ts
  /**
   * Every five minutes — cheap enough to run often, and floorCount is small
   * per city, so there is never much to create in one pass.
   */
  { name: JOBS.SEED_TOPUP, pattern: '*/5 * * * *' },
  /**
   * Every minute — `fillMinutes` is typically ~5, so a coarser cadence would
   * make the "filling live" effect look stepped rather than organic.
   */
  { name: JOBS.SEED_FILL, pattern: '* * * * *' },
```

- [ ] **Step 3: Dispatch the jobs**

In `apps/worker/src/queues/processors.service.ts`, add the constructor
dependency `private readonly seedScheduler: SeedSchedulerService,` (with its
import), and add near the other `case JOBS...:` blocks:

```ts
case JOBS.SEED_TOPUP: {
  const result = await this.seedScheduler.topUp();
  if (result.created > 0) {
    this.logger.log(`Seed scheduler created ${String(result.created)} event(s)`);
  }
  return;
}

case JOBS.SEED_FILL: {
  const result = await this.seedScheduler.fill();
  if (result.steps > 0) {
    this.logger.log(`Seed scheduler advanced ${String(result.steps)} event(s)`);
  }
  return;
}
```

- [ ] **Step 4: Wire the module**

In `apps/worker/src/app.module.ts`, add `SeedingModule` to the
`@payetam/domain` import list and to the `@Module({ imports: [...] })` array.

- [ ] **Step 5: Confirm module resolution**

```bash
pnpm test --project unit -- apps/worker/src/app.module.test.ts
```

If `SeedSchedulerService` fails to resolve inside `Processors`, check whether
`SeedingModule`'s own imports (Task 8) already give it everything it needs,
or whether `Processors`' module also needs `EventsModule`/
`ParticipationModule` directly — match however `EventLifecycleService`
already resolves into the same `Processors` class today.

- [ ] **Step 6: Typecheck and unit test**

```bash
make typecheck
pnpm test --project unit
```

- [ ] **Step 7: Commit**

```bash
git add packages/platform/src/queue/queues.ts apps/worker/src/queues/processors.service.ts apps/worker/src/app.module.ts apps/worker/src/app.module.test.ts
git commit -m "feat(worker): schedule the seed-event top-up and fill sweeps"
```

---

### Task 13: Admin panel UI

**Files:**
- Create: `apps/admin/src/views/SeedEventsView.vue`
- Modify: `apps/admin/src/router.ts`

**Interfaces:**
- Consumes: `GET /admin/v1/seed-events/cities`,
  `PATCH /admin/v1/seed-events/cities/:cityId` (Task 11),
  `PERMISSIONS.EVENT_SEED_MANAGE` (Task 9)

- [ ] **Step 1: Read the reference view**

Read `apps/admin/src/views/CampaignView.vue` in full (already read once
during design; re-read for the exact `request`/`messageOf`/`StateBlock`
usage) — this new view follows the same shape: a `load()` function, a
`state` computed (`loading`/`error`/`ready`), Persian error copy via
`messageOf(cause, 'پیام پیش‌فرض')`.

- [ ] **Step 2: Add the route**

In `apps/admin/src/router.ts`, add near the `catalog.manage`-gated route:

```ts
{
  path: '/seed-events',
  name: 'seed-events',
  component: () => import('@/views/SeedEventsView.vue'),
  meta: {
    title: 'رویدادهای بازاریابی',
    permission: PERMISSIONS.EVENT_SEED_MANAGE,
    group: 'system',
  },
},
```

- [ ] **Step 3: Write the view**

```vue
<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { PERMISSIONS } from '@payetam/shared';
import type { CitySeedConfigView, SeedEventsCitiesResponse } from '@payetam/shared';
import { messageOf, request } from '@/api/client';
import StateBlock from '@/components/StateBlock.vue';
import { useSessionStore } from '@/stores/session';

const session = useSessionStore();
const canManage = computed(() => session.can(PERMISSIONS.EVENT_SEED_MANAGE));

const cities = ref<CitySeedConfigView[] | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const savingCityId = ref<string | null>(null);

const state = computed(() => {
  if (error.value !== null) return 'error' as const;
  if (cities.value === null) return 'loading' as const;
  return 'ready' as const;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const response = await request<SeedEventsCitiesResponse>('/seed-events/cities');
    cities.value = response.cities;
  } catch (cause) {
    error.value = messageOf(cause, 'فهرست شهرها بارگذاری نشد.');
  } finally {
    loading.value = false;
  }
}

const drafts = reactive<Record<string, { hostUserPublicId: string }>>({});

function draftFor(city: CitySeedConfigView): { hostUserPublicId: string } {
  if (!drafts[city.cityId]) {
    drafts[city.cityId] = { hostUserPublicId: city.hostUserPublicId ?? '' };
  }
  return drafts[city.cityId]!;
}

async function save(
  city: CitySeedConfigView,
  patch: Partial<{
    enabled: boolean;
    floorCount: number;
    eventCapacity: number;
    fillMinutes: number;
    hostUserPublicId: string;
  }>,
): Promise<void> {
  savingCityId.value = city.cityId;
  error.value = null;
  try {
    const updated = await request<CitySeedConfigView>(
      `/seed-events/cities/${city.cityId}`,
      { method: 'PATCH', body: patch },
    );
    if (cities.value) {
      const index = cities.value.findIndex((c) => c.cityId === city.cityId);
      if (index !== -1) cities.value[index] = updated;
    }
  } catch (cause) {
    error.value = messageOf(cause, 'ذخیره تنظیمات این شهر ناموفق بود.');
  } finally {
    savingCityId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <h1>رویدادهای بازاریابی (فیک)</h1>
    <p class="hint">
      برای هر شهر بازشده، تعدادی رویداد ساختگی با میزبان واقعی و شرکت‌کنندگان مصنوعی ساخته
      می‌شود که به‌سرعت پر می‌شوند — تا در ابتدای کار، شهر خالی به نظر نرسد. هر شهر باید
      میزبان اختصاصی خودش را داشته باشد (نه یک اکانت مشترک بین چند شهر)، چون سقف رویداد
      همزمانِ هر اکانت ۳ رویداد و سقف روزانه‌اش ۵ رویداد است — «کف تعداد» بیش از ۳ عملاً
      قابل دسترس نیست. حساب میزبان باید سکه کافی داشته باشد؛ نبود سکه یعنی توقف بی‌صدای
      ساخت رویداد در همان شهر.
    </p>

    <StateBlock :state="state" :error="error" @retry="load">
      <table v-if="cities" class="seed-table">
        <thead>
          <tr>
            <th>شهر</th>
            <th>فعال</th>
            <th>کف تعداد</th>
            <th>ظرفیت هر رویداد</th>
            <th>مدت پر شدن (دقیقه)</th>
            <th>میزبان</th>
            <th>در حال پر شدن</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="city in cities" :key="city.cityId">
            <td>{{ city.cityNameFa }}</td>
            <td>
              <input
                type="checkbox"
                :checked="city.enabled"
                :disabled="!canManage || savingCityId === city.cityId"
                @change="
                  save(city, { enabled: ($event.target as HTMLInputElement).checked })
                "
              />
            </td>
            <td>
              <input
                type="number"
                min="0"
                max="3"
                :value="city.floorCount"
                :disabled="!canManage || savingCityId === city.cityId"
                @change="
                  save(city, { floorCount: Number(($event.target as HTMLInputElement).value) })
                "
              />
            </td>
            <td>
              <input
                type="number"
                min="1"
                max="50"
                :value="city.eventCapacity"
                :disabled="!canManage || savingCityId === city.cityId"
                @change="
                  save(city, {
                    eventCapacity: Number(($event.target as HTMLInputElement).value),
                  })
                "
              />
            </td>
            <td>
              <input
                type="number"
                min="1"
                max="240"
                :value="city.fillMinutes"
                :disabled="!canManage || savingCityId === city.cityId"
                @change="
                  save(city, { fillMinutes: Number(($event.target as HTMLInputElement).value) })
                "
              />
            </td>
            <td>
              <input
                type="text"
                placeholder="publicId میزبان واقعی"
                v-model="draftFor(city).hostUserPublicId"
                :disabled="!canManage || savingCityId === city.cityId"
                @change="save(city, { hostUserPublicId: draftFor(city).hostUserPublicId })"
              />
              <span v-if="city.hostDisplayName" class="host-name">{{ city.hostDisplayName }}</span>
            </td>
            <td>{{ city.fillingEventCount }}</td>
          </tr>
        </tbody>
      </table>
    </StateBlock>
  </section>
</template>

<style scoped>
.seed-table {
  width: 100%;
  border-collapse: collapse;
}
.seed-table th,
.seed-table td {
  padding: 0.5rem;
  text-align: start;
  border-bottom: 1px solid var(--border, #333);
}
.hint {
  color: var(--muted, #888);
  margin-bottom: 1rem;
}
.host-name {
  display: block;
  font-size: 0.85em;
  color: var(--muted, #888);
}
</style>
```

Before finalizing: read `apps/admin/src/components/StateBlock.vue`'s actual
prop names (`state`/`error`/`@retry` are a guess based on `CampaignView.vue`'s
usage pattern — confirm against the component itself) and
`apps/admin/src/api/client.ts`'s `request()` signature for how it passes a
`PATCH` body (the `{ method, body }` shape above is a guess — match whatever
`request()` actually accepts) before treating this file as final; fix
whichever assumption is wrong.

- [ ] **Step 4: Run the admin unit/component tests**

```bash
pnpm test --project admin
```

- [ ] **Step 5: Manual check**

Per this repo's UI convention, start the app and click through the new page
once real data exists (after Task 14's seed data is in place) — `make dev`,
log in as `SUPER_ADMIN`, open `/seed-events`, toggle a city on, and confirm
the row updates without a full reload.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/src/views/SeedEventsView.vue apps/admin/src/router.ts
git commit -m "feat(admin): add the seed-events configuration screen"
```

---

### Task 14: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

```bash
make typecheck
```

- [ ] **Step 2: Lint and format**

```bash
pnpm lint && pnpm format:check
```

- [ ] **Step 3: Fast test projects**

```bash
pnpm test --project unit --project miniapp --project admin
```

- [ ] **Step 4: Integration tests**

Follow the `integration-tests` skill (exclusivity check, rebuild `dist`
first, `payetam_test`, one run at a time):

```bash
pnpm build
pnpm test:integration
```

- [ ] **Step 5: Build**

```bash
pnpm build
```

- [ ] **Step 6: Fix anything red**

If any of the above fails, fix the root cause in the task whose file it
belongs to (do not patch around it in this task), re-run that task's own
tests, then re-run this task's full sequence from Step 1.

- [ ] **Step 7: `pnpm bot-walkthrough`**

Not touched by this feature's flows directly, but run it anyway — this
feature adds a new `EventService.createEvent` caller, and the walkthrough is
the cheap way to confirm nothing in the bot's own event-creation wizard
regressed.

```bash
pnpm bot-walkthrough
```

---

## After this plan

Once Task 14 is fully green, this plan is complete. Do not add scope beyond
it (no reused-identity pooling, no per-category content bank, no hiding seed
events from discovery — all explicitly out of scope per the spec). Return to
the standing instruction that requested this plan for what happens next
(branch merge, release).
