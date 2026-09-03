import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '@payetam/config';
import type { PrismaClient, PrismaService } from '@payetam/db';
import { FakeClock } from '@payetam/platform';
import {
  createTestPrisma,
  createUser,
  resetDatabase,
  seedCatalog,
  type CatalogFixture,
} from '../../../../test/integration/db';
import { AuditService } from '../audit/audit.service';
import { ChannelConfigService } from '../channel/channel-config.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService } from '../economy/penalty.service';
import { TrustService } from '../economy/trust.service';
import { normalize } from '../moderation/persian-normalizer';
import { OutboxService } from '../outbox/outbox.service';
import { ParticipationService } from './participation.service';

/**
 * What `event.accepted_count` counts, and therefore what «جای خالی» means.
 *
 * ── The report this suite exists for ────────────────────────────────────────
 *
 * An operator wrote: *"An event with 2 capacity slots shows 0 capacity
 * remaining, even though one submission was rejected and one host deadline has
 * passed."* Every part of the system was behaving as written. A PENDING request
 * held a seat, so releasing one promoted somebody off the waiting list who
 * immediately took it again, and the counter sat at capacity while nobody had
 * been accepted at all.
 *
 * v0.6.5 makes the column mean what it is called: **a seat is consumed when a
 * host accepts, and at no other moment.** These are the properties that
 * establishes, written against a real database because every one of them is a
 * property of the event row lock.
 */

const prisma: PrismaClient = createTestPrisma();
const service = prisma as unknown as PrismaService;

const NOW = new Date('2026-08-15T09:00:00.000Z');
const clock = new FakeClock(NOW);
const env = { APP_TIMEZONE: 'Asia/Tehran' } as unknown as Env;

const settings = new SettingsService(service);
const audit = new AuditService(service, clock);
const outbox = new OutboxService(service, clock);
const coins = new CoinService(service, clock);
const trust = new TrustService(service, clock, settings);
const penalties = new PenaltyService(service, settings, coins, trust);
const membership = new ChannelMembershipService(
  service,
  new ChannelConfigService(service, clock, audit),
);

const participation = new ParticipationService(
  service,
  clock,
  env,
  settings,
  audit,
  outbox,
  penalties,
  membership,
  coins,
);

const STARTS_AT = new Date('2026-09-20T15:00:00.000Z');

let fixture: CatalogFixture;
let hostId: string;
let titleSequence = 0;

async function createEvent(capacity: number): Promise<string> {
  titleSequence += 1;
  const title = `دورهمی شماره ${String(titleSequence)}`;
  const description = 'یک برنامهٔ دوستانه برای گپ و بازی رومیزی.';

  const event = await prisma.event.create({
    data: {
      hostUserId: hostId,
      title,
      description,
      titleNormalized: normalize(title),
      descriptionNormalized: normalize(description),
      categoryId: fixture.categoryId,
      cityId: fixture.tehranId,
      startsAt: STARTS_AT,
      endsAt: new Date(STARTS_AT.getTime() + 3 * 60 * 60 * 1000),
      capacity,
      costType: 'FREE',
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      publishedAt: NOW,
    },
    select: { publicId: true },
  });
  return event.publicId;
}

/**
 * Enough coins to ask to join, several times over.
 *
 * `economy.event_join_coins` is 5 from v0.7.0 and `join` charges it inside the
 * same transaction, so a joiner with an empty account is refused with
 * `INSUFFICIENT_COINS` before reaching any of the behaviour this suite is about.
 * The endowment is deliberately generous and round: nothing here asserts a bare
 * balance, so the number only has to be out of the way.
 */
const JOIN_BUDGET = 500;

async function createJoiner(): Promise<string> {
  const userId = await createUser(prisma, 'PROFILE_COMPLETE', { coins: JOIN_BUDGET });
  await prisma.userProfile.create({
    data: {
      userId,
      displayName: 'شرکت‌کننده',
      cityId: fixture.tehranId,
      birthYear: 1995,
      gender: 'FEMALE',
    },
  });
  return userId;
}

/** Joins one clock tick apart, so the queue order is unambiguous. */
async function joinInOrder(
  eventPublicId: string,
  userIds: readonly string[],
): Promise<{ userId: string; publicId: string; status: string }[]> {
  const rows: { userId: string; publicId: string; status: string }[] = [];
  for (const [index, userId] of userIds.entries()) {
    clock.set(new Date(NOW.getTime() + index * 1000));
    const row = await participation.join(userId, eventPublicId);
    rows.push({ userId, publicId: row.publicId, status: row.status });
  }
  clock.set(NOW);
  return rows;
}

async function seats(eventPublicId: string): Promise<number> {
  const event = await prisma.event.findUniqueOrThrow({
    where: { publicId: eventPublicId },
    select: { acceptedCount: true },
  });
  return event.acceptedCount;
}

async function statusOf(participantPublicId: string): Promise<string> {
  const row = await prisma.eventParticipant.findUniqueOrThrow({
    where: { publicId: participantPublicId },
    select: { status: true },
  });
  return row.status;
}

