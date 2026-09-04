import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { CancellationBucket, ParticipantStatus, Prisma } from '@payetam/db';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService, bucketForLateness, type PenaltyPrice } from '../economy/penalty.service';
import {
  lockEventByParticipantPublicIdForUpdate,
  lockEventByPublicIdForUpdate,
  type LockedEvent,
} from '../events/event-lock';
import { OutboxService } from '../outbox/outbox.service';
import { ageFromBirthYear } from '../profile/age';
import { assertParticipantTransition, SLOT_HOLDING_STATUSES, holdsSeat } from './state-machine';

/**
 * The reason code a join charge carries (v0.6.3).
 *
 * A stable string, because the admin ledger renders it and a rename would make
 * every historical row read as something else (ADR-0007).
 */
export const EVENT_JOIN_REASON = 'participation.requested';

/**
 * The reason code a *refunded* join charge carries (v0.8.1).
 *
 * Its own string rather than `EVENT_JOIN_REASON` reused on a `REVERSAL`, for the
 * reason ADR-0007 gives about every other code in the ledger: «why did this
 * number move» is the question the column answers, and "the host said no" is a
 * different answer from "they asked to join". Stable, because the admin ledger
 * renders it and a rename would make every historical row read as something
 * else.
 */
export const EVENT_JOIN_REFUND_REASON = 'participation.rejected_refund';

/**
 * The same refund, when nobody decided at all (v0.8.1).
 *
 * Its own code rather than `EVENT_JOIN_REFUND_REASON` reused, for the reason
 * that one is not `EVENT_JOIN_REASON` reused: «the host said no» and «the host
 * never answered» are different answers to "why did this number move", and they
 * have different people to ask about them. An operator reading a ledger should
 * be able to count unanswered requests without joining back to
 * `event_participant`.
 */
export const EVENT_JOIN_EXPIRY_REFUND_REASON = 'participation.expired_refund';

/**
 * The exactly-once key for a join charge.
 *
 * `(event, user)` rather than the participant id, because it has to be
 * computable before the row is read back and because the pair is already unique:
 * `createMany` with `skipDuplicates` means one participation per pair, ever.
 */
export function eventJoinSpendKey(eventId: string, userId: string): string {
  return `join:${eventId}:${userId}`;
}

export interface ParticipationDetail {
  publicId: string;
  eventPublicId: string;
  status: ParticipantStatus;
  requestedAt: Date;
  hostDeadlineAt: Date | null;
  graceExpiresAt: Date | null;
  acceptedAt: Date | null;
  cancelledAt: Date | null;
  cancellationBucket: CancellationBucket | null;
  /** 1-based position in the queue, present only while WAITLISTED. */
  waitlistRank: number | null;
}

/**
 * A request as it appears in the requester's **own list**.
 *
 * Carries the event it is for, which `ParticipationDetail` deliberately does not:
 * the three action paths (`join`, `accept`, `cancel`) return a single request to
 * a caller who just named the event and has it on screen already, and loading a
 * title to hand back to somebody who supplied it would be work for nobody.
 *
 * A **list** is the case where that stops being true. Without a title, three
 * pending requests render as three identical «در انتظار» cards, and the only way
 * to tell them apart is to open each one — which is what both surfaces did until
 * this existed.
 */
export interface MyParticipation extends ParticipationDetail {
  event: { publicId: string; title: string; startsAt: Date };
}

/** What the host sees about somebody who asked to join. */
export interface ParticipantSummary {
  publicId: string;
  userPublicId: string;
  displayName: string;
  /**
   * The requester's Trust Score, 0–100, or null when they have never been judged
   * (M18).
   *
   * The one piece of *reputation* a host is given about a stranger, and it is
   * given for the reason the host has a decision to make at all: accepting
   * somebody into a real-world meeting is exactly the moment where "has this
   * person behaved" is a legitimate question. Nothing from `trust_score_ledger`
   * comes with it — the number, never its history, because the history is a
   * record of specific incidents and belongs to the person they happened to.
   *
   * Null is not zero, for the same reason it is not on `DiscoveredEvent`: a
   * brand-new account has no row and has done nothing wrong.
   */
  trustScore: number | null;
  status: ParticipantStatus;
  requestedAt: Date;
  hostDeadlineAt: Date | null;
  waitlistRank: number | null;
}

/**
 * Participation, and with it the one correctness property the product cannot get
 * wrong: `accepted_count <= capacity`, always (ADR-0006, invariant 1).
 *
 * Every method here that can change `accepted_count` follows the same three
 * rules, and they are the whole design:
 *
 *  1. **Lock first.** `SELECT … FOR UPDATE` on the event row is the first
 *     statement of the transaction, before any other row is touched.
 *  2. **Lock only.** No second lock is taken while holding it, so lock ordering
 *     is trivially total and deadlock is impossible by construction.
 *  3. **Nothing slow inside.** No network call, no Telegram API, no HTTP. The
 *     lock serialises every joiner of a popular event, so a request held inside
 *     it is a request every other joiner waits behind.
 *
 * The database `CHECK (accepted_count <= capacity)` is the backstop for the day
 * a future code path forgets rule 1. It turns silent overbooking into a loud
 * failure, which is the trade ADR-0006 makes deliberately.
 */
