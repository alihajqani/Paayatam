import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Env } from '@payetam/config';
import type { Prisma } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { PenaltyService } from '../economy/penalty.service';
import { ReferralService } from '../economy/referral.service';
import { TrustService } from '../economy/trust.service';
import { OutboxService } from '../outbox/outbox.service';
import { assertParticipantTransition } from '../participation/state-machine';
import { ReviewService } from '../reviews/review.service';
import { startOfDayIn } from '../time';
import {
  lockEventByParticipantPublicIdForUpdate,
  lockEventByPublicIdForUpdate,
} from './event-lock';
import { assertEventTransition } from './state-machine';

export const ATTENDANCE_REASON = 'attendance.completed';

/** One key per participation: attendance is settled once, per event, per person. */
export function attendanceTrustKey(participantId: string): string {
  return `trust-attendance:${participantId}`;
}

/** Which of the two pre-event reminders a pass is sending. */
export type ReminderWave = 'FIRST' | 'SECOND';

/**
 * Which wave an activity is owed right now (migration 0050).
 *
 * Pure, exported and tested on its own because it is the one piece of this sweep
 * that is a *decision* rather than a query, and because both of its edges are
 * places a plausible reading gets it wrong:
 *
 *  - **At exactly the second threshold, it is the second wave.** Three hours out
 *    means the `cancellation.coins_lt_3h` step is about to apply, and the point
 *    of that reminder is to arrive before it does — not on the tick after.
 *  - **An activity created inside the second window gets only the second wave.**
 *    The first is not "missed"; it was never sendable in advance. Without this,
 *    somebody joining an activity starting in two hours would receive «فردا» and
 *    «تا چند ساعت دیگر» within one pass of each other.
 *
 * `secondWindowMs` is `reminder.second_hours_before` in milliseconds. The caller
 * has already bounded the set by the *first* window, which is why only the
 * second appears here: this answers "which", never "whether".
 */
export function reminderWaveFor(input: {
  startsAt: Date;
  now: Date;
  secondWindowMs: number;
}): ReminderWave {
  const untilStart = input.startsAt.getTime() - input.now.getTime();
  return untilStart <= input.secondWindowMs ? 'SECOND' : 'FIRST';
}

export interface ReminderResult {
  /** Accepted guests told. */
  guests: number;
  /** Hosts told, which happens only in the first wave. */
  hosts: number;
}

export interface SettlementResult {
  /** Events moved to COMPLETED. */
  completed: number;
  /** Events that reached their start with nobody accepted. */
  expired: number;
  /** Participations settled as attended. */
  attended: number;
}

/**
 * What happens to an event after it is over (plan §7, §3.5).
 *
 * Two sweeps, kept apart because they answer different questions and run on
 * different clocks:
 *
 *  - `retireStarted` moves an event out of PUBLISHED the moment it begins. An
 *    event that has started must stop appearing joinable, and one that reached
 *    its start with nobody accepted is EXPIRED rather than ONGOING — there is no
 *    gathering to be ongoing.
 *  - `settleAttendance` runs a configured while *after* the end, and turns the
 *    people who were ACCEPTED into COMPLETED. The delay is what gives a host time
 *    to report a no-show; without one, the job would settle everybody as attended
 *    before anybody could say otherwise.
 *
 * **This is the milestone that makes `COMPLETED` reachable at all.** M9 built the
 * referral payout against `event_participant.status = 'COMPLETED'` and recorded
 * that nothing wrote it; `settleAttendance` is what writes it, and it calls the
 * payout for every person it settles.
 *
 * Each event is swept in its own transaction under its own lock, one at a time.
 * Sweeping several in one transaction would hold several event locks at once,
 * which is exactly what ADR-0006 rule 2 forbids — and a sweep is the code most
 * likely to be handed a long list.
 */
