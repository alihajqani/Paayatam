import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { CancellationBucket, Prisma } from '@payetam/db';
import { SettingsService, type SettingKey } from '../catalog/settings.service';
import { CoinService } from './coin.service';
import { TrustService } from './trust.service';

/**
 * What a bucket costs. Positive magnitudes; the sign is applied at the charge.
 *
 * Kept unsigned all the way from `app_setting` to here because "how much does a
 * late cancellation cost?" has no sensible negative answer, and a signed config
 * value is one dropped minus sign away from paying people to cancel.
 */
export interface PenaltyPrice {
  coins: number;
  trust: number;
}

export interface ChargedPenalty {
  bucket: CancellationBucket;
  /** What the policy asked for. */
  price: PenaltyPrice;
  /** What was actually taken — never more than the account held. */
  coinsCharged: number;
  /** What the score actually moved by, after the 0–100 clamp. Negative or zero. */
  trustApplied: number;
  /** The penalty row, for `event_participant.penalty_ledger_id`. Null when free. */
  ledgerId: string | null;
}

/** Free by policy, and therefore absent from `app_setting` rather than zero there. */
const FREE_BUCKETS: readonly CancellationBucket[] = ['GRACE', 'GT_24H'];

const COIN_KEYS: Partial<Record<CancellationBucket, SettingKey>> = {
  H24_TO_H3: 'cancellation.coins_h24_to_h3',
  LT_3H: 'cancellation.coins_lt_3h',
  NO_SHOW: 'cancellation.coins_no_show',
};

const TRUST_KEYS: Partial<Record<CancellationBucket, SettingKey>> = {
  H24_TO_H3: 'cancellation.trust_h24_to_h3',
  LT_3H: 'cancellation.trust_lt_3h',
  NO_SHOW: 'cancellation.trust_no_show',
};

export const CANCEL_PENALTY_REASON = 'cancellation.participant_penalty';
export const NO_SHOW_PENALTY_REASON = 'cancellation.no_show_penalty';
export const HOST_PENALTY_REASON = 'cancellation.host_penalty';
export const HOST_REFUND_REASON = 'cancellation.host_refund';

/**
 * The exactly-once keys.
 *
 * One per participant rather than one per participant-and-bucket, because the
 * statuses these price are **terminal**: a request is cancelled once or is a
 * no-show once, never both and never twice. That is also why a penalty capped to
 * nothing may write no ledger row at all — the state transition is the real
 * exactly-once guard here and the key is the second one.
 */
export function participantPenaltyKey(participantId: string): string {
  return `cancel-penalty:${participantId}`;
}
export function participantTrustPenaltyKey(participantId: string): string {
  return `trust-cancel:${participantId}`;
}
export function hostPenaltyKey(eventId: string): string {
  return `host-cancel-penalty:${eventId}`;
}
export function hostTrustPenaltyKey(eventId: string): string {
  return `trust-host-cancel:${eventId}`;
}

/**
 * Which side of §11's thresholds a moment falls on.
 *
 * Pure and exported, so the boundary table can be tested without a database and
 * the API's dry-run answers with the same function that later charges. The
 * comparisons are `>` and `>=` deliberately: 24 hours exactly is the *cheaper*
 * bucket and 3 hours exactly is the cheaper one too, because a threshold that
 * bites at exactly its own name surprises the person standing on it.
 */
export function bucketForLateness(startsAt: Date, now: Date): CancellationBucket {
  const hoursBefore = (startsAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursBefore > 24) return 'GT_24H';
  if (hoursBefore >= 3) return 'H24_TO_H3';
  return 'LT_3H';
}

/**
 * Cancellation pricing, in one place (plan §11, ADR-0011 D9).
 *
 * Every number is read from `app_setting` at the moment of the charge, which is
 * what makes the plan's rollback line true — "set penalties to 0 in
 * `app_setting`, no deploy needed". Nothing here is a constant except which
 * buckets are free, and that is a structural fact rather than a price.
 *
 * **Lock ordering.** Everything here runs inside a transaction that already holds
 * the event row lock, and takes the coin-account lock and then the trust lock
 * beneath it: **event → coin account → trust score**, the order M9's spends
 * established and every path that moves value must follow (ADR-0006).
 */