@Injectable()
export class ParticipationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly penalties: PenaltyService,
    /** The channel-membership gate (M22 phase 6), in the service that owns the act. */
    private readonly membership: ChannelMembershipService,
    /**
     * For `economy.event_join_coins` (v0.6.3), charged inside the join
     * transaction so an unaffordable request rolls back with its charge.
     */
    private readonly coins: CoinService,
  ) {}

  /**
   * Ask to join an event.
   *
   * The concurrency-critical path (plan §5). A request that finds a free seat is
   * PENDING and *holds* that seat; one that does not is WAITLISTED and holds
   * nothing. Both are created directly in their status rather than created-then-
   * transitioned, because §7 draws both as entry edges from nothing — there is no
   * prior state to assert a transition out of.
   */
  async join(userId: string, eventPublicId: string): Promise<ParticipationDetail> {
    const now = this.clock.now();
    // The channel-membership gate (M22 phase 6), before anything is read or
    // locked: refusing early costs nothing and takes no row lock.
    await this.membership.assertAllowed(userId, 'EVENT_JOIN');
    const joiner = await this.loadJoiner(userId);

    const [hostResponseHours, minHoursBefore, minResponseMinutes, joinCost] = await Promise.all([
      this.settings.getInt('participation.host_response_hours'),
      this.settings.getInt('participation.min_hours_before_event'),
      this.settings.getInt('participation.min_response_minutes'),
      this.settings.getInt('economy.event_join_coins'),
    ]);

    return this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByPublicIdForUpdate(tx, eventPublicId);
        if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

        this.assertJoinable(event, now);
        if (event.hostUserId === userId) throw new AppError(ErrorCode.HOST_CANNOT_JOIN);
        await this.assertEligible(tx, event.id, joiner, now);

        /**
         * Room in the host's queue, which is not the same as an empty seat.
         *
         * `accepted_count` counts accepted people only (v0.6.5 — see
         * `SEAT_HOLDING_STATUSES`), so admitting on that alone would admit
         * everybody as PENDING and the waiting list would never receive anybody.
         * The bound is seats plus requests still awaiting a decision: a host is
         * asked about at most `capacity` people at a time, which is the property
         * plan §5's waitlist rule was actually protecting.
         *
         * Counted under the event lock this transaction already holds, so two
         * simultaneous joiners of the last slot cannot both read the same count.
         */
        const outstanding = await tx.eventParticipant.count({
          where: { eventId: event.id, status: { in: [...SLOT_HOLDING_STATUSES] } },
        });
        const roomToAsk = event.acceptedCount + outstanding < event.capacity;
        const status: ParticipantStatus = roomToAsk ? 'PENDING' : 'WAITLISTED';
        const hostDeadlineAt = roomToAsk
          ? this.hostDeadline(
              now,
              event.startsAt,
              hostResponseHours,
              minHoursBefore,
              minResponseMinutes,
            )
          : null;

        // ON CONFLICT DO NOTHING, expressed through Prisma. `count === 0` means a
        // row for this (event, user) already existed — invariant 4 answered by
        // the database. A read-then-write existence check would have a window
        // between the read and the insert; this has none.
        const inserted = await tx.eventParticipant.createMany({
          data: [{ eventId: event.id, userId, status, requestedAt: now, hostDeadlineAt }],
          skipDuplicates: true,
        });
        if (inserted.count === 0) throw new AppError(ErrorCode.DUPLICATE_REQUEST);

        /**
         * **No seat is taken here.** A request is a question, and a question does
         * not fill a place — `accept` is what does, and it is the only caller of
         * `takeSeat` on this path now. See `SEAT_HOLDING_STATUSES` for the
         * report that forced the change.
         */

        // `request_count` is a lifetime counter for ranking (M5), not a seat
        // count: it never goes down when somebody cancels.
        await tx.event.update({
          where: { id: event.id },
          data: { requestCount: { increment: 1 } },
        });

        const participant = await this.readParticipant(tx, event.id, userId);

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'participation.requested',
            targetType: 'event_participant',
            targetId: participant.id,
            after: { status, eventId: event.id, seatTaken: false },
          },
          tx,
        );

        // §5's join flow ends with this row, and M6 could not write it because
        // the outbox did not exist yet. The host is told somebody asked; a
        // waitlisted request says so, so the notification can be honest about
        // what happened rather than promising a seat.
        await this.outbox.emit(
          {
            aggregateType: 'event_participant',
            aggregateId: participant.id,
            eventType: 'participation.requested',
            payload: {
              participantPublicId: participant.publicId,
              eventPublicId: event.publicId,
              eventTitle: event.title,
              hostUserPublicId: await this.publicIdOf(tx, event.hostUserId),
              participantUserPublicId: await this.publicIdOf(tx, userId),
              status,
            },
          },
          tx,
        );

        /**
         * What asking costs, charged **inside this transaction** (v0.6.3).
         *
         * Last, so every refusal above — a cancelled event, a full one that is
         * also past its cutoff, an age bound, a duplicate — costs nothing and
         * takes no lock on the coin account. Inside, so `INSUFFICIENT_COINS`
         * rolls the participation back rather than leaving a request somebody
         * did not pay for: there is no state where one exists without the other.
         *
         * **Zero is the shipped default and writes no row at all.**
         * `coin_ledger.amount` may not be zero, and a row claiming somebody paid
         * nothing is worse than no row — the same rule `EventService.create`
         * follows for a free event.
         *
         * A waitlisted request is charged like a seated one. What is paid for is
         * the *ask*: it consumes a host's attention and a slot of the daily
         * request quota whether or not a seat was free. Refunding a rejection
         * would make this a deposit, which is a different product decision.
         *
         * Lock ordering: the **event** row is held by this transaction and
         * `CoinService` takes the coin account second, which is ADR-0006's
         * event → user → coin-account order — the same one `EventService.create`
         * set.
         */
        if (joinCost > 0) {
          await this.coins.apply(
            {
              userId,
              amount: -joinCost,
              type: 'EVENT_JOIN_SPEND',
              reasonCode: EVENT_JOIN_REASON,
              // Deterministic and exactly-once by construction: `createMany` with
              // `skipDuplicates` above means one row per (event, user) ever, so
              // this key can never name two different requests.
              idempotencyKey: eventJoinSpendKey(event.id, userId),
              actorType: 'USER',
              actorId: userId,
              refType: 'event_participant',
              refId: participant.id,
            },
            tx,
          );
        }

        return this.toDetail(participant, event.publicId, tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * The host says yes — **and this is where a seat is taken** (v0.6.5).
   *
   * It used to be that no seat changed hands here, because a PENDING request had
   * held one since it was made and the assertion below was unreachable. That is
   * inverted now: PENDING holds nothing, so accepting is the transition that
   * fills a place, and `assertSeatAvailable` is a live guard rather than a
   * defensive one.
   *
   * It can now genuinely refuse. `join` admits up to `capacity` outstanding
   * requests, and a host may accept a promoted one after already filling the
   * last seat — so `CAPACITY_EXCEEDED` is a real answer to a real tap, and it is
   * the right one: the alternative is overbooking, which the database's
   * `CHECK (accepted_count <= capacity)` would refuse anyway, with a constraint
   * name instead of a Persian sentence.
   */
  async accept(hostUserId: string, participantPublicId: string): Promise<ParticipationDetail> {
    const now = this.clock.now();
    const graceMinutes = await this.settings.getInt('participation.grace_minutes');

    return this.decide(hostUserId, participantPublicId, async (tx, event, participant) => {
      assertParticipantTransition(participant.status, 'ACCEPTED', participant.id);

      if (!holdsSeat(participant.status)) {
        this.assertSeatAvailable(event);
        await this.takeSeat(tx, event);
      }

      const updated = await tx.eventParticipant.update({
        where: { id: participant.id },
        data: {
          status: 'ACCEPTED',
          decidedAt: now,
          acceptedAt: now,
          // The 15-minute window in which changing your mind costs nothing
          // (plan §11). Stored rather than recomputed, so M10 judges a
          // cancellation against the grace the participant was actually given.
          graceExpiresAt: new Date(now.getTime() + graceMinutes * 60_000),
          version: { increment: 1 },
        },
      });

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: hostUserId,
          action: 'participation.accepted',
          targetType: 'event_participant',
          targetId: participant.id,
          before: { status: participant.status },
          after: { status: 'ACCEPTED' },
        },
        tx,
      );

      await this.outbox.emit(
        {
          aggregateType: 'event_participant',
          aggregateId: participant.id,
          eventType: 'participation.accepted',
          payload: {
            participantPublicId: updated.publicId,
            eventPublicId: event.publicId,
            eventTitle: event.title,
            participantUserPublicId: await this.publicIdOf(tx, participant.userId),
          },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * The host says no, the seat the request was holding goes back — **and so do
   * the coins** (v0.8.1).
   *
   * ── Why asking is now a deposit, and not a fee ──────────────────────────────
   *
   * `join` charges `economy.event_join_coins` for the *ask*, and the comment
   * there used to reason that a rejection keeps it because refunding "would make
   * this a deposit, which is a different product decision". That decision has
   * been taken: it is a deposit. What the charge is actually for is protecting a
   * host's attention from somebody spraying requests at fifty activities, and a
   * guest whose one request was turned down did not do that — they paid five
   * coins to be told no, by a host they never met, for a reason they never hear.
   *
   * A **rejection** is refunded and nothing else is. An expiry is not (the host
   * was asked and the queue slot was held for a day), a withdrawal is not (the
   * guest changed their mind and `cancel` prices that on its own thresholds), and
   * an acceptance obviously is not. Only the case where the product took a
   * payment for something the payer never received.
   *
   * Inside the same transaction as the state change, under the event lock this
   * transaction already holds, taking the coin-account lock beneath it — the
   * event → coin account order ADR-0006 fixes and `join` already follows.
   */
  async reject(hostUserId: string, participantPublicId: string): Promise<ParticipationDetail> {
    const now = this.clock.now();

    return this.decide(hostUserId, participantPublicId, async (tx, event, participant) => {
      assertParticipantTransition(participant.status, 'REJECTED', participant.id);

      if (holdsSeat(participant.status)) await this.releaseSeat(tx, event);

      const updated = await tx.eventParticipant.update({
        where: { id: participant.id },
        data: { status: 'REJECTED', decidedAt: now, version: { increment: 1 } },
      });

      const refunded = await this.refundJoinCharge(tx, participant.id, {
        reasonCode: EVENT_JOIN_REFUND_REASON,
        // The host caused it, and the trail should say whose decision it was
        // rather than attributing a user's refund to `SYSTEM`.
        actorType: 'USER',
        actorId: hostUserId,
      });

      // The seat is free again, so the queue moves — in the same transaction and
      // under the same lock, so a rejection and a cancellation racing each other
      // cannot promote the same person twice.
      await this.fillFreedSeats(tx, event, now);

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: hostUserId,
          action: 'participation.rejected',
          targetType: 'event_participant',
          targetId: participant.id,
          before: { status: participant.status },
          after: { status: 'REJECTED', coinsRefunded: refunded },
        },
        tx,
      );

      await this.outbox.emit(
        {
          aggregateType: 'event_participant',
          aggregateId: participant.id,
          eventType: 'participation.rejected',
          payload: {
            participantPublicId: updated.publicId,
            eventPublicId: event.publicId,
            eventTitle: event.title,
            participantUserPublicId: await this.publicIdOf(tx, participant.userId),
            /**
             * How many coins went back, so the message can say so.
             *
             * Zero whenever joining was free — which is the shipped state for
             * every deployment that has not set a price — and the template says
             * nothing rather than «۰ سکه بازگشت», which reads as a bug.
             */
            coinsRefunded: refunded,
          },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * What cancelling right now would cost, without cancelling (§6's `?dryRun`).
   *
   * Quoted from the same `bucketForLateness` and `priceFor` that do the charging,
   * against the same server clock (invariant 9) — a confirmation dialog is only
   * honest if the number in it is the number that will be taken. A second copy of
   * the table would eventually quote a price the charge no longer agrees with,
   * and the user would find out afterwards.
   */
  async previewCancellation(
    userId: string,
    participantPublicId: string,
  ): Promise<CancellationPreview> {
    const now = this.clock.now();

    const participant = await this.prisma.eventParticipant.findUnique({
      where: { publicId: participantPublicId },
      select: {
        userId: true,
        status: true,
        graceExpiresAt: true,
        event: { select: { startsAt: true } },
      },
    });
    // Same 404 as a participation that does not exist: whose request this is must
    // not be discoverable by anybody else (T3.3).
    if (!participant || participant.userId !== userId) throw new AppError(ErrorCode.NOT_FOUND);

    assertParticipantTransition(participant.status, 'CANCELLED_BY_PARTICIPANT');

    const bucket = bucketFor(participant, participant.event.startsAt, now);
    if (bucket === null) return { bucket: null, price: { coins: 0, trust: 0 } };

    return { bucket, price: await this.penalties.priceFor(bucket) };
  }

  /**
   * The participant withdraws, and pays for it if they left it late (§11).
   *
   * The bucket is decided here, from the server clock, and charged in the same
   * transaction. Both halves of that matter. Deciding it here means the price is
   * judged against the thresholds that applied at the moment of cancelling rather
   * than whenever a job later got around to it; charging it here means the coins
   * and the state change commit together, so there is no window in which somebody
   * has cancelled and not yet been charged (ADR-0007).
   */
  async cancel(
    userId: string,
    participantPublicId: string,
    reason?: string,
  ): Promise<ParticipationDetail> {
    const now = this.clock.now();

    return this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByParticipantPublicIdForUpdate(tx, participantPublicId);
        if (!event) throw new AppError(ErrorCode.NOT_FOUND);

        const participant = await this.readParticipantByPublicId(tx, participantPublicId);
        // Same 404 as a participation that does not exist: whose request this is
        // must not be discoverable by anyone else (T3.3).
        if (participant.userId !== userId) throw new AppError(ErrorCode.NOT_FOUND);

        assertParticipantTransition(participant.status, 'CANCELLED_BY_PARTICIPANT', participant.id);

        if (holdsSeat(participant.status)) await this.releaseSeat(tx, event);

        const bucket = bucketFor(participant, event.startsAt, now);

        /**
         * The charge, under the event lock this transaction already holds.
         *
         * Lock order is event → coin account → trust score, which is the order M9
         * established and the one every value-moving path must keep (ADR-0006).
         * A penalty takes what the account has rather than refusing when it is
         * short: see `CoinService.penalize` for why a penalty and a spend cannot
         * behave the same way here.
         */
        const penalty =
          bucket === null
            ? null
            : await this.penalties.chargeParticipant(tx, {
                participantId: participant.id,
                userId,
                bucket,
                eventId: event.id,
              });

        const updated = await tx.eventParticipant.update({
          where: { id: participant.id },
          data: {
            status: 'CANCELLED_BY_PARTICIPANT',
            cancelledAt: now,
            cancellationBucket: bucket,
            cancellationReason: reason ?? null,
            penaltyLedgerId: penalty?.ledgerId ?? null,
            version: { increment: 1 },
          },
        });

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'participation.cancelled',
            targetType: 'event_participant',
            targetId: participant.id,
            before: { status: participant.status },
            // The reason is the participant's own words about themselves, so it
            // stays on the row rather than being copied into a trail admins read
            // (ADR-0009).
            after: {
              status: 'CANCELLED_BY_PARTICIPANT',
              bucket,
              coinsCharged: penalty?.coinsCharged ?? 0,
              trustApplied: penalty?.trustApplied ?? 0,
            },
          },
          tx,
        );

        /**
         * The host learns the request is gone.
         *
         * Missing until now, and the gap was worst in exactly the case the host
         * is most likely to act on: a guest who withdraws *before* a decision
         * leaves a request sitting in «درخواست‌ها» that the host still believes
         * they owe an answer to. A withdrawal after acceptance mattered too —
         * the seat came free and nothing said so.
         *
         * `statusBefore` is carried because the two cases read differently to a
         * host: an undecided request has simply gone, while an accepted one
         * gives a seat back. The template says which.
         *
         * Emitted inside the transaction like every other user-visible
         * consequence, so a rollback cannot leave the host told about a
         * cancellation that did not happen (ADR-0005).
         */
        await this.outbox.emit(
          {
            aggregateType: 'event_participant',
            aggregateId: participant.id,
            eventType: 'participation.cancelled',
            payload: {
              participantPublicId: participant.publicId,
              eventPublicId: event.publicId,
              eventTitle: event.title,
              hostUserPublicId: await this.publicIdOf(tx, event.hostUserId),
              statusBefore: participant.status,
            },
          },
          tx,
        );

        // ADR-0011's D8: the seat a cancellation frees goes to the next person in
        // the queue, immediately and in this transaction.
        await this.fillFreedSeats(tx, event, now);

        return this.toDetail(updated, event.publicId, tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Expire the requests whose host deadline has passed, one event at a time.
   *
   * Each event is swept in its own transaction under its own lock. Sweeping many
   * events in one transaction would hold several event locks at once, which is
   * exactly what rule 2 forbids — and the sweep is the code most likely to be
   * given a long list to work through.
   *
   * Returns how many requests it retired, so the M13 job can log something
   * meaningful rather than "done".
   */
  async expireOverdue(limit = 200): Promise<number> {
    const now = this.clock.now();

    const overdue = await this.prisma.eventParticipant.findMany({
      where: { status: 'PENDING', hostDeadlineAt: { lte: now } },
      select: { publicId: true },
      orderBy: { hostDeadlineAt: 'asc' },
      take: limit,
    });

    let expired = 0;
    for (const { publicId } of overdue) {
      if (await this.expireOne(publicId, now)) expired += 1;
    }
    return expired;
  }

  /** The host's view of who asked, including the waitlist in queue order. */
  async listForEvent(hostUserId: string, eventPublicId: string): Promise<ParticipantSummary[]> {
    const event = await this.prisma.event.findUnique({
      where: { publicId: eventPublicId },
      select: { id: true, hostUserId: true, deletedAt: true },
    });
    if (!event || event.deletedAt) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    // Not FORBIDDEN: telling a stranger "this exists but is not yours" is more
    // than they are entitled to know (T3.3).
    if (event.hostUserId !== hostUserId) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

    const rows = await this.prisma.eventParticipant.findMany({
      where: { eventId: event.id },
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      select: {
        publicId: true,
        status: true,
        requestedAt: true,
        hostDeadlineAt: true,
        userId: true,
        user: { select: { publicId: true, profile: { select: { displayName: true } } } },
      },
    });

    /**
     * One query for every requester's score, not one per row (M18).
     *
     * `include: { user: { trustScore: … } }` would read the same rows and be
     * shorter, and it is deliberately not used: the score has to be keyed back to
     * the right person by `user_id` explicitly, because "each score is attached to
     * the correct guest" is the property that actually matters here and a map
     * makes it checkable rather than assumed. Rows are absent for anyone who has
     * never moved, so the lookup misses and the score reads null.
     */
    const scores = await this.trustScoresFor(rows.map((row) => row.userId));

    let rank = 0;
    return rows.map((row) => {
      const waitlisted = row.status === 'WAITLISTED';
      if (waitlisted) rank += 1;

      return {
        publicId: row.publicId,
        userPublicId: row.user.publicId,
        displayName: row.user.profile?.displayName ?? 'کاربر پایه‌تَم',
        trustScore: scores.get(row.userId) ?? null,
        status: row.status,
        requestedAt: row.requestedAt,
        hostDeadlineAt: row.hostDeadlineAt,
        waitlistRank: waitlisted ? rank : null,
      };
    });
  }

  /** `user_id → score` for the users that have one. Absent means never judged. */
  private async trustScoresFor(userIds: string[]): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();

    const rows = await this.prisma.trustScore.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
      select: { userId: true, score: true },
    });

    return new Map(rows.map((row) => [row.userId, row.score]));
  }

  /** Everything this user has asked to join, each naming the event it is for. */
  async listMine(userId: string): Promise<MyParticipation[]> {
    const rows = await this.prisma.eventParticipant.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      include: { event: { select: { publicId: true, title: true, startsAt: true } } },
    });

    return Promise.all(
      rows.map(async (row) => ({
        ...(await this.toDetail(row, row.event.publicId, this.prisma)),
        event: {
          publicId: row.event.publicId,
          title: row.event.title,
          startsAt: row.event.startsAt,
        },
      })),
    );
  }

  // ── waitlist promotion (ADR-0011, D8) ──────────────────────────────────────

  /**
   * Move the queue up until the host again has `capacity` things to answer.
   *
   * Called from inside the transaction that freed the slot, under the event lock
   * that transaction already holds. That placement is the whole safety argument:
   * two concurrent cancellations serialise on the lock, so each one sees the
   * other's promotion and they promote two **different** people. It is also why
   * this takes no lock of its own — rule 2 says one lock, and taking a second
   * here would break the property it is protecting.
   *
   * ── The loop bound, and why it had to change ────────────────────────────────
   *
   * This used to loop `while (acceptedCount < capacity)` and call `takeSeat` on
   * each promotion, which terminated only because promoting incremented the
   * counter it was testing. Now that a PENDING row holds no seat (v0.6.5) that
   * loop would promote **every** waitlisted person on the first cancellation and
   * then not stop, so the bound is the thing it was always really about: how many
   * open questions the host has. Seats plus outstanding requests, against
   * capacity — the same arithmetic `join` admits on, which is what keeps the two
   * from disagreeing about when the queue is full.
   *
   * The count is read once and tracked in the loop rather than re-queried per
   * promotion: nothing else can write to this event while the lock is held.
   */
  private async fillFreedSeats(
    tx: Prisma.TransactionClient,
    event: LockedEvent,
    now: Date,
  ): Promise<PromotedParticipant[]> {
    // Read on `tx`. This runs inside the transaction that holds the event lock,
    // and a settings read on the base client would take a *second* connection
    // while holding the first — which under enough concurrent cancellations
    // exhausts the pool and deadlocks it. Latent since M7; found by M9's
    // twenty-way concurrency test, which hit the same shape.
    const [deadlineHours, minHoursBefore, minResponseMinutes] = await Promise.all([
      this.settings.getInt('waitlist.promotion_deadline_hours', tx),
      this.settings.getInt('waitlist.min_hours_before_event', tx),
      this.settings.getInt('participation.min_response_minutes', tx),
    ]);

    const promoted: PromotedParticipant[] = [];

    let outstanding = await tx.eventParticipant.count({
      where: { eventId: event.id, status: { in: [...SLOT_HOLDING_STATUSES] } },
    });

    while (event.acceptedCount + outstanding < event.capacity) {
      // FIFO by `(requested_at, id)`, derived from the rows rather than stored
      // (ADR-0006). `id` breaks ties because UUIDv7 is time-ordered, so two
      // requests in the same millisecond still have a stable, fair order.
      const next = await tx.eventParticipant.findFirst({
        where: { eventId: event.id, status: 'WAITLISTED' },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        // The promoted guest's notification links into their conversation.
      });
      if (!next) break;

      assertParticipantTransition(next.status, 'PENDING', next.id);
      // A promotion produces a PENDING row, which occupies a slot and not a
      // seat. Tracked locally because the event row is not being written.
      outstanding += 1;

      const hostDeadlineAt = this.hostDeadline(
        now,
        event.startsAt,
        deadlineHours,
        minHoursBefore,
        minResponseMinutes,
      );

      await tx.eventParticipant.update({
        where: { id: next.id },
        data: {
          status: 'PENDING',
          promotedAt: now,
          hostDeadlineAt,
          version: { increment: 1 },
        },
      });

      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'waitlist.promoted',
          targetType: 'event_participant',
          targetId: next.id,
          before: { status: 'WAITLISTED' },
          after: { status: 'PENDING', hostDeadlineAt: hostDeadlineAt.toISOString() },
        },
        tx,
      );

      /**
       * One domain event, naming both parties.
       *
       * ADR-0011 requires the promoted participant *and* the host to be told, and
       * that a crash cannot deliver one and lose the other. A single row emitted
       * inside this transaction gives that atomically; M13's relay fans it out
       * into the two notifications, each made exactly-once by
       * `notification.dedupe_key`.
       *
       * Public ids only. This payload becomes the text of a Telegram message, so
       * it is the last place an internal or Telegram identifier should be able to
       * reach (ADR-0009).
       */
      await this.outbox.emit(
        {
          aggregateType: 'event_participant',
          aggregateId: next.id,
          eventType: 'waitlist.promoted',
          payload: {
            participantPublicId: next.publicId,
            eventPublicId: event.publicId,
            eventTitle: event.title,
            hostUserPublicId: await this.publicIdOf(tx, event.hostUserId),
            promotedUserPublicId: await this.publicIdOf(tx, next.userId),
            hostDeadlineAt: hostDeadlineAt.toISOString(),
          },
        },
        tx,
      );

      promoted.push({ id: next.id, publicId: next.publicId, hostDeadlineAt });
    }

    return promoted;
  }

  /**
   * The 5-minute backstop (ADR-0011).
   *
   * The event-driven path above fills a seat the moment it frees, so this should
   * normally find nothing. It exists for the seat freed while the process was
   * dying: without it, a cancellation that committed just before a crash leaves a
   * seat empty and a queue that never moves.
   *
   * One transaction per event, each taking only its own lock — the same reason
   * `expireOverdue` sweeps one at a time.
   */
  async sweepWaitlists(limit = 100): Promise<number> {
    const now = this.clock.now();

    // Events that have somebody waiting and a seat free. Ordered oldest-first so
    // a backlog drains fairly rather than by whatever the planner returns.
    const candidates = await this.prisma.event.findMany({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        startsAt: { gt: now },
        participants: { some: { status: 'WAITLISTED' } },
      },
      select: { publicId: true },
      orderBy: { startsAt: 'asc' },
      take: limit,
    });

    let promoted = 0;
    for (const { publicId } of candidates) {
      promoted += await this.promoteForEvent(publicId);
    }
    return promoted;
  }

  /** One event's promotion pass, under its own lock. */
  private async promoteForEvent(eventPublicId: string): Promise<number> {
    const now = this.clock.now();

    return this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByPublicIdForUpdate(tx, eventPublicId);
        // Re-checked under the lock: the seat this sweep saw free may have been
        // taken by a direct join between the scan and the lock being granted.
        if (!event || event.deletedAt !== null || event.status !== 'PUBLISHED') return 0;
        if (event.startsAt <= now) return 0;

        const promoted = await this.fillFreedSeats(tx, event, now);
        return promoted.length;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  private async publicIdOf(tx: Prisma.TransactionClient, userId: string): Promise<string> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { publicId: true },
    });
    return user.publicId;
  }

  // ── seat accounting ────────────────────────────────────────────────────────

  private assertSeatAvailable(event: LockedEvent): void {
    if (event.acceptedCount >= event.capacity) {
      throw new AppError(ErrorCode.CAPACITY_EXCEEDED, {
        capacity: event.capacity,
        acceptedCount: event.acceptedCount,
      });
    }
  }

  /**
   * Give back what asking cost, when the host says no (v0.8.1).
   *
   * ── Why it reverses a row rather than paying an amount ─────────────────────
   *
   * Because the price is a setting. Reading `economy.event_join_coins` here and
   * crediting that would refund **today's** price for a request made when the
   * price was something else — the classic shape of a refund that is a second
   * source of truth about a payment. `coin_ledger` already holds what was
   * actually taken, and `CoinService.reverse` writes the mirror of it: same
   * subject, same `ref`, `reverses_ledger_id` set, so a ledger filtered by this
   * participant shows the charge and its refund together.
   *
   * ── Exactly-once, twice over ───────────────────────────────────────────────
   *
   * `reverse` derives its idempotency key from the row it undoes, and there is a
   * UNIQUE on `reverses_ledger_id` behind that. Either alone would be enough; the
   * third guard is that a rejection is a **terminal** transition, so
   * `assertParticipantTransition` has already refused a second one before this
   * runs.
   *
   * Returns how many coins moved, so the notification can say. **Zero when
   * joining was free** — the shipped default for any deployment that has not set
   * a price — and zero is the honest answer: `join` writes no ledger row at all
   * at zero, so there is nothing here to find and nothing to announce.
   */
  private async refundJoinCharge(
    tx: Prisma.TransactionClient,
    participantId: string,
    /**
     * Why it came back, and who caused it.
     *
     * A rejection is a host's decision and is attributed to them; an expiry is a
     * deadline passing and is attributed to `SYSTEM`, because writing a host's id
     * against something they conspicuously did not do would be the audit trail
     * inventing an actor.
     */
    refund:
      | { reasonCode: string; actorType: 'USER'; actorId: string }
      | { reasonCode: string; actorType: 'SYSTEM' },
  ): Promise<number> {
    const charges = await tx.coinLedger.findMany({
      where: {
        refType: 'event_participant',
        refId: participantId,
        type: 'EVENT_JOIN_SPEND',
        // Belt and braces: `reverse` refuses a second attempt on its own key, and
        // Postgres treats NULLs as distinct in the UNIQUE on `reverses_ledger_id`.
        reversal: { is: null },
      },
      select: { id: true, amount: true },
    });

    let refunded = 0;
    for (const charge of charges) {
      await this.coins.reverse(
        {
          ledgerId: charge.id,
          reasonCode: refund.reasonCode,
          actorType: refund.actorType,
          ...(refund.actorType === 'USER' ? { actorId: refund.actorId } : {}),
        },
        tx,
      );
      refunded += Math.abs(charge.amount);
    }
    return refunded;
  }

  /**
   * Take a seat, under the lock the caller is already holding.
   *
   * The guard runs again here rather than trusting the caller: this is the only
   * function in the product that increments the counter, so it is the last place
   * the invariant can be checked in code before the CHECK constraint has to.
   */
  private async takeSeat(tx: Prisma.TransactionClient, event: LockedEvent): Promise<void> {
    this.assertSeatAvailable(event);
    await tx.event.update({
      where: { id: event.id },
      data: { acceptedCount: { increment: 1 } },
    });
    event.acceptedCount += 1;
  }

  private async releaseSeat(tx: Prisma.TransactionClient, event: LockedEvent): Promise<void> {
    // GREATEST(0, …) in spirit: a decrement below zero would mean the seat
    // accounting has already gone wrong somewhere, and clamping hides it. The
    // caller only ever releases a seat it has established is held.
    await tx.event.update({
      where: { id: event.id },
      data: { acceptedCount: { decrement: 1 } },
    });
    event.acceptedCount -= 1;
  }

  // ── shared decision path ───────────────────────────────────────────────────

  /**
   * Accept and reject differ only in what they do once the lock is held, so the
   * locking, the ownership check and the audit boundary live here.
   */
  private async decide(
    hostUserId: string,
    participantPublicId: string,
    apply: (
      tx: Prisma.TransactionClient,
      event: LockedEvent,
      participant: { id: string; status: ParticipantStatus; userId: string },
    ) => Promise<ParticipantRow>,
  ): Promise<ParticipationDetail> {
    return this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByParticipantPublicIdForUpdate(tx, participantPublicId);
        if (!event) throw new AppError(ErrorCode.NOT_FOUND);
        if (event.hostUserId !== hostUserId) throw new AppError(ErrorCode.NOT_FOUND);

        const participant = await this.readParticipantByPublicId(tx, participantPublicId);
        const updated = await apply(tx, event, participant);

        return this.toDetail(updated, event.publicId, tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  private async expireOne(participantPublicId: string, now: Date): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByParticipantPublicIdForUpdate(tx, participantPublicId);
        if (!event) return false;

        const participant = await this.readParticipantByPublicId(tx, participantPublicId);
        // Re-read under the lock: the host may have decided between the scan that
        // selected this row and the lock being granted.
        if (participant.status !== 'PENDING') return false;
        if (participant.hostDeadlineAt === null || participant.hostDeadlineAt > now) return false;

        assertParticipantTransition(participant.status, 'EXPIRED', participant.id);
        // Nothing to release: a PENDING request holds a slot in the queue, not a
        // seat (v0.6.5). `fillFreedSeats` below is what moves the queue up.

        await tx.eventParticipant.update({
          where: { id: participant.id },
          data: { status: 'EXPIRED', version: { increment: 1 } },
        });

        /**
         * The coins come back (v0.8.1).
         *
         * The rejection refund landed first, on the argument that the product
         * must not keep a payment for something the payer never received. An
         * expiry is the **stronger** case, not a weaker one: a rejected guest at
         * least got an answer, and this one got nothing at all — their request
         * sat in a queue for a day and quietly died. Charging five coins for that
         * is charging for the host's silence.
         *
         * Attributed to `SYSTEM`, because nobody acted. Writing the host's id
         * against a refund caused by them *not* deciding would put a fiction in
         * the trail.
         */
        const refunded = await this.refundJoinCharge(tx, participant.id, {
          reasonCode: EVENT_JOIN_EXPIRY_REFUND_REASON,
          actorType: 'SYSTEM',
        });

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'participation.expired',
            targetType: 'event_participant',
            targetId: participant.id,
            before: { status: 'PENDING' },
            after: { status: 'EXPIRED', coinsRefunded: refunded },
          },
          tx,
        );

        /**
         * And the guest is told — which nothing did until v0.8.1.
         *
         * A request that expired produced **no notification of any kind**: the
         * row went to EXPIRED, the queue moved up, and the person who had asked
         * was never informed. That was survivable while asking was free. It is
         * not survivable alongside a refund, because the only trace the guest
         * would otherwise have is a coin movement in `/wallet` labelled «برگشت
         * تراکنش» with nothing to attach it to — a balance that changes for
         * reasons a user cannot see is exactly what ADR-0007 exists to prevent.
         *
         * Only the guest. The host is not told that a request they ignored has
         * expired: it is the outcome their own inaction chose, and a message
         * about it would be the product scolding them.
         */
        await this.outbox.emit(
          {
            aggregateType: 'event_participant',
            aggregateId: participant.id,
            eventType: 'participation.expired',
            payload: {
              participantPublicId: participant.publicId,
              eventPublicId: event.publicId,
              eventTitle: event.title,
              participantUserPublicId: await this.publicIdOf(tx, participant.userId),
              coinsRefunded: refunded,
            },
          },
          tx,
        );

        // "An expired promotion moves to the next": the seat an unanswered
        // request was holding goes back to the queue rather than staying empty
        // because the host ignored it.
        await this.fillFreedSeats(tx, event, now);

        return true;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  // ── eligibility ────────────────────────────────────────────────────────────

  private async loadJoiner(userId: string): Promise<Joiner> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        onboardingState: true,
        profile: { select: { birthYear: true, gender: true } },
      },
    });

    if (!user) throw new AppError(ErrorCode.UNAUTHENTICATED);
    if (user.status === 'BANNED') throw new AppError(ErrorCode.USER_BANNED);
    // Joining needs an age and a gender to judge eligibility against, and both
    // live on the profile. Requiring it also keeps the host's side honest: every
    // request they see has a real person behind it.
    //
    // `birth_year` is nullable because M15's anonymisation clears it, so a
    // complete-looking profile can still have none. Without one there is no way
    // to evaluate an age restriction, and silently admitting the request would
    // reach exactly the events the host restricted — the same reasoning that
    // makes discovery's `ageFits` refuse rather than return everything.
    if (user.onboardingState !== 'PROFILE_COMPLETE' || !user.profile) {
      throw new AppError(ErrorCode.PROFILE_INCOMPLETE);
    }
    if (user.profile.birthYear === null) throw new AppError(ErrorCode.PROFILE_INCOMPLETE);

    return { birthYear: user.profile.birthYear, gender: user.profile.gender };
  }

  private assertJoinable(event: LockedEvent, now: Date): void {
    // Not-published and not-found answer identically. A user cannot ask this
    // endpoint whether a hidden event exists (T3.3).
    if (event.deletedAt !== null || event.status !== 'PUBLISHED') {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    }
    if (event.startsAt <= now) throw new AppError(ErrorCode.EVENT_NOT_JOINABLE);
  }

  /**
   * The host's own restrictions, checked against the server's copy of the
   * profile rather than anything the client sent (invariant 9).
   */
  private async assertEligible(
    tx: Prisma.TransactionClient,
    eventId: string,
    joiner: Joiner,
    now: Date,
  ): Promise<void> {
    const event = await tx.event.findUniqueOrThrow({
      where: { id: eventId },
      select: { genderPreference: true, minAge: true, maxAge: true },
    });

    if (event.genderPreference !== null) {
      const required = event.genderPreference === 'MALE_ONLY' ? 'MALE' : 'FEMALE';
      // PREFER_NOT_SAY fails a gendered restriction rather than passing it. The
      // alternative is admitting someone the host explicitly excluded, which is
      // worse than the refusal — and the refusal names the reason, so the user
      // can decide whether to state a gender.
      if (joiner.gender !== required) throw new AppError(ErrorCode.NOT_ELIGIBLE_GENDER);
    }

    const age = ageFromBirthYear(joiner.birthYear, now, this.env.APP_TIMEZONE);
    if (
      (event.minAge !== null && age < event.minAge) ||
      (event.maxAge !== null && age > event.maxAge)
    ) {
      throw new AppError(ErrorCode.NOT_ELIGIBLE_AGE);
    }
  }

  // ── reads and shaping ──────────────────────────────────────────────────────

  private async readParticipant(
    tx: Prisma.TransactionClient,
    eventId: string,
    userId: string,
  ): Promise<ParticipantRow> {
    return tx.eventParticipant.findUniqueOrThrow({
      where: { eventId_userId: { eventId, userId } },
    });
  }

  private async readParticipantByPublicId(
    tx: Prisma.TransactionClient,
    publicId: string,
  ): Promise<ParticipantRow> {
    const participant = await tx.eventParticipant.findUnique({
      where: { publicId },
    });
    if (!participant) throw new AppError(ErrorCode.NOT_FOUND);
    return participant;
  }

  /**
   * `min(now + 24h, starts_at - 3h)`, but never already past (plan §11, v0.7.0).
   *
   * The second term stops a request being decided so late that nobody can act on
   * the answer. It used to be the whole story, and the comment here said a
   * deadline in the past was *correct* — the request would expire on the next
   * sweep rather than hold a slot nobody could fill.
   *
   * It is not correct, and it is the second half of the reported «این عملیات در
   * وضعیت فعلی ممکن نیست». For an activity starting in under three hours,
   * `starts_at - 3h` is behind `now`, so the request was **born expired**: the
   * guest was told it had been sent, the host got the notification with its two
   * buttons, and the sweep retired it somewhere in between. Whichever of them
   * pressed first got a refusal about a state nobody had chosen.
   *
   * So the deadline is floored: never earlier than a few minutes from now, and
   * never past the start of the activity itself. A short window is short — which
   * is honest, because the activity *is* soon — but it is a window, and both
   * parties can act inside it.
   *
   * `participation.min_response_minutes` is what that floor is, and it is a
   * setting for the reason every other number here is: how long is long enough is
   * a product question, not a constant.
   */
  private hostDeadline(
    now: Date,
    startsAt: Date,
    hours: number,
    minHoursBefore: number,
    minResponseMinutes: number,
  ): Date {
    const byResponseWindow = now.getTime() + hours * 3_600_000;
    const byEventStart = startsAt.getTime() - minHoursBefore * 3_600_000;
    const preferred = Math.min(byResponseWindow, byEventStart);

    // The floor, itself bounded by the start: a deadline after the activity has
    // begun is a decision nobody can act on either.
    const floor = Math.min(now.getTime() + minResponseMinutes * 60_000, startsAt.getTime());

    return new Date(Math.max(preferred, floor));
  }

  private async toDetail(
    participant: ParticipantRow,
    eventPublicId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ParticipationDetail> {
    return {
      publicId: participant.publicId,
      eventPublicId,
      status: participant.status,
      requestedAt: participant.requestedAt,
      hostDeadlineAt: participant.hostDeadlineAt,
      graceExpiresAt: participant.graceExpiresAt,
      acceptedAt: participant.acceptedAt,
      cancelledAt: participant.cancelledAt,
      cancellationBucket: participant.cancellationBucket,
      waitlistRank:
        participant.status === 'WAITLISTED' ? await this.waitlistRank(tx, participant) : null,
    };
  }

  /**
   * Position in the queue, derived rather than stored (ADR-0006).
   *
   * A stored rank would need rewriting for everyone behind each cancellation,
   * which is both a write amplification and a chance to be wrong. Counting the
   * rows ahead is exact by construction, and the partial index on
   * `(event_id, requested_at, id) WHERE status = 'WAITLISTED'` is what makes it
   * cheap.
   */
  private async waitlistRank(
    tx: Prisma.TransactionClient,
    participant: ParticipantRow,
  ): Promise<number> {
    const ahead = await tx.eventParticipant.count({
      where: {
        eventId: participant.eventId,
        status: 'WAITLISTED',
        OR: [
          { requestedAt: { lt: participant.requestedAt } },
          { requestedAt: participant.requestedAt, id: { lt: participant.id } },
        ],
      },
    });
    return ahead + 1;
  }
}

