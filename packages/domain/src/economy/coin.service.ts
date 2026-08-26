import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ActorType, CoinLedgerType, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
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
  /**
   * Set only by `reverse`. The schema requires this and `type = 'REVERSAL'` to
   * agree, so a caller cannot produce a reversal that names nothing or a forward
   * movement that claims to undo something.
   */
  reversesLedgerId?: string;
}

export interface CoinPenalty {
  /** False when nothing was written — a replayed key, or a balance of zero. */
  applied: boolean;
  /** Null when the account had nothing left to take. */
  ledgerId: string | null;
  /** What was actually taken. Never more than the balance. */
  charged: number;
  /** What the policy asked for, which may be more than the account held. */
  requested: number;
  balance: number;
}

/** The exactly-once key for undoing a movement, derived from the movement itself. */
export function reversalKey(ledgerId: string): string {
  return `reversal:${ledgerId}`;
}

export interface CoinMovement {
  /** False when this key had already been applied — a retry, not a new movement. */
  applied: boolean;
  ledgerId: string;
  /** The balance after this call, whether or not it applied anything. */
  balance: number;
}

/**
 * One line of the statement.
 *
 * Deliberately not the whole row: `idempotency_key` names the internal cause,
 * `actor_id` and `ref_id` are internal ids, and `metadata` is whatever a caller
 * put there. None of that belongs in a response, and a projection is what stops a
 * later column arriving in one (§3.6 layer 2).
 */
