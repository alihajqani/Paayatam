import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { OutboxService } from '../outbox/outbox.service';
import { channelPostSpendKey, eventCreateSpendKey } from './event.service';

export const HOST_DEPOSIT_REFUND_REASON = 'host.deposit_refund';
export const HOST_REWARD_REASON = 'host.attendance_bonus';

/**
 * One settlement per event, for each half. Derived from the event, never from a
 * timestamp — a re-run of the sweep collides on the key rather than paying twice.
 */
export function hostDepositRefundKey(eventId: string): string {
  return `host-refund:${eventId}`;
}
export function hostRewardKey(eventId: string): string {
  return `host-bonus:${eventId}`;
}

export interface HostSettlementResult {
  /** Events settled by this pass. */
  events: number;
  /** Coins paid, both halves together. */
  coins: number;
}

/** What one event's settlement worked out to, before anything was written. */
interface Settlement {
  eventId: string;
  hostUserId: string;
  attendees: number;
  refund: number;
  bonus: number;
}

/**
 * The other half of the host deposit (docs/coin-economy-plan.md §3, §4).
 *
 * ── The product decision this file implements ───────────────────────────────
 *
 * Registering an activity charges `economy.event_create_coins` plus
 * `economy.event_channel_publish_coins`. Until now that was a **fee**: paid,
 * gone, whether or not the evening ever happened. That prices the wrong thing.
 * Hosts are the scarce side of this marketplace — with no activities nobody buys
 * anything at any price — so a host who actually turns up should end the month
 * *up* on coins and should never be pushed towards buying them.
 *
 * What genuinely deserves to be expensive is the **ghost activity**: registered,
 * listed in the channel, never held, with every guest who planned an evening
 * around it paying the real cost. So the charge stays, and this service gives it
 * back to the hosts who held theirs — plus a small per-guest bonus on top. The
 * charge becomes a deposit and the sentence the bot says changes from "it costs
 * 25 coins" to "it is a 25-coin deposit and you get it back", which is the
 * difference between having hosts and not having them.
 *
 * ── Why a sweep and not a hook on the settlement ────────────────────────────
 *
 * The reward is conditional on the host having **written their reviews**, and
 * reviews are written over the seven days *after* attendance settles. There is no
 * single moment to hang this on: the last review might be the host's fourth, on
 * day six, at two in the morning. A sweep re-asks the question every hour and
 * pays the first time the answer is yes.
 *
 * It is bounded on both ends. The lower bound is the attendance settlement delay,
 * because attendance has to be settled before anybody can be counted. The upper
 * bound is the review deadline plus a day, past which the host can no longer
 * write the reviews the reward requires — so the candidate set is a few days of
 * events, forever, rather than a table that grows.
 *
 * ── Why the host's reviews are a condition at all ───────────────────────────
 *
 * Because a hosting bonus with no quality gate pays for *holding* an event, and
 * holding an event is something two friends can do in a kitchen. Writing reviews
 * is the cheapest available proof that real people were there and that the host
 * engaged with them, and it feeds the trust signal that is the only thing
 * separating this product from a group chat. It is also the condition a farm
 * finds most expensive: fake attendees have to be reviewed individually, by hand,
 * within the window.
 *
 * ── Lock discipline ────────────────────────────────────────────────────────
 *
 * One event per transaction, and **no event row lock is taken**. Nothing here
 * changes `accepted_count` or any other field ADR-0006's lock protects; the only
 * writes are ledger rows keyed by the event id, and the ledger's UNIQUE
 * `idempotency_key` is what makes two concurrent passes safe. Taking the event
 * lock would mean holding it while taking the host's coin-account lock, which is
 * exactly the second-lock-of-unknown-order rule 2 forbids.
 */