@Injectable()
export class PenaltyService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    private readonly trust: TrustService,
  ) {}

  /**
   * What a bucket costs right now.
   *
   * Also the dry-run (§6's `?dryRun=true`): the confirmation dialog is only
   * honest if it quotes the same function that will do the charging, rather than
   * a second copy of the table that drifts from it.
   */
  async priceFor(
    bucket: CancellationBucket,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PenaltyPrice> {
    if (FREE_BUCKETS.includes(bucket)) return { coins: 0, trust: 0 };

    const coinKey = COIN_KEYS[bucket];
    const trustKey = TRUST_KEYS[bucket];
    // Unreachable while `CancellationBucket` has five members and two are free,
    // but a sixth added without a price would otherwise charge `NaN`.
    if (!coinKey || !trustKey) return { coins: 0, trust: 0 };

    const [coins, trust] = await Promise.all([
      this.settings.getInt(coinKey, tx),
      this.settings.getInt(trustKey, tx),
    ]);
    return { coins: Math.abs(coins), trust: Math.abs(trust) };
  }

  /**
   * What a *host* pays for cancelling this late.
   *
   * The coin half is the participant's price for the same lateness times a
   * configured multiplier — one host cancellation harms N people rather than one
   * (ADR-0011). The trust half is not derived from the participant table at all:
   * §11 gives the host two numbers split at 24 hours, where a participant has
   * three buckets.
   *
   * Rounded rather than truncated, because ×1.5 on an odd price lands on a half
   * and a floor would quietly make every such penalty cheaper than the multiplier
   * says.
   */
  async hostPriceFor(
    bucket: CancellationBucket,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<PenaltyPrice> {
    const [participant, multiplier, trustGt24h, trustLt24h] = await Promise.all([
      this.priceFor(bucket, tx),
      this.settings.getNumber('cancellation.host_penalty_multiplier', tx),
      this.settings.getInt('cancellation.host_trust_gt24h', tx),
      this.settings.getInt('cancellation.host_trust_lt24h', tx),
    ]);

    return {
      coins: Math.round(participant.coins * multiplier),
      // A host who cancels more than a day out pays no coins — the participant
      // price for GT_24H is zero — but still loses reputation. That asymmetry is
      // §11's, and it is the right one: a cancelled event costs people their
      // Saturday whether or not it was cheap to call off.
      trust: Math.abs(bucket === 'GT_24H' ? trustGt24h : trustLt24h),
    };
  }

  /**
   * Take every coin-account lock this transaction will need, in one fixed order.
   *
   * Host cancellation is the first operation in the product that touches **more
   * than one** coin account — every refunded participant, and then the host. Two
   * such cancellations running at once can otherwise deadlock: if one holds A's
   * account and wants B's while the other holds B's and wants A's, neither can
   * proceed, and the event locks they each hold are for *different* events so
   * nothing serialises them earlier.
   *
   * Sorting by user id gives a total order over accounts, which makes a cycle
   * impossible — the same argument ADR-0006 makes for the event row, applied one
   * level down. Accounts are created first because `FOR UPDATE` locks rows that
   * exist and a user who has never moved a coin has none.
   *
   * Today this is **latent**: D9a means the refund reverses an empty set, so only
   * the host's account is ever really touched. It is here because D9a also says
   * the refund goes live the moment any participant-side cost is introduced, and
   * a deadlock discovered then would be discovered in production.
   */
  async lockAccounts(tx: Prisma.TransactionClient, userIds: readonly string[]): Promise<void> {
    const ordered = [...new Set(userIds)].sort();
    if (ordered.length === 0) return;

    await tx.coinAccount.createMany({
      data: ordered.map((userId) => ({ userId })),
      skipDuplicates: true,
    });

    // One statement per account, in order, rather than one `IN` query: a single
    // statement's lock order is the planner's choice, and the whole point here is
    // that the order is ours.
    for (const userId of ordered) {
      await tx.$queryRaw`SELECT 1 FROM "coin_account" WHERE "user_id" = ${userId} FOR UPDATE`;
    }
  }

  /**
   * Charge a participant for their own cancellation or no-show.
   *
   * Runs inside the caller's transaction, so the penalty and the state change
   * that justifies it commit together — a crash between them would leave either a
   * charge nobody can trace to a cause, or a cancellation that got away free.
   */
  async chargeParticipant(
    tx: Prisma.TransactionClient,
    input: {
      participantId: string;
      userId: string;
      bucket: CancellationBucket;
      eventId: string;
    },
  ): Promise<ChargedPenalty> {
    const price = await this.priceFor(input.bucket, tx);
    const noShow = input.bucket === 'NO_SHOW';

    const penalty = await this.coins.penalize(
      {
        userId: input.userId,
        amount: price.coins,
        type: noShow ? 'NO_SHOW_PENALTY' : 'CANCELLATION_PENALTY',
        reasonCode: noShow ? NO_SHOW_PENALTY_REASON : CANCEL_PENALTY_REASON,
        idempotencyKey: participantPenaltyKey(input.participantId),
        actorType: 'SYSTEM',
        refType: 'event_participant',
        refId: input.participantId,
        metadata: { bucket: input.bucket, eventId: input.eventId },
      },
      tx,
    );

    let trustApplied = 0;
    if (price.trust > 0) {
      const movement = await this.trust.apply(
        {
          userId: input.userId,
          delta: -price.trust,
          type: noShow ? 'NO_SHOW' : 'CANCELLATION',
          reasonCode: noShow ? NO_SHOW_PENALTY_REASON : CANCEL_PENALTY_REASON,
          idempotencyKey: participantTrustPenaltyKey(input.participantId),
          actorType: 'SYSTEM',
          refType: 'event_participant',
          refId: input.participantId,
          metadata: { bucket: input.bucket },
        },
        tx,
      );
      trustApplied = movement.effectiveDelta;
    }

    return {
      bucket: input.bucket,
      price,
      coinsCharged: penalty.charged,
      trustApplied,
      ledgerId: penalty.ledgerId,
    };
  }

  /**
   * Charge the host for cancelling an event people had seats at.
   *
   * `affected` is how many accepted participants there were. **Zero means no
   * penalty at all** — ADR-0011 prices "a host cancelling a published event with
   * accepted participants", and calling off something nobody joined harms nobody.
   * Penalising it would make hosts sit on dead events rather than clear them,
   * which is worse for everyone looking at discovery.
   */
  async chargeHost(
    tx: Prisma.TransactionClient,
    input: { eventId: string; hostUserId: string; bucket: CancellationBucket; affected: number },
  ): Promise<ChargedPenalty> {
    const price =
      input.affected > 0 ? await this.hostPriceFor(input.bucket, tx) : { coins: 0, trust: 0 };

    const penalty = await this.coins.penalize(
      {
        userId: input.hostUserId,
        amount: price.coins,
        type: 'CANCELLATION_PENALTY',
        reasonCode: HOST_PENALTY_REASON,
        idempotencyKey: hostPenaltyKey(input.eventId),
        actorType: 'USER',
        actorId: input.hostUserId,
        refType: 'event',
        refId: input.eventId,
        metadata: { bucket: input.bucket, affected: input.affected },
      },
      tx,
    );

    let trustApplied = 0;
    if (price.trust > 0) {
      const movement = await this.trust.apply(
        {
          userId: input.hostUserId,
          delta: -price.trust,
          type: 'CANCELLATION',
          reasonCode: HOST_PENALTY_REASON,
          idempotencyKey: hostTrustPenaltyKey(input.eventId),
          actorType: 'USER',
          actorId: input.hostUserId,
          refType: 'event',
          refId: input.eventId,
          metadata: { bucket: input.bucket, affected: input.affected },
        },
        tx,
      );
      trustApplied = movement.effectiveDelta;
    }

    return {
      bucket: input.bucket,
      price,
      coinsCharged: penalty.charged,
      trustApplied,
      ledgerId: penalty.ledgerId,
    };
  }

  /**
   * Give a cancelled participant back everything their participation cost them
   * (ADR-0011, D9 and D9a).
   *
   * Written generically — reverse every `coin_ledger` row whose subject is this
   * participant — rather than against a known charge, because **there is no
   * participant-side charge in the MVP**. Joining is free, so today this reverses
   * an empty set and returns zero.
   *
   * That is D9a, and it is stated rather than hidden: the "100% automatic refund"
   * in the policy currently refunds nothing, because nothing was taken. The code
   * becomes live the moment any participant-side cost is introduced, and it is
   * tested with a synthetic charge so it is known to work rather than assumed to.
   *
   * The one thing deliberately *not* reversed is the cancellation penalty itself:
   * `refunded` filters on the ledger types a participant pays to take part, so a
   * later host cancellation cannot hand back a fine somebody earned by cancelling
   * first.
   */
  async refundParticipant(
    tx: Prisma.TransactionClient,
    participantId: string,
    actorUserId: string,
  ): Promise<number> {
    const charges = await tx.coinLedger.findMany({
      where: {
        refType: 'event_participant',
        refId: participantId,
        amount: { lt: 0 },
        type: { notIn: ['CANCELLATION_PENALTY', 'NO_SHOW_PENALTY', 'REVERSAL'] },
        // Postgres treats NULLs as distinct in the UNIQUE on `reverses_ledger_id`,
        // so this is belt-and-braces: `reverse` would refuse a second time anyway.
        reversal: { is: null },
      },
      select: { id: true, amount: true },
    });

    let refunded = 0;
    for (const charge of charges) {
      await this.coins.reverse(
        {
          ledgerId: charge.id,
          reasonCode: HOST_REFUND_REASON,
          actorType: 'USER',
          actorId: actorUserId,
        },
        tx,
      );
      refunded += Math.abs(charge.amount);
    }
    return refunded;
  }
}
