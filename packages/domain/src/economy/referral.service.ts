import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma, ReferralStatus } from '@payetam/db';
import { CLOCK, METRICS, MetricsRegistry, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../catalog/settings.service';
import { isUniqueViolation } from '../identity/user.service';
import { CoinService } from './coin.service';

/**
 * The alphabet a code is drawn from.
 *
 * No `0/O`, no `1/I/L`: a referral code is read off one screen and typed into
 * another, often by somebody who did not choose it. Thirty-one characters over
 * eight positions is about 8.5 × 10¹¹ codes, so collisions are rare enough that
 * the retry loop below almost never runs and common enough that it must exist.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_ATTEMPTS = 5;

export const REFERRAL_REFERRER_REASON = 'referral.referrer_reward';
export const REFERRAL_REFERRED_REASON = 'referral.referred_reward';

/** The exactly-once keys for the two halves of one referral's payout. */
export function referrerRewardKey(referralId: string): string {
  return `referral-referrer:${referralId}`;
}
export function referredRewardKey(referralId: string): string {
  return `referral-referred:${referralId}`;
}

export interface ReferralSummary {
  /** The caller's own code, generated on first read. */
  code: string;
  /** How many people have claimed it. */
  invited: number;
  /** How many of those have attended an event and paid out. */
  qualified: number;
  /** Coins this user has earned from referrals, referrer and referred alike. */
  coinsEarned: number;
  /**
   * Set when the caller was themselves referred.
   *
   * `status` from M19: `REJECTED` became reachable, and a screen that only knew
   * "qualified or not" would render a refused referral as "still waiting" —
   * forever, and untruthfully. `qualified` is kept beside it because it is what
   * every existing caller reads and it means exactly what it always did.
   *
   * **No reason code here.** Why a referral was refused is on the admin surface;
   * naming the signal that fired to the person it fired on is telling a farmer
   * what to change (T6).
   */
  referredBy: { status: ReferralStatus; qualified: boolean } | null;
}

export interface ReferralClaim {
  status: 'PENDING' | 'QUALIFIED';
  /** What the caller will receive once they attend an event. */
  pendingCoins: number;
}

/**
 * Who invited whom, and when that becomes worth something (T6).
 *
 * The single design decision that matters here is **when the reward is paid**.
 * Paying on signup is the obvious implementation and is exactly what a farm
 * wants: accounts are free, so a reward for creating one is a reward for
 * creating them in bulk. Plan §11 pays after the referred user **attends an
 * event**, which costs a farmer a real person in a real café, and no amount of
 * automation makes that cheap.
 *
 * Everything else is the database doing the work:
 *
 *  - `referral.referred_user_id` is UNIQUE, so a user has one referrer for life.
 *    The claim path inserts and lets the index decide rather than reading first,
 *    because a read-then-write has a window and this has none.
 *  - `CHECK (referrer <> referred)` makes self-referral impossible even if the
 *    service check is removed by a future refactor.
 *  - Both payouts carry idempotency keys derived from the referral, so a
 *    redelivered qualification pays once.
 *
 * Velocity is **recorded, not enforced**. T6 asks for both velocity limits and
 * `fraud_signals` for admin review, and the order matters: a wrong automatic
 * rejection silently steals a real user's reward, and nobody ever finds out. The
 * signals go in front of a human; the hard limits are M15's rate limiting.
 */
@Injectable()
export class ReferralService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    private readonly audit: AuditService,
    /**
     * Counted by outcome (M18).
     *
     * The audit trail already records every claim that *succeeded* — that is what
     * `referral.claimed` and `referral.qualified` are for. What it cannot show is
     * the refusals: a burst of `invalid` against codes that do not exist leaves no
     * row anywhere, and is the only externally visible sign of somebody guessing
     * at other people's invite codes.
     */
    private readonly metrics: MetricsRegistry,
  ) {}

  /** The caller's code and what it has earned them. */
  async summaryFor(userId: string): Promise<ReferralSummary> {
    const code = await this.codeFor(userId);

    const [invited, qualified, earned, received] = await Promise.all([
      this.prisma.referral.count({ where: { referrerUserId: userId } }),
      this.prisma.referral.count({ where: { referrerUserId: userId, status: 'QUALIFIED' } }),
      this.prisma.coinLedger.aggregate({
        where: { userId, type: 'REFERRAL_REWARD' },
        _sum: { amount: true },
      }),
      this.prisma.referral.findUnique({
        where: { referredUserId: userId },
        select: { status: true },
      }),
    ]);

    return {
      code,
      invited,
      qualified,
      coinsEarned: earned._sum.amount ?? 0,
      referredBy: received
        ? { status: received.status, qualified: received.status === 'QUALIFIED' }
        : null,
    };
  }

  /**
   * "Somebody invited me."
   *
   * Records the relationship and pays nothing yet. If the caller has already
   * attended an event by the time they claim — an unusual order, but a real one
   * for somebody who joins first and finds the invite link later — the reward
   * settles immediately rather than waiting for an attendance that already
   * happened.
   */
  async claim(userId: string, rawCode: string): Promise<ReferralClaim> {
    const now = this.clock.now();
    const code = normalizeCode(rawCode);

    const referrer = await this.prisma.user.findUnique({
      where: { referralCode: code },
      select: { id: true, status: true },
    });
    // Same error for "no such code" and "that account is banned": neither is
    // something the caller can act on differently, and distinguishing them turns
    // this endpoint into an oracle for which codes exist.
    if (!referrer || referrer.status === 'BANNED') {
      this.claimed('invalid');
      throw new AppError(ErrorCode.INVALID_REFERRAL_CODE);
    }
    if (referrer.id === userId) {
      this.claimed('self');
      throw new AppError(ErrorCode.SELF_REFERRAL);
    }

    const fraudSignals = await this.velocitySignals(referrer.id, now);

    let referralId: string;
    try {
      const created = await this.prisma.referral.create({
        data: {
          referrerUserId: referrer.id,
          referredUserId: userId,
          code,
          status: 'PENDING',
          createdAt: now,
          ...(fraudSignals !== null ? { fraudSignals } : {}),
        },
        select: { id: true },
      });
      referralId = created.id;
    } catch (error) {
      // The UNIQUE on `referred_user_id` answering, which is the whole guard:
      // one referrer per person, decided by the database rather than by a read
      // this code performed a moment earlier.
      if (isUniqueViolation(error)) {
        this.claimed('already_referred');
        throw new AppError(ErrorCode.ALREADY_REFERRED);
      }
      throw error;
    }

    this.claimed('accepted');

    await this.audit.record({
      actorType: 'USER',
      actorId: userId,
      action: 'referral.claimed',
      targetType: 'referral',
      targetId: referralId,
      after: { status: 'PENDING', flagged: fraudSignals !== null },
    });

    // Claiming after already attending settles now rather than never: the
    // condition is "has attended", not "attends next".
    const settled = await this.qualifyForAttendance(userId);
    if (settled) return { status: 'QUALIFIED', pendingCoins: 0 };

    return {
      status: 'PENDING',
      pendingCoins: await this.settings.getInt('economy.referral_referred_coins'),
    };
  }

  /**
   * Pay out, if the referred user has now attended something.
   *
   * The attendance condition is checked *here* rather than trusted from the
   * caller, which is what makes "a referral requires attendance" a property of
   * this service instead of a rule the caller has to remember. Whoever settles
   * attendance calls this; it decides for itself whether the condition holds.
   *
   * Both halves are paid in one transaction, so a crash cannot reward the
   * referrer and lose the referred user's share.
   *
   * Returns whether this call is what qualified it.
   */
  async qualifyForAttendance(userId: string): Promise<boolean> {
    const now = this.clock.now();

    const referral = await this.prisma.referral.findUnique({
      where: { referredUserId: userId },
      select: { id: true, referrerUserId: true, status: true },
    });
    if (!referral || referral.status !== 'PENDING') return false;

    const attended = await this.prisma.eventParticipant.findFirst({
      where: { userId, status: 'COMPLETED' },
      select: { id: true },
    });
    if (!attended) return false;

    const [referrerCoins, referredCoins] = await Promise.all([
      this.settings.getInt('economy.referral_referrer_coins'),
      this.settings.getInt('economy.referral_referred_coins'),
    ]);

    return this.prisma.$transaction(async (tx) => {
      // Re-read under the transaction: two attendance settlements landing at once
      // must not both decide they are the one that qualified it.
      const current = await tx.referral.findUnique({
        where: { id: referral.id },
        select: { status: true },
      });
      if (current?.status !== 'PENDING') return false;

      const referrerReward = await this.coins.apply(
        {
          userId: referral.referrerUserId,
          amount: referrerCoins,
          type: 'REFERRAL_REWARD',
          reasonCode: REFERRAL_REFERRER_REASON,
          idempotencyKey: referrerRewardKey(referral.id),
          actorType: 'SYSTEM',
          refType: 'referral',
          refId: referral.id,
        },
        tx,
      );

      /**
       * **This is what decides who qualified it**, not the status read above.
       *
       * Ten attendance settlements landing together all read PENDING under READ
       * COMMITTED, because none of them has committed yet — so the read is an
       * early exit, never the guard. The coin movement is the guard: it takes
       * `FOR UPDATE` on the referrer's account and checks its idempotency key
       * while holding it, so exactly one caller is told `applied`. The others
       * return false and announce nothing, which matters because "did I qualify
       * this?" becomes a notification in M13.
       */
      if (!referrerReward.applied) return false;

      await this.coins.apply(
        {
          userId,
          amount: referredCoins,
          type: 'REFERRAL_REWARD',
          reasonCode: REFERRAL_REFERRED_REASON,
          idempotencyKey: referredRewardKey(referral.id),
          actorType: 'SYSTEM',
          refType: 'referral',
          refId: referral.id,
        },
        tx,
      );

      await tx.referral.update({
        where: { id: referral.id },
        data: {
          status: 'QUALIFIED',
          qualifiedAt: now,
          rewardLedgerId: referrerReward.ledgerId,
        },
      });

      await this.audit.record(
        {
          actorType: 'SYSTEM',
          action: 'referral.qualified',
          targetType: 'referral',
          targetId: referral.id,
          before: { status: 'PENDING' },
          after: { status: 'QUALIFIED', referrerCoins, referredCoins },
        },
        tx,
      );

      return true;
    });
  }

  /**
   * The caller's code, generated on first read.
   *
   * Lazy rather than at signup, so the users who never open the invite screen
   * cost nothing and the column stays sparse. The retry loop exists for the
   * collision that will almost never happen: `randomInt` is uniform and the
   * space is large, but "almost never" over enough users is a support ticket
   * nobody can reproduce.
   */
  private async codeFor(userId: string): Promise<string> {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (existing?.referralCode) return existing.referralCode;

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const code = generateCode();
      try {
        await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
        return code;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    throw new AppError(ErrorCode.INTERNAL_ERROR);
  }

  /** One label per outcome. Never a user id — a counter is scraped by anything. */
  private claimed(result: string): void {
    this.metrics.counter(METRICS.REFERRAL_CLAIMS, 'Referral claim attempts by outcome', { result });
  }

  /**
   * How many people this referrer has recruited lately.
   *
   * Returned as a signal, never as a refusal — see the note on the class. Null
   * when there is nothing worth telling an admin, so `fraud_signals` stays empty
   * for the overwhelming majority of referrals and a non-null value actually
   * means something when somebody goes looking.
   */
  private async velocitySignals(
    referrerUserId: string,
    now: Date,
  ): Promise<Prisma.InputJsonValue | null> {
    const [windowHours, threshold] = await Promise.all([
      this.settings.getInt('referral.velocity_window_hours'),
      this.settings.getInt('referral.velocity_threshold'),
    ]);

    const since = new Date(now.getTime() - windowHours * 3_600_000);
    const recent = await this.prisma.referral.count({
      where: { referrerUserId, createdAt: { gte: since } },
    });

    if (recent < threshold) return null;
    return { reason: 'velocity', recentReferrals: recent, windowHours, threshold };
  }
}

/** Case- and separator-insensitive: people retype these by hand. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replaceAll(/[\s-]/g, '');
}

/**
 * `length` characters drawn uniformly from `CODE_ALPHABET`.
 *
 * Exported because gift codes need exactly this, for exactly the same reasons
 * (M19): a code is read off one screen and typed into another, and a guessable
 * one is worth money. A second generator would be a second alphabet to keep
 * `0/O` and `1/I/L` out of, and the two copies would drift.
 *
 * `randomInt` rather than `Math.random`, which is not a CSPRNG and is seeded per
 * process — two workers starting together would produce the same codes.
 */
export function generateCode(length: number = CODE_LENGTH): string {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}