/**
 * Which side of §11's thresholds a cancellation fell on.
 *
 * A request that never held a seat has **no bucket**: withdrawing from a queue
 * costs nothing, and giving it one would put a charge in front of somebody who
 * was never given a seat to give up. The grace window is checked before the
 * clock thresholds, because being inside it is free however late the event is.
 *
 * A free function rather than a method: it is the same decision the dry-run
 * quotes and the same one the charge uses, and passing it around as a pure
 * function is what keeps those from becoming two answers.
 */
function bucketFor(
  participant: { status: ParticipantStatus; graceExpiresAt: Date | null },
  startsAt: Date,
  now: Date,
): CancellationBucket | null {
  if (participant.status !== 'ACCEPTED') return null;
  if (participant.graceExpiresAt !== null && now <= participant.graceExpiresAt) return 'GRACE';
  return bucketForLateness(startsAt, now);
}

/** What `?dryRun=true` answers with: the bucket and its price, charging nothing. */
export interface CancellationPreview {
  /** Null when this cancellation is not priced at all — a queue withdrawal. */
  bucket: CancellationBucket | null;
  price: PenaltyPrice;
}

interface Joiner {
  birthYear: number;
  gender: 'MALE' | 'FEMALE' | 'PREFER_NOT_SAY' | null;
}

interface PromotedParticipant {
  id: string;
  publicId: string;
  hostDeadlineAt: Date;
}

type ParticipantRow = {
  id: string;
  publicId: string;
  eventId: string;
  userId: string;
  status: ParticipantStatus;
  requestedAt: Date;
  hostDeadlineAt: Date | null;
  graceExpiresAt: Date | null;
  acceptedAt: Date | null;
  cancelledAt: Date | null;
  cancellationBucket: CancellationBucket | null;
};