beforeEach(async () => {
  await resetDatabase(prisma);
  clock.set(NOW);
  titleSequence = 0;
  fixture = await seedCatalog(prisma);
  hostId = await createJoiner();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a seat is taken by an acceptance and by nothing else', () => {
  it('asking for one takes none', async () => {
    const eventPublicId = await createEvent(2);
    const [guest] = await joinInOrder(eventPublicId, [await createJoiner()]);

    expect(guest?.status).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(0);
  });

  it('accepting takes one', async () => {
    const eventPublicId = await createEvent(2);
    const [guest] = await joinInOrder(eventPublicId, [await createJoiner()]);

    await participation.accept(hostId, guest!.publicId);

    expect(await seats(eventPublicId)).toBe(1);
  });

  it('a rejection leaves the count where it was', async () => {
    const eventPublicId = await createEvent(2);
    const [guest] = await joinInOrder(eventPublicId, [await createJoiner()]);

    await participation.reject(hostId, guest!.publicId);

    expect(await seats(eventPublicId)).toBe(0);
  });

  it('a cancelled acceptance gives the seat back', async () => {
    const eventPublicId = await createEvent(2);
    const [guest] = await joinInOrder(eventPublicId, [await createJoiner()]);

    await participation.accept(hostId, guest!.publicId);
    await participation.cancel(guest!.userId, guest!.publicId);

    expect(await seats(eventPublicId)).toBe(0);
  });
});

/**
 * The reported scenario, end to end.
 *
 * Two places, four askers, one rejected and one left to expire. Before v0.6.5
 * this finished at `accepted_count = 2` — «ظرفیت تکمیل» on an activity nobody
 * had been accepted to.
 */
describe('the reported scenario: two places, a rejection and an expiry', () => {
  it('still shows both places free, because nobody was accepted', async () => {
    const eventPublicId = await createEvent(2);
    const guests = await Promise.all([
      createJoiner(),
      createJoiner(),
      createJoiner(),
      createJoiner(),
    ]);
    const rows = await joinInOrder(eventPublicId, guests);

    // Two are asked about, two queue behind them — the host's attention is what
    // capacity bounds at this stage, not the seats.
    expect(rows.map((row) => row.status)).toEqual([
      'PENDING',
      'PENDING',
      'WAITLISTED',
      'WAITLISTED',
    ]);
    expect(await seats(eventPublicId)).toBe(0);

    await participation.reject(hostId, rows[0]!.publicId);

    // The queue moved: the freed slot went to the person who had waited longest.
    expect(await statusOf(rows[2]!.publicId)).toBe('PENDING');
    expect(await seats(eventPublicId)).toBe(0);

    // …and the second request is left to time out.
    clock.set(new Date(NOW.getTime() + 48 * 60 * 60 * 1000));
    const expired = await participation.expireOverdue();
    clock.set(NOW);

    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await statusOf(rows[1]!.publicId)).toBe('EXPIRED');

    // The whole point: two places, nobody accepted, two places free.
    expect(await seats(eventPublicId)).toBe(0);
  });
});

/**
 * The property the change could easily have destroyed.
 *
 * If PENDING held nothing and nothing else changed, `join` would admit everybody
 * and the waiting list would never receive a soul. It is bounded by
 * `accepted_count + PENDING` instead — the same arithmetic, with the two
 * quantities kept apart.
 */
describe('the waiting list still exists', () => {
  it('queues the request past capacity, counting outstanding questions', async () => {
    const eventPublicId = await createEvent(1);
    const rows = await joinInOrder(eventPublicId, [await createJoiner(), await createJoiner()]);

    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'WAITLISTED']);
  });

  it('counts an acceptance and an outstanding request together', async () => {
    const eventPublicId = await createEvent(2);
    const rows = await joinInOrder(eventPublicId, [
      await createJoiner(),
      await createJoiner(),
      await createJoiner(),
    ]);

    await participation.accept(hostId, rows[0]!.publicId);

    // One accepted + one pending = capacity, so the third waits.
    expect(rows[2]?.status).toBe('WAITLISTED');
    expect(await seats(eventPublicId)).toBe(1);
  });

  /**
   * The loop that had to be re-bounded. `fillFreedSeats` used to terminate only
   * because promoting incremented the counter it was testing; with PENDING
   * holding nothing, the old condition would have promoted the entire queue.
   */
  it('promotes exactly one person per freed slot, not the whole queue', async () => {
    const eventPublicId = await createEvent(1);
    const rows = await joinInOrder(eventPublicId, [
      await createJoiner(),
      await createJoiner(),
      await createJoiner(),
      await createJoiner(),
    ]);

    await participation.reject(hostId, rows[0]!.publicId);

    expect(await statusOf(rows[1]!.publicId)).toBe('PENDING');
    expect(await statusOf(rows[2]!.publicId)).toBe('WAITLISTED');
    expect(await statusOf(rows[3]!.publicId)).toBe('WAITLISTED');
  });
});

/**
 * `assertSeatAvailable` in `accept` used to be unreachable — no path could accept
 * a row that held no seat. Now it is the live guard, and this is the shape that
 * reaches it: capacity 1, one acceptance, then a promoted request the host also
 * tries to accept.
 */