@Injectable()
export class EventLifecycleService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
    private readonly trust: TrustService,
    private readonly referrals: ReferralService,
    private readonly penalties: PenaltyService,
    private readonly reviews: ReviewService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Move started events out of PUBLISHED, and finished ones to COMPLETED.
   *
   * `ONGOING` exists as a state between the two so discovery and the join path
   * have something truthful to read about an event that is happening right now.
   */
  async retireStarted(limit = 200): Promise<SettlementResult> {
    const now = this.clock.now();

    const candidates = await this.prisma.event.findMany({
      where: {
        status: { in: ['PUBLISHED', 'ONGOING'] },
        deletedAt: null,
        startsAt: { lte: now },
      },
      select: { publicId: true },
      orderBy: { startsAt: 'asc' },
      take: limit,
    });

    const result: SettlementResult = { completed: 0, expired: 0, attended: 0 };
    for (const { publicId } of candidates) {
      const outcome = await this.retireOne(publicId, now);
      if (outcome === 'COMPLETED') result.completed += 1;
      if (outcome === 'EXPIRED') result.expired += 1;
    }
    return result;
  }

  private async retireOne(publicId: string, now: Date): Promise<string | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const locked = await lockEventByPublicIdForUpdate(tx, publicId);
        if (!locked || locked.deletedAt !== null) return null;

        const current = await tx.event.findUniqueOrThrow({
          where: { id: locked.id },
          select: { status: true, endsAt: true },
        });
        // Re-checked under the lock: a host may have cancelled between the scan
        // and the lock being granted.
        if (current.status !== 'PUBLISHED' && current.status !== 'ONGOING') return null;
        if (locked.startsAt > now) return null;

        const seated = await tx.eventParticipant.count({
          where: { eventId: locked.id, status: 'ACCEPTED' },
        });

        /**
         * §7: "EXPIRED (start passed, 0 accepted)" — but only out of PUBLISHED.
         *
         * `ONGOING → EXPIRED` is not a legal edge, and an event can reach zero
         * seated *after* it has begun: everybody who was accepted can still
         * cancel once it has started, and a no-show report also empties a seat.
         * Deciding EXPIRED from ONGOING would then throw out of the sweep and
         * take the rest of the batch with it. Once an event has started it has
         * happened, so the only place left for it to go is COMPLETED.
         */
        const next =
          current.status === 'PUBLISHED' && seated === 0
            ? 'EXPIRED'
            : current.endsAt <= now
              ? 'COMPLETED'
              : 'ONGOING';
        if (next === current.status) return null;

        // PUBLISHED → COMPLETED is not a legal edge, so an event whose whole
        // duration elapsed between two sweeps passes through ONGOING rather than
        // skipping it. The state machine is the authority on the shape of the
        // path, not the sweep's timing.
        if (next === 'COMPLETED' && current.status === 'PUBLISHED') {
          assertEventTransition(current.status, 'ONGOING', locked.id);
          await tx.event.update({ where: { id: locked.id }, data: { status: 'ONGOING' } });
          assertEventTransition('ONGOING', 'COMPLETED', locked.id);
        } else {
          assertEventTransition(current.status, next, locked.id);
        }

        await tx.event.update({
          where: { id: locked.id },
          data: { status: next, version: { increment: 1 } },
        });

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'event.lifecycle',
            targetType: 'event',
            targetId: locked.id,
            before: { status: current.status },
            after: { status: next, seated },
          },
          tx,
        );

        return next;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Tell people their activity is coming, before it is too late to act on it.
   *
   * ── The number that makes this obligatory ───────────────────────────────────
   *
   * `cancellation.coins_no_show` is 60 and `cancellation.trust_no_show` is 15 —
   * three times the price of joining, and the heaviest pair of numbers in the
   * economy. Beside them `cancellation.coins_lt_3h` is 40, which is the product
   * asking a guest to decide **three hours ahead** if they want it to cost less.
   *
   * Until this, somebody accepted ten days out received nothing at all between
   * the acceptance and the start. A product that expects a timed action, never
   * tells anybody the time, and then fines them for missing it is not running a
   * penalty — it is running a trap. This is also the cheapest way to move the
   * no-show rate: cheaper than any change to either number above.
   *
   * ── Driven from the event, not from the participant ────────────────────────
   *
   * Because the window is a property of the event, and because it makes the scan
   * two existing indexes — `event_upcoming_idx` on `starts_at`, then
   * `event_participant(event_id, status)`. Scanning participants instead would
   * have wanted a new index over three columns for one job. Migration 0050 says
   * the same thing from the database's side.
   *
   * ── Which wave, and why an event only ever gets one per pass ──────────────
   *
   * Inside the second window, the second wave; otherwise the first. An activity
   * **created** less than three hours before it starts therefore gets only the
   * three-hour reminder: the first is not "missed", it was never sendable in
   * advance, and sending both minutes apart would be the product talking to
   * itself. This is why `reminder.first_hours_before` must stay strictly greater
   * than `reminder.second_hours_before`.
   *
   * ── Cancelled evenings, and the reason the status is checked here ─────────
   *
   * `status: 'PUBLISHED'` and `ACCEPTED` are read **together**, on purpose. A
   * cancelled activity whose guests were still ACCEPTED — or a live one whose
   * guest had withdrawn — would otherwise send somebody out of the house for a
   * meeting that is not happening, which is the worst message this feature could
   * produce and the exact one a sweep written from one side would produce.
   */
  async remindUpcoming(limit = 200): Promise<ReminderResult> {
    const now = this.clock.now();
    const { first, second } = await this.settings
      .getNumbers(['reminder.first_hours_before', 'reminder.second_hours_before'])
      .then((values) => ({
        first: values['reminder.first_hours_before'] * 3_600_000,
        second: values['reminder.second_hours_before'] * 3_600_000,
      }));

    const candidates = await this.prisma.event.findMany({
      where: {
        /**
         * `HIDDEN` belongs here, and it is the least obvious entry in this file.
         *
         * A moderation hide takes an activity out of discovery; it does not
         * cancel it, and `TEMPLATES.CONTENT_HIDDEN` says so to the host in as
         * many words — «کسانی که پیش‌تر پذیرفته شده‌اند سر جای خود می‌مانند». Those
         * people are still going, so they are still owed the reminder. Leaving
         * `HIDDEN` out would silently apply a punishment the product explicitly
         * promised not to apply, to the guests rather than to the host.
         *
         * `CANCELLED_BY_HOST`, `EXPIRED` and `DELETED` are all absent for the
         * opposite reason, and that is the whole point of naming the states
         * rather than excluding a few.
         */
        status: { in: ['PUBLISHED', 'HIDDEN'] },
        deletedAt: null,
        // Strictly after now: an activity that has already begun belongs to
        // `retireStarted`, and a reminder for it would arrive as an apology.
        startsAt: { gt: now, lte: new Date(now.getTime() + first) },
      },
      select: { id: true, startsAt: true },
      orderBy: { startsAt: 'asc' },
      take: limit,
    });

    const result: ReminderResult = { guests: 0, hosts: 0 };
    for (const event of candidates) {
      const wave = reminderWaveFor({ startsAt: event.startsAt, now, secondWindowMs: second });

      result.guests += await this.remindGuests(event.id, wave, now);
      // The host is told once, a day out, with a head count. Somebody who has to
      // shop, book a table or arrive early needs the number the day before; a
      // three-hour nudge to whoever created the evening is noise.
      if (wave === 'FIRST' && (await this.remindHost(event.id, now))) result.hosts += 1;
    }
    return result;
  }

  /**
   * One wave, for one event's accepted guests.
   *
   * Each guest is claimed in its own transaction — the shape `announceOne` uses
   * for review windows, and for its reason: `updateMany` filtered on the column
   * being NULL **is** the claim, so two workers sweeping at once resolve to
   * exactly one write, and the outbox row is emitted inside the same transaction
   * that claimed it. A crash between the two is therefore impossible, and the
   * visible cost of getting it wrong is telling somebody twice.
   *
   * No event lock. Locks in this file protect `accepted_count` (ADR-0006), and a
   * reminder changes no seat — taking one would put a sweep of two hundred
   * events in the queue behind every join in progress, for nothing.
   */
  private async remindGuests(eventId: string, wave: ReminderWave, now: Date): Promise<number> {
    const column = wave === 'FIRST' ? 'remindedFirstAt' : 'remindedSecondAt';

    const due = await this.prisma.eventParticipant.findMany({
      where: { eventId, status: 'ACCEPTED', [column]: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });

    let sent = 0;
    for (const { id } of due) {
      if (await this.remindOneGuest(id, wave, now)) sent += 1;
    }
    return sent;
  }

  private async remindOneGuest(
    participantId: string,
    wave: ReminderWave,
    now: Date,
  ): Promise<boolean> {
    const column = wave === 'FIRST' ? 'remindedFirstAt' : 'remindedSecondAt';

    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.eventParticipant.updateMany({
        where: { id: participantId, [column]: null },
        data: { [column]: now },
      });
      if (claimed.count === 0) return false;

      const participant = await tx.eventParticipant.findUniqueOrThrow({
        where: { id: participantId },
        select: {
          user: { select: { publicId: true } },
          event: { select: { publicId: true, title: true, startsAt: true } },
        },
      });

      await this.outbox.emit(
        {
          aggregateType: 'event_participant',
          aggregateId: participantId,
          eventType: 'event.reminder_guest',
          // Public ids and the title only — this payload becomes the text of a
          // Telegram message (ADR-0009, invariant 7).
          payload: {
            eventPublicId: participant.event.publicId,
            eventTitle: participant.event.title,
            startsAt: participant.event.startsAt.toISOString(),
            wave,
            participantUserPublicId: participant.user.publicId,
          },
        },
        tx,
      );

      return true;
    });
  }

  /**
   * The host's single reminder, with the number of people coming.
   *
   * Claimed the same way and for the same reason, on `event.host_reminded_at`
   * because a host has no `event_participant` row of their own.
   *
   * `accepted_count` is read rather than counted: it is the column invariant 1
   * is enforced on, so it is the number the product is willing to be held to,
   * and a `COUNT(*)` that disagreed with it would be reporting a bug as a head
   * count.
   */
  private async remindHost(eventId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.event.updateMany({
        where: { id: eventId, hostRemindedAt: null },
        data: { hostRemindedAt: now },
      });
      if (claimed.count === 0) return false;

      const event = await tx.event.findUniqueOrThrow({
        where: { id: eventId },
        select: {
          publicId: true,
          title: true,
          startsAt: true,
          acceptedCount: true,
          host: { select: { publicId: true } },
        },
      });

      await this.outbox.emit(
        {
          aggregateType: 'event',
          aggregateId: eventId,
          eventType: 'event.reminder_host',
          payload: {
            eventPublicId: event.publicId,
            eventTitle: event.title,
            startsAt: event.startsAt.toISOString(),
            acceptedCount: event.acceptedCount,
            hostUserPublicId: event.host.publicId,
          },
        },
        tx,
      );

      return true;
    });
  }

  /**
   * Settle who attended, once the host has had time to say otherwise.
   *
   * Everyone still ACCEPTED on a COMPLETED event is treated as having turned up.
   * That default is deliberate and it is the kind one: the alternative is
   * penalising people for a report their host never filed, and a host who does
   * not report a no-show has told us nothing about whether one happened.
   */
  async settleAttendance(limit = 200): Promise<SettlementResult> {
    const now = this.clock.now();
    const delayHours = await this.settings.getInt('participation.settlement_delay_hours');
    const settledBefore = new Date(now.getTime() - delayHours * 3_600_000);

    const candidates = await this.prisma.event.findMany({
      where: {
        status: 'COMPLETED',
        deletedAt: null,
        endsAt: { lte: settledBefore },
        participants: { some: { status: 'ACCEPTED' } },
      },
      select: { publicId: true },
      orderBy: { endsAt: 'asc' },
      take: limit,
    });

    const result: SettlementResult = { completed: 0, expired: 0, attended: 0 };
    for (const { publicId } of candidates) {
      result.attended += await this.settleOne(publicId, now);
    }
    return result;
  }

  private async settleOne(publicId: string, now: Date): Promise<number> {
    const settled = await this.prisma.$transaction(
      async (tx) => {
        const locked = await lockEventByPublicIdForUpdate(tx, publicId);
        if (!locked || locked.deletedAt !== null) return [];

        const ends = await tx.event.findUniqueOrThrow({
          where: { id: locked.id },
          select: { endsAt: true },
        });

        const attendees = await tx.eventParticipant.findMany({
          where: { eventId: locked.id, status: 'ACCEPTED' },
          select: { id: true, publicId: true, userId: true, status: true },
        });

        const ids: string[] = [];
        for (const attendee of attendees) {
          assertParticipantTransition(attendee.status, 'COMPLETED', attendee.id);

          await tx.eventParticipant.update({
            where: { id: attendee.id },
            data: { status: 'COMPLETED', attended: true, version: { increment: 1 } },
          });

          await this.creditAttendance(tx, attendee.userId, attendee.id, now);

          /**
           * The review window opens here, in the transaction that decided somebody
           * attended (M11).
           *
           * This placement is what makes "you may only review an evening you were
           * actually at" structural rather than a check somebody has to remember:
           * a participation that completed always has a pair, and one that was
           * cancelled or reported as a no-show never gets one. Reviewing somebody
           * for not turning up is what the no-show penalty already is.
           */
          await this.reviews.openForParticipant(tx, {
            participantId: attendee.id,
            eventId: locked.id,
            endsAt: ends.endsAt,
          });

          await this.audit.record(
            {
              actorType: 'SYSTEM',
              action: 'participation.completed',
              targetType: 'event_participant',
              targetId: attendee.id,
              before: { status: 'ACCEPTED' },
              after: { status: 'COMPLETED', attended: true },
            },
            tx,
          );

          ids.push(attendee.userId);
        }

        return ids;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    /**
     * The referral payout, **after** the transaction rather than inside it.
     *
     * `qualifyForAttendance` opens its own transaction and takes the referrer's
     * coin-account lock — a different user's account from the attendee's, and one
     * this sweep has no other reason to touch. Running it under the event lock
     * would mean holding an event lock while waiting on an arbitrary third
     * party's account, which is precisely the second-lock-of-unknown-order that
     * ADR-0006 rule 2 exists to prevent.
     *
     * Safe to be outside because it is idempotent and re-derives its own
     * condition: it re-reads whether the user has a COMPLETED participation, so a
     * crash between the commit and this line pays out on the next sweep instead
     * of losing the reward.
     */
    for (const userId of settled) {
      await this.referrals.qualifyForAttendance(userId);
    }

    return settled.length;
  }

  /**
   * Trust for turning up (plan §11: +2, capped at +2 per Tehran day).
   *
   * The cap is what stops two people running six events a day to trade
   * reputation with each other — the same reasoning that puts the referral reward
   * behind an attended event. Counted against the ledger rather than a stored
   * per-day tally, because the ledger is already the truth and a second counter
   * would be a second thing that can disagree with it.
   */
  private async creditAttendance(
    tx: Prisma.TransactionClient,
    userId: string,
    participantId: string,
    now: Date,
  ): Promise<void> {
    const [delta, dailyCap] = await Promise.all([
      this.settings.getInt('trust.attendance_delta', tx),
      this.settings.getInt('trust.attendance_daily_cap', tx),
    ]);
    if (delta <= 0 || dailyCap <= 0) return;

    // A Tehran day, not a UTC one (ADR-0008). The cap is a rule about a person's
    // day, and a person's day ends at midnight where they live.
    const dayStart = startOfDayIn(now, this.env.APP_TIMEZONE);
    const earnedToday = await tx.trustScoreLedger.aggregate({
      where: { userId, type: 'ATTENDANCE', createdAt: { gte: dayStart } },
      _sum: { delta: true },
    });

    const remaining = dailyCap - (earnedToday._sum.delta ?? 0);
    if (remaining <= 0) return;

    await this.trust.apply(
      {
        userId,
        delta: Math.min(delta, remaining),
        type: 'ATTENDANCE',
        reasonCode: ATTENDANCE_REASON,
        idempotencyKey: attendanceTrustKey(participantId),
        actorType: 'SYSTEM',
        refType: 'event_participant',
        refId: participantId,
      },
      tx,
    );
  }

  /**
   * The host reports that somebody did not turn up (plan §11: −60 coins, −15
   * trust).
   *
   * **An addition to §6's endpoint list, and the reason it is here**: §11 prices
   * a no-show and §7 draws `ACCEPTED → NO_SHOW`, but nothing in the plan says who
   * decides one. Left unbuilt, the most expensive penalty in the product would be
   * unreachable and the state would be decoration. A host report is the only
   * signal available — the platform has no presence at the café — so this is a
   * host action, audited like every other, and `moderation` (M12) is where a
   * participant disputes one.
   *
   * Only after the event has ended: "they did not come" is not a claim anybody
   * can make about a gathering that has not happened yet.
   */
  async markNoShow(hostUserId: string, participantPublicId: string): Promise<void> {
    const now = this.clock.now();

    await this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByParticipantPublicIdForUpdate(tx, participantPublicId);
        if (!event) throw new AppError(ErrorCode.NOT_FOUND);
        // Not-yours and not-found answer identically (T3.3).
        if (event.hostUserId !== hostUserId) throw new AppError(ErrorCode.NOT_FOUND);

        const participant = await tx.eventParticipant.findUniqueOrThrow({
          where: { publicId: participantPublicId },
          select: { id: true, userId: true, status: true },
        });

        assertParticipantTransition(participant.status, 'NO_SHOW', participant.id);

        const ends = await tx.event.findUniqueOrThrow({
          where: { id: event.id },
          select: { endsAt: true },
        });
        if (ends.endsAt > now) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

        const penalty = await this.penalties.chargeParticipant(tx, {
          participantId: participant.id,
          userId: participant.userId,
          bucket: 'NO_SHOW',
          eventId: event.id,
        });

        await tx.eventParticipant.update({
          where: { id: participant.id },
          data: {
            status: 'NO_SHOW',
            attended: false,
            cancellationBucket: 'NO_SHOW',
            penaltyLedgerId: penalty.ledgerId,
            version: { increment: 1 },
          },
        });

        // A seat on an event that has already happened is not a seat anybody can
        // use, so `accepted_count` is deliberately left alone: it is the record of
        // how many people had places at a gathering that took place.

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: hostUserId,
            action: 'participation.no_show',
            targetType: 'event_participant',
            targetId: participant.id,
            before: { status: participant.status },
            after: {
              status: 'NO_SHOW',
              coinsCharged: penalty.coinsCharged,
              trustApplied: penalty.trustApplied,
            },
          },
          tx,
        );

        await this.outbox.emit(
          {
            aggregateType: 'event_participant',
            aggregateId: participant.id,
            eventType: 'participation.no_show',
            payload: {
              participantPublicId,
              eventPublicId: event.publicId,
              eventTitle: event.title,
              coinsCharged: penalty.coinsCharged,
            },
          },
          tx,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
