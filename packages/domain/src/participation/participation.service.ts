import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { CancellationBucket, ParticipantStatus, Prisma } from '@payetam/db';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import {
  lockEventByParticipantPublicIdForUpdate,
  lockEventByPublicIdForUpdate,
  type LockedEvent,
} from '../events/event-lock';
import { OutboxService } from '../outbox/outbox.service';
import { ageFromBirthYear } from '../profile/age';
import { assertParticipantTransition, holdsSeat } from './state-machine';

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

/** What the host sees about somebody who asked to join. */
export interface ParticipantSummary {
  publicId: string;
  userPublicId: string;
  displayName: string;
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
    const joiner = await this.loadJoiner(userId);

    const [hostResponseHours, minHoursBefore] = await Promise.all([
      this.settings.getInt('participation.host_response_hours'),
      this.settings.getInt('participation.min_hours_before_event'),
    ]);

    return this.prisma.$transaction(
      async (tx) => {
        const event = await lockEventByPublicIdForUpdate(tx, eventPublicId);
        if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

        this.assertJoinable(event, now);
        if (event.hostUserId === userId) throw new AppError(ErrorCode.HOST_CANNOT_JOIN);
        await this.assertEligible(tx, event.id, joiner, now);

        const seatAvailable = event.acceptedCount < event.capacity;
        const status: ParticipantStatus = seatAvailable ? 'PENDING' : 'WAITLISTED';
        const hostDeadlineAt = seatAvailable
          ? this.hostDeadline(now, event.startsAt, hostResponseHours, minHoursBefore)
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

        if (seatAvailable) {
          await this.takeSeat(tx, event);
        }

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
            after: { status, eventId: event.id, seatTaken: seatAvailable },
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
              hostUserPublicId: await this.publicIdOf(tx, event.hostUserId),
              status,
            },
          },
          tx,
        );

        return this.toDetail(participant, event.publicId, tx);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * The host says yes.
   *
   * No seat changes hands: a PENDING request has held one since it was made, and
   * `assertParticipantTransition` admits nothing else. The capacity assertion
   * below is therefore not reachable through this path today — it is here because
   * "PENDING already holds a seat" is an invariant of this file rather than of
   * the database, and the day a future path accepts a row that holds no seat,
   * this is what stops it overbooking.
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
            participantUserPublicId: await this.publicIdOf(tx, participant.userId),
          },
        },
        tx,
      );

      return updated;
    });
  }

  /** The host says no, and the seat the request was holding goes back. */
  async reject(hostUserId: string, participantPublicId: string): Promise<ParticipationDetail> {
    const now = this.clock.now();

    return this.decide(hostUserId, participantPublicId, async (tx, event, participant) => {
      assertParticipantTransition(participant.status, 'REJECTED', participant.id);

      if (holdsSeat(participant.status)) await this.releaseSeat(tx, event);

      const updated = await tx.eventParticipant.update({
        where: { id: participant.id },
        data: { status: 'REJECTED', decidedAt: now, version: { increment: 1 } },
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
          after: { status: 'REJECTED' },
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
            participantUserPublicId: await this.publicIdOf(tx, participant.userId),
          },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * The participant withdraws.
   *
   * The bucket is recorded here; the coins and trust it costs are M10. Writing
   * the bucket now rather than later means the penalty a participant eventually
   * pays is judged against the thresholds that applied when they cancelled, not
   * against whatever `app_setting` holds by the time the job runs.
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

        const bucket = this.cancellationBucket(participant, event.startsAt, now);

        const updated = await tx.eventParticipant.update({
          where: { id: participant.id },
          data: {
            status: 'CANCELLED_BY_PARTICIPANT',
            cancelledAt: now,
            cancellationBucket: bucket,
            cancellationReason: reason ?? null,
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
            after: { status: 'CANCELLED_BY_PARTICIPANT', bucket },
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
        user: { select: { publicId: true, profile: { select: { displayName: true } } } },
      },
    });

    let rank = 0;
    return rows.map((row) => {
      const waitlisted = row.status === 'WAITLISTED';
      if (waitlisted) rank += 1;

      return {
        publicId: row.publicId,
        userPublicId: row.user.publicId,
        displayName: row.user.profile?.displayName ?? 'کاربر پایه‌تَم',
        status: row.status,
        requestedAt: row.requestedAt,
        hostDeadlineAt: row.hostDeadlineAt,
        waitlistRank: waitlisted ? rank : null,
      };
    });
  }

  /** Everything this user has asked to join. */
  async listMine(userId: string): Promise<ParticipationDetail[]> {
    const rows = await this.prisma.eventParticipant.findMany({
      where: { userId },
      orderBy: { requestedAt: 'desc' },
      include: { event: { select: { publicId: true } } },
    });

    return Promise.all(rows.map((row) => this.toDetail(row, row.event.publicId, this.prisma)));
  }

  // ── waitlist promotion (ADR-0011, D8) ──────────────────────────────────────

  /**
   * Fill every seat that has just come free, in queue order.
   *
   * Called from inside the transaction that released the seat, under the event
   * lock that transaction already holds. That placement is the whole safety
   * argument: two concurrent cancellations serialise on the lock, so each one
   * sees the other's promotion and they promote two **different** people. It is
   * also why this takes no lock of its own — rule 2 says one lock, and taking a
   * second here would break the property it is protecting.
   *
   * A loop rather than a single promotion because a sweep may find several seats
   * free at once; in the common case it runs exactly once and stops.
   */
  private async fillFreedSeats(
    tx: Prisma.TransactionClient,
    event: LockedEvent,
    now: Date,
  ): Promise<PromotedParticipant[]> {
    const [deadlineHours, minHoursBefore] = await Promise.all([
      this.settings.getInt('waitlist.promotion_deadline_hours'),
      this.settings.getInt('waitlist.min_hours_before_event'),
    ]);

    const promoted: PromotedParticipant[] = [];

    while (event.acceptedCount < event.capacity) {
      // FIFO by `(requested_at, id)`, derived from the rows rather than stored
      // (ADR-0006). `id` breaks ties because UUIDv7 is time-ordered, so two
      // requests in the same millisecond still have a stable, fair order.
      const next = await tx.eventParticipant.findFirst({
        where: { eventId: event.id, status: 'WAITLISTED' },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      });
      if (!next) break;

      assertParticipantTransition(next.status, 'PENDING', next.id);
      await this.takeSeat(tx, event);

      const hostDeadlineAt = this.hostDeadline(now, event.startsAt, deadlineHours, minHoursBefore);

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
        await this.releaseSeat(tx, event);

        await tx.eventParticipant.update({
          where: { id: participant.id },
          data: { status: 'EXPIRED', version: { increment: 1 } },
        });

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'participation.expired',
            targetType: 'event_participant',
            targetId: participant.id,
            before: { status: 'PENDING' },
            after: { status: 'EXPIRED' },
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
    const participant = await tx.eventParticipant.findUnique({ where: { publicId } });
    if (!participant) throw new AppError(ErrorCode.NOT_FOUND);
    return participant;
  }

  /**
   * `min(now + 24h, starts_at - 3h)` (plan §11).
   *
   * The second term is what stops a request being decided so late that nobody can
   * act on the answer; for an event starting in two hours it is already in the
   * past, and a deadline in the past is correct — that request expires on the
   * next sweep rather than holding a seat nobody can fill.
   */
  private hostDeadline(now: Date, startsAt: Date, hours: number, minHoursBefore: number): Date {
    const byResponseWindow = now.getTime() + hours * 3_600_000;
    const byEventStart = startsAt.getTime() - minHoursBefore * 3_600_000;
    return new Date(Math.min(byResponseWindow, byEventStart));
  }

  /**
   * Which side of the policy thresholds this cancellation fell on (plan §11).
   *
   * A request that never held a seat has no bucket: there is nothing to penalise
   * in withdrawing from a queue, and giving it one would put a row in front of
   * M10's penalty job that should never have been there.
   */
  private cancellationBucket(
    participant: ParticipantRow,
    startsAt: Date,
    now: Date,
  ): CancellationBucket | null {
    if (participant.status !== 'ACCEPTED') return null;
    if (participant.graceExpiresAt !== null && now <= participant.graceExpiresAt) return 'GRACE';

    const hoursBefore = (startsAt.getTime() - now.getTime()) / 3_600_000;
    if (hoursBefore > 24) return 'GT_24H';
    if (hoursBefore >= 3) return 'H24_TO_H3';
    return 'LT_3H';
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
