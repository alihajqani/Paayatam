import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, METRICS, MetricsRegistry, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { isUniqueViolation } from '../identity/user.service';
import { CoinService } from './coin.service';

/** The stable, machine-readable reason on the ledger row. The client renders the Persian. */
export const GIFT_CODE_REASON = 'giftcode.redeemed';

/** The audit action a successful redemption writes. */
export const GIFT_CODE_SUCCESS_ACTION = 'giftcode.redeemed';

/**
 * The audit action a **refused** redemption writes (M19).
 *
 * Refusals were counted in Prometheus and recorded nowhere else, which was
 * defensible while the only question was "is somebody sweeping right now?" — a
 * counter answers that and a table would be a worse copy of the ledger.
 *
 * It stopped being defensible once the panel had to answer "how did this campaign
 * actually go?". A process counter resets on deploy, is per-replica, and carries
 * no time. So a refusal now writes a durable row as well: the counter stays the
 * alerting surface and `audit_log` becomes the reporting one, which is the same
 * division ADR-0007 makes between a metric and the ledger.
 *
 * **The row never contains the code.** `target_id` is the `gift_code.id` when the
 * code resolved, and null when it did not — a sweep against codes that do not
 * exist is exactly the case where writing what was tried would fill the audit
 * trail with an attacker's guesses.
 */
export const GIFT_CODE_FAILURE_ACTION = 'giftcode.redeem_failed';

/**
 * The exactly-once key for one redemption.
 *
 * Derived from `(code, user, ordinal)` and never from anything the client sent,
 * exactly as `referrerRewardKey` is derived from the referral. A retried request
 * that resolves to the same ordinal collides on `coin_ledger.idempotency_key`; a
 * request that resolves to a *different* ordinal was a genuinely different
 * redemption of a multi-use code, and is meant to pay.
 */
export function giftCodeRedemptionKey(giftCodeId: string, userId: string, seq: number): string {
  return `gift-code:${giftCodeId}:${userId}:${String(seq)}`;
}

export interface RedeemedGiftCode {
  /** The code as stored, so the client echoes back what the server actually matched. */
  code: string;
  /** What this redemption granted. Read from the row, never from the request. */
  coins: number;
  /** The balance after the grant, so the screen never has to guess at it. */
  balance: number;
  /** How many redemptions of this code the caller has left. Zero for a single-use code. */
  remainingForUser: number;
}

/** One row of `gift_code`, as the row lock returns it. */
interface LockedGiftCode {
  id: string;
  code: string;
  coins: number;
  max_redemptions: number | null;
  per_user_limit: number;
  redeemed_count: number;
  starts_at: Date | null;
  expires_at: Date | null;
  is_active: boolean;
}

/**
 * Redeeming a gift or discount code (M18).
 *
 * A campaign code somebody types in exchange for coins, and deliberately **not a
 * second economy**: every coin it grants moves through `CoinService`, so
 * `coin_ledger` stays the single truth and ADR-0007's
 * `balance = SUM(coin_ledger.amount)` reconciliation keeps holding without
 * knowing this file exists.
 *
 * The redemption path is one transaction and three guards, in this order:
 *
 *  1. **`SELECT … FOR UPDATE` on the `gift_code` row**, as the first statement.
 *     Every redeemer of one code serialises there, which is what makes the global
 *     cap a count rather than a race — the same argument ADR-0006 makes for the
 *     event row and capacity.
 *  2. **`UNIQUE (gift_code_id, user_id, seq)`.** The per-user limit, decided by
 *     the database rather than by a read this code performed a moment earlier.
 *  3. **`coin_ledger.idempotency_key`.** The exactly-once guarantee for the coins
 *     themselves, which is what makes a request retried over a dropped connection
 *     credit exactly once.
 *
 * Any one of the three stops the ordinary double-tap. All three are here because
 * they fail in different directions, and the one that turns out to be
 * load-bearing on the day somebody refactors is never the one you expected.
 *
 * **Lock ordering**, which callers must preserve: gift_code → coin_account, never
 * the reverse. That is the second ordered pair in the product after
 * event → coin_account, and consistency is what keeps the system deadlock-free
 * (ADR-0006).
 *
 * **Nothing about the grant comes from the client.** The amount, the window, both
 * limits and the kill switch are columns; the request carries a string.
 */
