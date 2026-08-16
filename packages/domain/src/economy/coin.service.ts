import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ActorType, CoinLedgerType, Prisma } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';

export interface CoinMovementInput {
  userId: string;
  /** Signed and non-zero. Positive credits the user, negative debits them. */
  amount: number;
  type: CoinLedgerType;
  /** Stable, machine-readable; the client renders the Persian. */
  reasonCode: string;
  /**
   * The exactly-once key. Derive it from the thing that caused the movement —
   * `onboarding:{userId}`, `cancel-penalty:{participantId}` — never from a
   * timestamp or a random value, or a retry will produce a second row.
   */
  idempotencyKey: string;
  actorType: ActorType;
  actorId?: string;
  refType?: string;
  refId?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface CoinMovement {
  /** False when this key had already been applied — a retry, not a new movement. */
  applied: boolean;
  ledgerId: string;
  /** The balance after this call, whether or not it applied anything. */
  balance: number;
}

/**
 * The only code that may write to `coin_account` or `coin_ledger` (ADR-0007).
 *
 * Two guarantees, both of which are structural rather than procedural:
 *
 *  - **Exactly once.** `coin_ledger.idempotency_key` is UNIQUE. A retried job, a
 *    double-tapped button and two concurrent requests collide on one index.
 *  - **Never negative.** `coin_account.balance` has a CHECK. The service refuses
 *    an overdraft with a useful error first, but the constraint is what holds if
 *    the service is ever wrong.
 *
 * Lock ordering, which callers must preserve: this takes `FOR UPDATE` on the
 * account row and holds no other lock while doing so. A caller that also needs
 * the user row (as profile completion does) takes that one **first**. Consistent
 * ordering is what keeps the system deadlock-free as more modules start moving
 * coins (ADR-0006).
 */
@Injectable()
export class CoinService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async balanceOf(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    const account = await tx.coinAccount.findUnique({
      where: { userId },
      select: { balance: true },
    });
    // No row means no movement has ever happened, which is a zero balance — not
    // an error. Accounts are created lazily by the first movement.
    return account?.balance ?? 0;
  }

  /**
   * Applies a coin movement, or recognises that it already happened.
   *
   * Pass `tx` to join a caller's transaction — the ledger write must commit with
   * whatever state change earned the coins, or a crash between the two leaves a
   * reward that was promised and never paid.
   */
  async apply(input: CoinMovementInput, tx?: Prisma.TransactionClient): Promise<CoinMovement> {
    if (tx) return this.applyWithin(tx, input);
    return this.prisma.$transaction((transaction) => this.applyWithin(transaction, input));
  }

  private async applyWithin(
    tx: Prisma.TransactionClient,
    input: CoinMovementInput,
  ): Promise<CoinMovement> {
    if (!Number.isInteger(input.amount) || input.amount === 0) {
      // Coins are integers (plan §4). A zero movement records nothing and would
      // still consume the idempotency key, so it is a bug, not a no-op.
      throw new AppError(ErrorCode.INTERNAL_ERROR);
    }

    // Create the account before locking it: `FOR UPDATE` locks rows that exist,
    // and a first-ever grant has none. `skipDuplicates` compiles to ON CONFLICT
    // DO NOTHING, so a concurrent creator is harmless.
    await tx.coinAccount.createMany({ data: { userId: input.userId }, skipDuplicates: true });

    // Everything below is serialised per user by this lock. The idempotency
    // check in particular must happen while holding it: read it first and two
    // concurrent grants both see "not yet applied", and the second one only
    // fails when it hits the unique index — aborting its whole transaction, and
    // with it whatever the caller was doing.
    const locked = await tx.$queryRaw<{ balance: number }[]>`
      SELECT "balance" FROM "coin_account" WHERE "user_id" = ${input.userId} FOR UPDATE
    `;
    const balanceBefore = locked[0]?.balance ?? 0;

    const existing = await tx.coinLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return { applied: false, ledgerId: existing.id, balance: balanceBefore };
    }

    const balanceAfter = balanceBefore + input.amount;
    if (balanceAfter < 0) {
      // Reported before the CHECK fires so the user gets "you don't have enough
      // coins" rather than a constraint violation rendered as a 500.
      throw new AppError(ErrorCode.INSUFFICIENT_COINS, {
        balance: balanceBefore,
        required: -input.amount,
      });
    }

    const ledger = await tx.coinLedger.create({
      data: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        amount: input.amount,
        balanceBefore,
        balanceAfter,
        reasonCode: input.reasonCode,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
      select: { id: true },
    });

    await tx.coinAccount.update({
      where: { userId: input.userId },
      data: { balance: balanceAfter, version: { increment: 1 } },
    });

    return { applied: true, ledgerId: ledger.id, balance: balanceAfter };
  }
}
