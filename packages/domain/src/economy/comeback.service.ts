import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { OutboxService } from '../outbox/outbox.service';
import { CoinService } from './coin.service';

export const COMEBACK_GRANT_REASON = 'economy.comeback_grant';

/**
 * One grant per account, for its whole life.
 *
 * The key is the user and nothing else — no date, no sequence — so the UNIQUE on
 * `coin_ledger.idempotency_key` *is* the "once in a lifetime" rule. There is no
 * counter to reset and no column to get wrong.
 */
export function comebackGrantKey(userId: string): string {
  return `comeback:${userId}`;
}

export interface ComebackResult {
  /** Accounts granted by this pass. */
  granted: number;
  coins: number;
}

/**
 * The last thing offered to somebody who is about to leave
 * (docs/coin-economy-plan.md §3).
 *
 * ── Who this is for, precisely ──────────────────────────────────────────────
 *
 * Not "anybody who ran out". Three conditions, and each one excludes a different
 * person the grant would be wasted on:
 *
 *  * **Balance below one join.** Somebody who can still afford an activity does
 *    not need it, and giving it to them converts a would-be buyer into a
 *    non-buyer — which is the single most expensive mistake this grant can make.
 *  * **At least `economy.comeback_min_attended_events` attended.** They have used
 *    the product, not merely signed up for it. An account that never attended
 *    anything has told us nothing about whether it would come back.
 *  * **Trust at or above `economy.comeback_min_trust`.** Somebody who no-showed
 *    their way to a low score is being told the product costs coins, correctly.
 *    Refunding the discipline would make every penalty provisional.
 *
 * The person left after those three filters is the one the whole revenue model is
 * about: they went out twice, they behaved, and the next thing they meet is a
 * price. Every honest reading of why they might not pay it comes back to the same
 * thing — the *first* payment is the hardest thing this product ever asks for —
 * and twenty coins is one more evening in which to decide it was worth it.
 *
 * ── Why a nightly sweep rather than a hook on the refusal ───────────────────
 *
 * Granting it at the moment somebody is refused for insufficient coins would tie
 * a reward to a failure, and would teach a very fast lesson: run out, get paid.
 * A sweep that arrives the next morning as an unprompted message is a different
 * thing entirely — it reads as the product noticing, which is what it is.
 *
 * ── What this deliberately is not ───────────────────────────────────────────
 *
 * Not a retention loop and not tunable into one. The lifetime key means the
 * largest possible cost of this feature is
 * `economy.comeback_grant_coins × every account that ever qualifies`, once,
 * which is a number an operator can compute in advance. **Zero switches it off.**
 */
@Injectable()
export class ComebackService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async sweep(limit = 200): Promise<ComebackResult> {
    const policy = await this.settings.getNumbers([
      'economy.comeback_grant_coins',
      'economy.comeback_min_attended_events',
      'economy.comeback_min_trust',
      'economy.event_join_coins',
      'trust.initial_score',
    ]);

    const coins = policy['economy.comeback_grant_coins'];
    if (coins <= 0) return { granted: 0, coins: 0 };

    const candidates = await this.candidates(policy, limit);

    let granted = 0;
    for (const userId of candidates) {
      if (await this.grant(userId, coins)) granted += 1;
    }
    return { granted, coins: granted * coins };
  }

  /**
   * Who qualifies, in one pass.
   *
   * Raw SQL because the shape is three aggregates and a `NOT EXISTS` over a
   * fourth table, and expressing it through the query builder would be four round
   * trips whose intermediate results have to be intersected in Node — over a user
   * table, which is the wrong place to do set arithmetic.
   *
   * The `NOT EXISTS` on the ledger key is what makes the sweep converge: an
   * account granted last night is excluded tonight, forever, so the candidate set
   * shrinks rather than being re-offered every day.
   *
   * `LEFT JOIN` on both the account and the trust score, because either row may
   * be absent and the absence means something specific: an account is created
   * lazily by the first coin movement, so no row is a balance of zero; a trust
   * row is created by the first movement too, so no row is `trust.initial_score`
   * — **not** zero, which would be the worst possible reputation for somebody who
   * has done nothing wrong. `TrustService.scoreOf` makes the same allowance and
   * this has to agree with it, or the panel and the sweep would disagree about
   * who qualifies.
   *
   * Only `ACTIVE` accounts. A suspended or blocked account is not somebody the
   * product is trying to bring back this week.
   */
  private async candidates(policy: Record<string, number>, limit: number): Promise<string[]> {
    const joinCost = policy['economy.event_join_coins'] ?? 0;
    const minAttended = policy['economy.comeback_min_attended_events'] ?? 0;
    const minTrust = policy['economy.comeback_min_trust'] ?? 0;
    const initialTrust = policy['trust.initial_score'] ?? 0;

    // Nothing to be short of: with joining free, "cannot afford an activity" is
    // not a state anybody is in, and every dormant account would qualify at once.
    if (joinCost <= 0) return [];

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT u."id"
      FROM "user" u
      LEFT JOIN "coin_account" a ON a."user_id" = u."id"
      LEFT JOIN "trust_score" t ON t."user_id" = u."id"
      WHERE u."status" = 'ACTIVE'
        AND u."deleted_at" IS NULL
        AND COALESCE(a."balance", 0) < ${joinCost}
        AND COALESCE(t."score", ${initialTrust}) >= ${minTrust}
        AND (
          SELECT COUNT(*) FROM "event_participant" p
          WHERE p."user_id" = u."id" AND p."status" = 'COMPLETED'
        ) >= ${minAttended}
        AND NOT EXISTS (
          SELECT 1 FROM "coin_ledger" l
          WHERE l."idempotency_key" = 'comeback:' || u."id"
        )
      ORDER BY u."created_at" ASC
      LIMIT ${limit}
    `;

    return rows.map((row) => row.id);
  }

  /**
   * Pay one, and tell them.
   *
   * Returns false when a concurrent pass got there first — the key collided and
   * the coins are real but not this call's to report.
   *
   * The three conditions are **not** re-checked inside the transaction, and that
   * is safe in a way worth stating: every one of them can only move in the
   * direction that would have made the grant *more* deserved between the scan and
   * the write, except the balance, which somebody could have topped up. Paying a
   * user who bought coins in the intervening seconds costs twenty coins once in
   * their life. Holding a lock over the user, their account, their participations
   * and the ledger to prevent that would cost more than it saves.
   */
  private async grant(userId: string, coins: number): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const movement = await this.coins.apply(
          {
            userId,
            amount: coins,
            type: 'COMEBACK_GRANT',
            reasonCode: COMEBACK_GRANT_REASON,
            idempotencyKey: comebackGrantKey(userId),
            actorType: 'SYSTEM',
          },
          tx,
        );
        if (!movement.applied) return false;

        await this.audit.record(
          {
            actorType: 'SYSTEM',
            action: 'economy.comeback_granted',
            targetType: 'user',
            targetId: userId,
            after: { coins, balance: movement.balance },
          },
          tx,
        );

        const user = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: { publicId: true },
        });

        await this.outbox.emit(
          {
            aggregateType: 'user',
            aggregateId: userId,
            eventType: 'economy.comeback_granted',
            payload: { userPublicId: user.publicId, coins, balance: movement.balance },
          },
          tx,
        );

        return true;
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