@Injectable()
export class GiftCodeService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly coins: CoinService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsRegistry,
    /** For `giftcode.enabled`, the platform kill switch read on every redemption. */
    private readonly settings: SettingsService,
  ) {}

  /**
   * Redeem a code.
   *
   * Refuses with four distinct codes rather than one, because the four are things
   * a user can act on differently: retype it, ask for a new one, stop trying, or
   * discover they already have the coins.
   *
   * `GIFT_CODE_INVALID` covers both "no such code" and "disabled", for the reason
   * `INVALID_REFERRAL_CODE` covers both "unknown" and "banned referrer" — telling
   * them apart would turn this endpoint into a way to enumerate which codes exist.
   */
  async redeem(userId: string, rawCode: string): Promise<RedeemedGiftCode> {
    /**
     * The kill switch, before the code is even looked at.
     *
     * First, so that switching the feature off costs an attacker in the middle of
     * a sweep one settings read and nothing else — no index lookup on a code they
     * guessed, no audit row per guess. It also means the refusal cannot depend on
     * whether the string happened to name a real campaign, which is what keeps it
     * from becoming the oracle `GIFT_CODE_INVALID` is careful not to be.
     */
    if ((await this.settings.getInt('giftcode.enabled')) === 0) {
      throw new AppError(ErrorCode.GIFT_CODE_DISABLED);
    }

    const code = exactCode(rawCode);
    const now = this.clock.now();

    /**
     * Resolved outside the transaction so an unknown code costs no lock at all.
     * A brute-force sweep against codes that do not exist is the most likely
     * abusive traffic this endpoint sees, and it must be the cheapest thing it
     * does.
     */
    const found = await this.prisma.giftCode.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!found) {
      // No `target_id`, because there is no target: the code does not exist.
      // Recording *what was tried* here would fill the audit trail with an
      // attacker's guesses and make the trail itself a list of near-miss codes.
      await this.refused(userId, null, 'invalid');
      throw new AppError(ErrorCode.GIFT_CODE_INVALID);
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // The lock, and the first statement. Everything below is serialised per
        // code by it: the window check, the global cap, the per-user count, and
        // the insert that consumes them. Reading `redeemed_count` without it
        // would let ten simultaneous redemptions of the last slot all see one
        // remaining.
        const locked = await tx.$queryRaw<LockedGiftCode[]>`
          SELECT "id", "code", "coins", "max_redemptions", "per_user_limit",
                 "redeemed_count", "starts_at", "expires_at", "is_active"
          FROM "gift_code"
          WHERE "id" = ${found.id}
          FOR UPDATE
        `;
        const giftCode = locked[0];
        if (!giftCode || !giftCode.is_active) throw new AppError(ErrorCode.GIFT_CODE_INVALID);

        // The window, measured against the server clock. No endpoint in this
        // product accepts a client timestamp (invariant 9). `starts_at` in the
        // future and `expires_at` in the past are the same answer to the user —
        // "not now" — and deliberately share a code.
        if (giftCode.starts_at !== null && giftCode.starts_at.getTime() > now.getTime()) {
          throw new AppError(ErrorCode.GIFT_CODE_EXPIRED);
        }
        if (giftCode.expires_at !== null && giftCode.expires_at.getTime() <= now.getTime()) {
          throw new AppError(ErrorCode.GIFT_CODE_EXPIRED);
        }

        if (
          giftCode.max_redemptions !== null &&
          giftCode.redeemed_count >= giftCode.max_redemptions
        ) {
          throw new AppError(ErrorCode.GIFT_CODE_EXHAUSTED);
        }

        const alreadyHad = await tx.giftCodeRedemption.count({
          where: { giftCodeId: giftCode.id, userId },
        });
        if (alreadyHad >= giftCode.per_user_limit) {
          throw new AppError(ErrorCode.GIFT_CODE_ALREADY_REDEEMED);
        }

        const seq = alreadyHad + 1;

        /**
         * The coins first, so the redemption row can point at the ledger row that
         * paid it. `apply` joins this transaction, which is what makes "the
         * balance moved" and "the redemption exists" one fact rather than two —
         * a crash between them would otherwise leave a grant nobody can account
         * for, or a redemption that was never paid.
         */
        const movement = await this.coins.apply(
          {
            userId,
            amount: giftCode.coins,
            type: 'GIFT_CODE_REDEEM',
            reasonCode: GIFT_CODE_REASON,
            idempotencyKey: giftCodeRedemptionKey(giftCode.id, userId, seq),
            actorType: 'USER',
            actorId: userId,
            refType: 'gift_code',
            refId: giftCode.id,
            // `ref_id` already says which code this was, and it says it with an
            // identifier rather than with a bearer secret. `metadata` is read by
            // the panel, exported with the ledger and copied into support
            // threads; a live code in it is a live code in all three (M19).
            metadata: { giftCodeId: giftCode.id, seq },
          },
          tx,
        );

        if (!movement.applied) {
          /**
           * The key was already spent. Under the row lock above this is only
           * reachable if the lock is ever removed by a refactor, and refusing is
           * the honest answer either way: the coins are already in the account,
           * and paying again would be the one outcome this whole file exists to
           * prevent.
           */
          throw new AppError(ErrorCode.GIFT_CODE_ALREADY_REDEEMED);
        }

        try {
          await tx.giftCodeRedemption.create({
            data: {
              giftCodeId: giftCode.id,
              userId,
              seq,
              coins: giftCode.coins,
              coinLedgerId: movement.ledgerId,
              createdAt: now,
            },
          });
        } catch (error) {
          // `UNIQUE (gift_code_id, user_id, seq)` answering — guard 2, which is
          // only reachable without the lock, and is why it is still checked.
          if (isUniqueViolation(error)) throw new AppError(ErrorCode.GIFT_CODE_ALREADY_REDEEMED);
          throw error;
        }

        await tx.giftCode.update({
          where: { id: giftCode.id },
          data: { redeemedCount: { increment: 1 } },
        });

        // Invariant 10's discipline applied to an economic grant: the coins and
        // the trail that explains them commit together.
        await this.audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: GIFT_CODE_SUCCESS_ACTION,
            targetType: 'gift_code',
            targetId: giftCode.id,
            after: { coins: giftCode.coins, seq },
          },
          tx,
        );

        return {
          code: giftCode.code,
          coins: giftCode.coins,
          balance: movement.balance,
          remainingForUser: giftCode.per_user_limit - seq,
        };
      });

      this.metrics.counter(
        METRICS.GIFT_CODE_REDEMPTIONS,
        'Gift code redemption attempts by outcome',
        { result: 'granted' },
      );
      return result;
    } catch (error) {
      // Counted by refusal reason, never by user, **and** recorded durably. The
      // counter is what an alert watches; the row is what the campaign report
      // reads six weeks later, after three deploys have reset the counter.
      if (error instanceof AppError) {
        await this.refused(userId, found.id, reasonLabel(error.code));
      }
      throw error;
    }
  }

  /**
   * One refused attempt: a Prometheus increment and an `audit_log` row.
   *
   * Written **outside** the transaction that failed, and necessarily so — the
   * transaction rolled back, and a row written inside it would have rolled back
   * with the refusal it was recording. That is the one case where an audit row
   * must not commit with the thing it describes, because the thing it describes
   * is the absence of a commit.
   *
   * A failure to record must not turn a refusal into a 500: the user is being
   * told "that code is not valid" either way, and swallowing the write error
   * keeps the answer they get honest. The counter still moved.
   */
  private async refused(userId: string, giftCodeId: string | null, result: string): Promise<void> {
    this.fail(result);
    try {
      await this.audit.record({
        actorType: 'USER',
        actorId: userId,
        action: GIFT_CODE_FAILURE_ACTION,
        targetType: 'gift_code',
        ...(giftCodeId !== null ? { targetId: giftCodeId } : {}),
        after: { reason: result },
      });
    } catch {
      // See above. The refusal is the answer; the record is best-effort.
    }
  }

  private fail(result: string): void {
    this.metrics.counter(
      METRICS.GIFT_CODE_REDEMPTIONS,
      'Gift code redemption attempts by outcome',
      {
        result,
      },
    );
  }
}