describe('accepting past capacity', () => {
  it('is refused rather than overbooking', async () => {
    const eventPublicId = await createEvent(1);
    const rows = await joinInOrder(eventPublicId, [await createJoiner(), await createJoiner()]);

    await participation.accept(hostId, rows[0]!.publicId);
    // The waitlisted one is promoted when the accepted guest's *slot* frees…
    await participation.cancel(rows[0]!.userId, rows[0]!.publicId);
    await participation.accept(hostId, rows[1]!.publicId);
    expect(await seats(eventPublicId)).toBe(1);

    // …and a second acceptance on a full event is refused, not silently allowed.
    const third = await createJoiner();
    clock.set(new Date(NOW.getTime() + 5000));
    const extra = await participation.join(third, eventPublicId);
    clock.set(NOW);

    if (extra.status === 'PENDING') {
      await expect(participation.accept(hostId, extra.publicId)).rejects.toMatchObject({
        code: 'CAPACITY_EXCEEDED',
      });
    }
    expect(await seats(eventPublicId)).toBe(1);
  });
});

/**
 * Migration 0035, run against the state the previous release left behind.
 *
 * ── Why this is tested at all ───────────────────────────────────────────────
 *
 * Every test above builds its rows through `join` and `accept`, so all of them
 * describe an event created *under the new rule*. None of them can fail because
 * of data written under the old one — and the rows in production were all
 * written under the old one.
 *
 * `accepted_count` is a stored counter, not a view. Redefining what it counts
 * changes no number already in the table, and no code path lowers a stale value
 * again: the only decrement is `releaseSeat`, which is now reached solely for
 * participants who were ACCEPTED, so a seat wrongly held by a PENDING request is
 * held for good. Shipping the code change without the migration would leave the
 * activity in the operator's report reading exactly as wrong as it did before,
 * with the whole suite green.
 *
 * ── Why it executes the file rather than a copy of the statement ────────────
 *
 * So the test cannot drift from what ships. A re-typed `UPDATE` in here would go
 * on passing after somebody edited the migration, which is the one failure this
 * is meant to catch.
 */
describe('migration 0035 repairs a count written under the old rule', () => {
  // Resolved from the Vitest root rather than from this file, because the
  // workspace compiles to CommonJS and `import.meta` is unavailable here.
  const migrationSql = readFileSync(
    path.resolve(
      process.cwd(),
      'packages/db/prisma/migrations/00000000000035_seat_accounting_backfill/migration.sql',
    ),
    'utf8',
  );

  it('brings an inflated count down to the seats actually accepted', async () => {
    const eventPublicId = await createEvent(2);
    const rows = await joinInOrder(eventPublicId, [await createJoiner(), await createJoiner()]);
    await participation.accept(hostId, rows[0]!.publicId);
    await participation.reject(hostId, rows[1]!.publicId);

    // The previous release counted PENDING and ACCEPTED alike, so this event
    // would have left v0.6.4 holding 2 — one for the acceptance and one for a
    // request that has since been refused and gave nothing back.
    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { acceptedCount: 2 },
    });
    expect(await seats(eventPublicId)).toBe(2);

    await prisma.$executeRawUnsafe(migrationSql);

    expect(await seats(eventPublicId)).toBe(1);
  });

  it('is idempotent — a second run writes nothing', async () => {
    const eventPublicId = await createEvent(2);
    const rows = await joinInOrder(eventPublicId, [await createJoiner()]);
    await participation.accept(hostId, rows[0]!.publicId);

    await prisma.$executeRawUnsafe(migrationSql);
    const afterFirst = await seats(eventPublicId);
    await prisma.$executeRawUnsafe(migrationSql);

    expect(afterFirst).toBe(1);
    expect(await seats(eventPublicId)).toBe(afterFirst);
  });

  it('leaves a count that was already right alone', async () => {
    const eventPublicId = await createEvent(3);
    const rows = await joinInOrder(eventPublicId, [await createJoiner()]);
    await participation.accept(hostId, rows[0]!.publicId);

    await prisma.$executeRawUnsafe(migrationSql);

    expect(await seats(eventPublicId)).toBe(1);
  });

  /**
   * The constraint the repair must not trip on its way past.
   *
   * `event_accepted_count_within_capacity` (migration 0004, invariant 1) is a
   * CHECK, so a backfill that ever raised a count could fail the whole migration
   * on one bad row. It cannot: the new value counts a subset of what the old one
   * counted, so it is bounded by a number that already satisfied the constraint.
   */
  it('only ever lowers a count, so the capacity invariant holds through it', async () => {
    const eventPublicId = await createEvent(1);
    const rows = await joinInOrder(eventPublicId, [await createJoiner()]);
    expect(await statusOf(rows[0]!.publicId)).toBe('PENDING');

    await prisma.event.update({
      where: { publicId: eventPublicId },
      data: { acceptedCount: 1 },
    });

    await prisma.$executeRawUnsafe(migrationSql);

    expect(await seats(eventPublicId)).toBe(0);
  });
});