@Injectable()
export class HostRewardService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Pay every host who has earned it and has not been paid yet.
   *
   * Idempotent and re-runnable: an event already settled produces no movement,
   * because both halves collide on their keys.
   */
  async settle(limit = 200): Promise<HostSettlementResult> {
    const now = this.clock.now();
    const policy = await this.settings.getNumbers([
      'economy.host_deposit_refund_coins',
      'economy.host_reward_per_attendee_coins',
      'economy.host_reward_min_attendees',
      'economy.host_reward_cap',
      'economy.earning_cap_days',
      'participation.settlement_delay_hours',
      'review.window_deadline_days',
    ]);

    // Both halves off. Nothing to do, and no reason to scan for candidates.
    if (
      policy['economy.host_deposit_refund_coins'] <= 0 &&
      policy['economy.host_reward_per_attendee_coins'] <= 0
    ) {
      return { events: 0, coins: 0 };
    }

    const settledBefore = new Date(
      now.getTime() - policy['participation.settlement_delay_hours'] * 3_600_000,
    );
    /**
     * The oldest event still worth asking about.
     *
     * A host who has not written their reviews by the deadline never will — the
     * review service refuses past it — so an event older than this can never
     * become eligible and re-checking it every hour would be a scan that grows
     * without bound. One day of slack past the deadline covers a sweep that was
     * not running when the last review landed.
     */
    const oldestCandidate = new Date(
      now.getTime() - (policy['review.window_deadline_days'] + 1) * 24 * 3_600_000,
    );

    const candidates = await this.prisma.event.findMany({
      where: {
        status: 'COMPLETED',
        deletedAt: null,
        endsAt: { lte: settledBefore, gte: oldestCandidate },
        /**
         * Not an evening whose host a moderator found absent (plan 08), and not
         * one while guests' «میزبان نیامد» is still being decided.
         *
         * The first used to hold by accident — a host who was not there cannot
         * review the guests who were, and `assess` waits on those reviews — and
         * accident is not a guarantee: plan 10 let a host who marked everybody
         * absent collect the deposit with no reviews owed at all. The second is
         * the hold: nothing is paid while the answer might be to take it back.
         */
        hostAbsentAt: null,
        noShowClaims: {
          none: {
            kind: 'HOST_ABSENT_REPORT',
            moderationCase: { status: { in: ['OPEN', 'IN_REVIEW', 'ESCALATED'] } },
          },
        },
      },
      select: { id: true, hostUserId: true },
      orderBy: { endsAt: 'asc' },
      take: limit,
    });

    const result: HostSettlementResult = { events: 0, coins: 0 };
    for (const candidate of candidates) {
      const paid = await this.settleOne(candidate.id, candidate.hostUserId, policy, now);
      if (paid > 0) {
        result.events += 1;
        result.coins += paid;
      }
    }
    return result;
  }

  /** Returns what was paid, or zero when the event did not qualify. */
  private async settleOne(
    eventId: string,
    hostUserId: string,
    policy: Record<string, number>,
    now: Date,
  ): Promise<number> {
    // Outside the transaction: the cheap refusals, which is almost every
    // candidate on almost every pass. Opening a transaction per event only to
    // find it already paid would be one connection per event, per hour, forever.
    const settlement = await this.assess(eventId, hostUserId, policy, now);
    if (settlement === null) return 0;

    return this.prisma.$transaction(
      async (tx) => {
        /**
         * What **this call** actually paid, which is not always what it worked
         * out.
         *
         * `applied` comes back false when a concurrent pass got there first. Those
         * coins are real and already in the balance; they are simply not this
         * call's to report — and the distinction is not bookkeeping pedantry,
         * because these two figures go into the message the host receives. A pass
         * that announced a deposit another pass had returned would tell somebody
         * their balance moved by an amount it did not.
         */
        let paidRefund = 0;
        let paidBonus = 0;

        if (settlement.refund > 0) {
          const movement = await this.coins.apply(
            {
              userId: hostUserId,
              amount: settlement.refund,
              type: 'EVENT_DEPOSIT_REFUND',
              reasonCode: HOST_DEPOSIT_REFUND_REASON,
              idempotencyKey: hostDepositRefundKey(eventId),
              actorType: 'SYSTEM',
              refType: 'event',
              refId: eventId,
            },
            tx,
          );
          if (movement.applied) paidRefund = settlement.refund;
        }

        if (settlement.bonus > 0) {
          const movement = await this.coins.apply(
            {
              userId: hostUserId,
              amount: settlement.bonus,
              type: 'HOST_REWARD',
              reasonCode: HOST_REWARD_REASON,
              idempotencyKey: hostRewardKey(eventId),
              actorType: 'SYSTEM',
              refType: 'event',
              refId: eventId,
              metadata: { attendees: settlement.attendees },
            },
            tx,
          );
          if (movement.applied) paidBonus = settlement.bonus;
        }

        const paid = paidRefund + paidBonus;
        if (paid === 0) return 0;

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'host.settled',
            targetType: 'event',
            targetId: eventId,
            after: { attendees: settlement.attendees, refund: paidRefund, bonus: paidBonus },
          },
          tx,
        );

        /**
         * Emitted inside the transaction that pays, like every other user-visible
         * consequence (ADR-0005): a rollback must not be able to announce coins
         * nobody received.
         *
         * Public ids only. The host is told how many people turned up, which is a
         * count of their own guests and something they already know.
         */
        const [host, event] = await Promise.all([
          tx.user.findUniqueOrThrow({ where: { id: hostUserId }, select: { publicId: true } }),
          tx.event.findUniqueOrThrow({ where: { id: eventId }, select: { title: true } }),
        ]);

        await this.outbox.emit(
          {
            aggregateType: 'event',
            aggregateId: eventId,
            eventType: 'host.settled',
            payload: {
              hostUserPublicId: host.publicId,
              eventTitle: event.title,
              attendees: settlement.attendees,
              refund: paidRefund,
              bonus: paidBonus,
              total: paid,
            },
          },
          tx,
        );

        return paid;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  /**
   * Does this event qualify, and for how much — all reads, no writes.
   *
   * ── Two halves, two conditions (plan 10) ───────────────────────────────────
   *
   * The deposit and the bonus used to share one gate — at least
   * `economy.host_reward_min_attendees` guests `COMPLETED` and attended — and
   * that made honesty expensive. A no-show is `NO_SHOW`, so reporting one dropped
   * the count below the threshold and forfeited the deposit, while a guest nobody
   * reported was settled as attended: two guests with one absent paid 0 to the
   * host who said so and 29 to the one who stayed quiet, and the quiet one had to
   * review somebody who was not there.
   *
   * - **The deposit** is what the host paid, so returning it is not earning. It
   *   needs an activity that happened with somebody in a seat: at least one
   *   participation settled as `COMPLETED` or `NO_SHOW`.
   * - **The bonus** is earning, and keeps the anti-collusion threshold on the
   *   guests who actually came.
   * - **Reviews** are owed for the guests who came — a no-show gets no review
   *   pair, so there is nothing to write for them.
   *
   * A fabricated no-show cannot mint the deposit either: the partner pays the
   * join deposit and a 60-coin penalty to return 25 to the host.
   *
   * Null means "not this one", cheapest refusal first.
   */
  private async assess(
    eventId: string,
    hostUserId: string,
    policy: Record<string, number>,
    now: Date,
  ): Promise<Settlement | null> {
    const minAttendees = Math.max(policy['economy.host_reward_min_attendees'] ?? 0, 1);

    const [alreadyRefunded, alreadyPaid, seated, attended] = await Promise.all([
      this.prisma.coinLedger.findUnique({
        where: { idempotencyKey: hostDepositRefundKey(eventId) },
        select: { id: true },
      }),
      this.prisma.coinLedger.findUnique({
        where: { idempotencyKey: hostRewardKey(eventId) },
        select: { id: true },
      }),
      this.prisma.eventParticipant.count({
        where: { eventId, status: { in: ['COMPLETED', 'NO_SHOW'] } },
      }),
      this.prisma.eventParticipant.count({
        where: { eventId, status: 'COMPLETED', attended: true },
      }),
    ]);

    if (alreadyRefunded !== null && alreadyPaid !== null) return null;

    const depositDue = alreadyRefunded === null && seated >= 1;
    const bonusDue = alreadyPaid === null && attended >= minAttendees;
    if (!depositDue && !bonusDue) return null;

    /**
     * The host has written a review for everybody who turned up.
     *
     * Counted rather than joined per participant: `review` is UNIQUE on
     * `(participant_id, reviewer_user_id)`, so the host cannot have written two
     * for one person and the count is exactly "how many of them did they
     * review?". A count below the attendee total means at least one is
     * outstanding, and the next pass will ask again.
     */
    const written = await this.prisma.review.count({
      where: { eventId, reviewerUserId: hostUserId },
    });
    if (written < attended) return null;

    const refund = depositDue ? await this.refundFor(eventId, policy) : 0;
    const bonus = bonusDue ? await this.bonusFor(hostUserId, attended, policy, now) : 0;
    if (refund <= 0 && bonus <= 0) return null;

    // `attendees` goes into the host's message and the ledger metadata, so it is
    // the number who came — not the number of seats.
    return { eventId, hostUserId, attendees: attended, refund, bonus };
  }

  /**
   * The deposit, floored at what was actually charged for **this** event.
   *
   * Structural rather than a rule somebody has to remember: without the floor, an
   * operator who raised `economy.host_deposit_refund_coins` above the
   * registration price would turn hosting into a mint, and would find out from
   * the ledger reconciliation rather than from the setting. Read back by the two
   * spend keys, so what is returned is what that host paid on the day — not what
   * registration costs today, which may have moved since.
   *
   * Renewals are deliberately **not** included. `economy.event_channel_send_coins`
   * buys position in the channel a second time; it is a purchase, not a deposit,
   * and returning it would make repeated renewals free.
   */
  private async refundFor(eventId: string, policy: Record<string, number>): Promise<number> {
    const configured = policy['economy.host_deposit_refund_coins'] ?? 0;
    if (configured <= 0) return 0;

    const charges = await this.prisma.coinLedger.findMany({
      where: {
        idempotencyKey: { in: [eventCreateSpendKey(eventId), channelPostSpendKey(eventId)] },
      },
      select: { amount: true },
    });

    // Spends are negative. `-sum` is what was taken.
    const charged = -charges.reduce((total, row) => total + row.amount, 0);
    return Math.max(0, Math.min(configured, charged));
  }

  /** The per-guest bonus, after the rolling cap. Zero is a legitimate answer. */
  private async bonusFor(
    hostUserId: string,
    attendees: number,
    policy: Record<string, number>,
    now: Date,
  ): Promise<number> {
    const perAttendee = policy['economy.host_reward_per_attendee_coins'] ?? 0;
    if (perAttendee <= 0) return 0;

    const earned = perAttendee * attendees;
    const cap = policy['economy.host_reward_cap'] ?? 0;
    const days = policy['economy.earning_cap_days'] ?? 0;
    if (cap <= 0 || days <= 0) return earned;

    const since = new Date(now.getTime() - days * 24 * 3_600_000);
    const already = await this.coins.earnedSince(hostUserId, since, { types: ['HOST_REWARD'] });

    // The deposit refund is `EVENT_DEPOSIT_REFUND` and is not in that filter, so
    // it does not eat the allowance: getting back what you paid is not earning,
    // and a cap that counted it would punish a host for hosting often.
    return Math.max(0, Math.min(earned, cap - already.coins));
  }
}