/**
 * A gift code, exactly as it was written down.
 *
 * ── What changed, and why ───────────────────────────────────────────────────
 *
 * This used to be `normalizeCode` — upper-case, spaces and dashes stripped —
 * shared with referral codes because both are "typed by hand off another
 * screen". For a referral code that is still right: it is generated from a
 * fixed alphabet, and «abc-123» and «ABC123» are the same nine characters
 * somebody read aloud.
 *
 * A gift code is not that, because an operator may **choose** its text. A
 * campaign code `test1` was redeemed by somebody who typed `test 1`, and the
 * normalizer made the two the same string before anything compared them — so
 * the product credited coins for a code nobody had issued. Every code within
 * one edit of a real one was a live code, which for a bearer secret that is
 * worth money is the whole keyspace collapsing inwards.
 *
 * So the comparison is now exact: case matters, an interior space matters, a
 * dash matters. `UNIQUE (code)` is unchanged and now means what it says.
 *
 * ── The one thing that is still trimmed ─────────────────────────────────────
 *
 * Leading and trailing whitespace, and nothing else. It is invisible, it is
 * produced by pasting rather than by typing, and a refusal caused by a
 * character the user cannot see is a refusal they cannot act on — which is the
 * failure this function exists to prevent, pointed the other way. Interior
 * whitespace is left exactly where the user put it, because that is a character
 * they *can* see and did choose.
 */
export function exactCode(raw: string): string {
  return raw.trim();
}

/** A Prometheus label per refusal, from the error catalogue rather than a second list. */
function reasonLabel(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.GIFT_CODE_INVALID:
      return 'invalid';
    case ErrorCode.GIFT_CODE_EXPIRED:
      return 'expired';
    case ErrorCode.GIFT_CODE_ALREADY_REDEEMED:
      return 'already_redeemed';
    case ErrorCode.GIFT_CODE_EXHAUSTED:
      return 'exhausted';
    case ErrorCode.GIFT_CODE_DISABLED:
      return 'disabled';
    default:
      return 'error';
  }
}