export interface CoinEntry {
  amount: number;
  balanceAfter: number;
  type: CoinLedgerType;
  reasonCode: string;
  createdAt: Date;
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Accounts whose cached balance no longer equals their ledger (M22 phase 7).
   *
   * ADR-0007's invariant — `balance == SUM(coin_ledger.amount)` — asked of the
   * live database, with **no admin session**: the panel's version of this is
   * `AdminInsightService.reconcile` and is behind `ledger.read` because a person
   * is asking. This one is asked by a nightly sweep so a drift is found by a
   * machine at 4 a.m. rather than by a user disputing a balance in six weeks.
   *
   * Bounded, because the interesting number is "is it zero?" — a drift of two
   * accounts and a drift of two thousand both mean the same thing to whoever gets
   * the alert, and neither wants a list.
   */
  async findDrift(limit = 20): Promise<Array<{ userId: string; balance: number; ledger: number }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string; balance: number; ledger: bigint | null }>
    >`
      SELECT a."user_id", a."balance", COALESCE(SUM(l."amount"), 0) AS ledger
      FROM "coin_account" a
      LEFT JOIN "coin_ledger" l ON l."user_id" = a."user_id"
      GROUP BY a."user_id", a."balance"
      HAVING a."balance" <> COALESCE(SUM(l."amount"), 0)
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      userId: row.user_id,
      balance: row.balance,
      ledger: Number(row.ledger ?? 0n),
    }));
  }

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
   * The statement, newest first.
   *
   * ADR-0007's answer to "where did my coins go?" — the reason a balance is a
   * cache and these rows are the truth. Capped rather than paginated for now: a
   * user with more than two hundred movements is a user M12's admin tooling
   * should be looking at, and keyset pagination here would be a cursor nobody has
   * yet asked for.
   */
  async historyOf(userId: string, limit = 50): Promise<CoinEntry[]> {
    const rows = await this.prisma.coinLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        amount: true,
        balanceAfter: true,
        type: true,
        reasonCode: true,
        createdAt: true,
      },
    });

    return rows;
  }

  /**
   * Applies a coin movement, or recognises that it already happened.
   *
   * Pass `tx` to join a caller's transaction — the ledger write must commit with
   * whatever state change earned the coins, or a crash between the two leaves a
   * reward that was promised and never paid.
   */
  async apply(input: CoinMovementInput, tx?: Prisma.TransactionClient): Promise<CoinMovement> {
    const result = tx
      ? await this.applyWithin(tx, input)
      : await this.prisma.$transaction((transaction) => this.applyWithin(transaction, input));

    // Non-null on every path that reaches here: the only way to get no row is a
    // penalty capped to zero, and penalties do not come through `apply`. Checked
    // rather than asserted, because "impossible" is what this file is for.
    if (result.ledgerId === null) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return { applied: result.applied, ledgerId: result.ledgerId, balance: result.balance };
  }

  /**
   * Undoes a movement by writing its opposite (ADR-0007, rule 4).
   *
   * Nothing is edited and nothing is deleted, so the history stays complete: the
   * original row survives and a `REVERSAL` points at it. Reversing twice is
   * impossible because `reverses_ledger_id` is UNIQUE — Postgres treats NULLs as
   * distinct, so the index reads as "a row can be reversed at most once", and a
   * double-processed refund cannot pay twice.
   *
   * Two refusals worth knowing about:
   *
   *  - **A REVERSAL cannot itself be reversed.** Undoing an undo is a forward
   *    movement with its own reason, not a chain of negations that nobody can
   *    read back. Allowing it would also make "has this been reversed?" a graph
   *    walk rather than a column.
   *  - **Reversing a credit the user has already spent fails**, with
   *    `INSUFFICIENT_COINS`, because taking it back would drive the balance
   *    negative. That is the honest outcome rather than a silent overdraft: the
   *    coins are gone, and an admin adjustment — which is a decision somebody
   *    signs their name to — is the way to settle it.
   */
  async reverse(
    input: {
      ledgerId: string;
      reasonCode: string;
      actorType: ActorType;
      actorId?: string;
      metadata?: Prisma.InputJsonValue;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<CoinMovement> {
    if (tx) return this.reverseWithin(tx, input);
    return this.prisma.$transaction((transaction) => this.reverseWithin(transaction, input));
  }

  private async reverseWithin(
    tx: Prisma.TransactionClient,
    input: {
      ledgerId: string;
      reasonCode: string;
      actorType: ActorType;
      actorId?: string;
      metadata?: Prisma.InputJsonValue;
    },
  ): Promise<CoinMovement> {
    const original = await tx.coinLedger.findUnique({
      where: { id: input.ledgerId },
      select: { id: true, userId: true, amount: true, type: true, refType: true, refId: true },
    });
    if (!original) throw new AppError(ErrorCode.NOT_FOUND);
    if (original.type === 'REVERSAL') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    return this.apply(
      {
        userId: original.userId,
        amount: -original.amount,
        type: 'REVERSAL',
        reasonCode: input.reasonCode,
        // Derived from what is being reversed, so a retried reversal collides on
        // the same key. The UNIQUE on `reverses_ledger_id` is the second guard,
        // and either one alone would be enough.
        idempotencyKey: reversalKey(original.id),
        actorType: input.actorType,
        ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
        // The reversal points at the same subject as the row it undoes, so a
        // ledger filtered by ref shows the charge and its refund together.
        ...(original.refType !== null ? { refType: original.refType } : {}),
        ...(original.refId !== null ? { refId: original.refId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        reversesLedgerId: original.id,
      },
      tx,
    );
  }

  /**
   * Takes coins as a penalty, capped by what the account actually holds (M10).
   *
   * The difference from `apply` is the whole point and it is a policy decision,
   * not a convenience. A *spend* must fail when the user cannot afford it — that
   * is what `INSUFFICIENT_COINS` is for, and buying a boost with money you do not
   * have is not a thing that should happen. A *penalty* must not, because the
   * alternatives are both worse: refusing it would let somebody escape a
   * cancellation charge by spending down to nothing first, and letting the
   * balance go negative is forbidden by the CHECK and would turn every future
   * reward into silent debt repayment the user was never told about.
   *
   * So it takes what is there and records what it wanted in `metadata`, the same
   * way `TrustService` records a delta the bounds clipped. The shortfall is
   * visible rather than forgiven-in-silence, and M12's admin tooling can see it.
   *
   * **A penalty that clamps to zero writes no row at all**, because
   * `coin_ledger.amount` may not be zero — unlike `trust_score_ledger.delta`,
   * which may. That would normally be a bug, because the row is what consumes the
   * idempotency key. It is safe here only because a penalty is charged inside the
   * transaction that makes a **terminal** state transition, and
   * `assertParticipantTransition` is what makes that happen once. The key is the
   * second guard, not the first.
   */
  async penalize(
    input: Omit<CoinMovementInput, 'amount'> & { amount: number },
    tx?: Prisma.TransactionClient,
  ): Promise<CoinPenalty> {
    if (tx) return this.penalizeWithin(tx, input);
    return this.prisma.$transaction((transaction) => this.penalizeWithin(transaction, input));
  }

  private async penalizeWithin(
    tx: Prisma.TransactionClient,
    input: CoinMovementInput,
  ): Promise<CoinPenalty> {
    const requested = Math.abs(input.amount);
    if (!Number.isInteger(requested)) throw new AppError(ErrorCode.INTERNAL_ERROR);

    if (requested === 0) {
      // A free bucket — GRACE, or anything beyond 24 hours. Nothing to write and
      // nothing to explain; the cancellation itself is the record.
      return {
        applied: false,
        ledgerId: null,
        charged: 0,
        requested: 0,
        balance: await this.balanceOf(input.userId, tx),
      };
    }

    return this.applyWithin(tx, { ...input, amount: -requested }, requested);
  }

  private async applyWithin(
    tx: Prisma.TransactionClient,
    input: CoinMovementInput,
    /** Set only by `penalize`: the magnitude the policy asked for, before capping. */
    penaltyRequested?: number,
  ): Promise<CoinPenalty> {
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
      select: { id: true, amount: true },
    });
    if (existing) {
      return {
        applied: false,
        ledgerId: existing.id,
        balance: balanceBefore,
        charged: Math.abs(existing.amount),
        requested: penaltyRequested ?? Math.abs(existing.amount),
      };
    }

    // A penalty takes what is there; a spend does not get to overdraw. See
    // `penalize` for why the two must differ.
    const amount =
      penaltyRequested !== undefined ? Math.max(input.amount, -balanceBefore) : input.amount;

    const balanceAfter = balanceBefore + amount;
    if (balanceAfter < 0) {
      // Reported before the CHECK fires so the user gets "you don't have enough
      // coins" rather than a constraint violation rendered as a 500.
      throw new AppError(ErrorCode.INSUFFICIENT_COINS, {
        balance: balanceBefore,
        required: -amount,
      });
    }

    if (amount === 0) {
      // Only reachable from `penalize`, against an account already at zero.
      // `coin_ledger.amount` may not be zero, so there is no row to write —
      // safe here for the reason `penalize` gives, and nowhere else.
      return {
        applied: false,
        ledgerId: null,
        balance: balanceBefore,
        charged: 0,
        requested: penaltyRequested ?? 0,
      };
    }

    // What the policy asked for, kept only when the balance ate some of it —
    // the same discipline `TrustService` uses for a clamped delta, and the
    // reason a shortfall is visible rather than silently forgiven.
    const clamped = penaltyRequested !== undefined && -amount !== penaltyRequested;
    const metadata = clamped
      ? { ...asRecord(input.metadata), requestedAmount: penaltyRequested }
      : input.metadata;

    const ledger = await tx.coinLedger.create({
      data: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        amount,
        balanceBefore,
        balanceAfter,
        reasonCode: input.reasonCode,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        reversesLedgerId: input.reversesLedgerId ?? null,
        // From the injected clock rather than the column default, so every
        // window a policy or a retention job measures over this ledger agrees
        // with the clock the rest of the domain reads (ADR-0008).
        createdAt: this.clock.now(),
        ...(metadata !== undefined ? { metadata } : {}),
      },
      select: { id: true },
    });

    await tx.coinAccount.update({
      where: { userId: input.userId },
      data: { balance: balanceAfter, version: { increment: 1 } },
    });

    return {
      applied: true,
      ledgerId: ledger.id,
      balance: balanceAfter,
      charged: Math.abs(amount),
      requested: penaltyRequested ?? Math.abs(amount),
    };
  }
}

/** A caller's metadata as something spreadable, or nothing. */
function asRecord(value: Prisma.InputJsonValue | undefined): Record<string, Prisma.InputJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value === undefined ? {} : { value };
  }
  return value as Record<string, Prisma.InputJsonValue>;
}
