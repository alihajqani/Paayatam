import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ActorType, Prisma, TrustLedgerType } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { SettingsService } from '../catalog/settings.service';

/**
 * The bounds, matching the CHECK on `trust_score` (ADR-0007).
 *
 * Constants rather than settings on purpose. The *starting* score is policy and
 * lives in `app_setting`; the range is structural — the database enforces it, so
 * a configurable clamp over a fixed constraint would be a setting whose only
 * possible effect is a constraint violation.
 */
export const TRUST_MIN_SCORE = 0;
export const TRUST_MAX_SCORE = 100;

/**
 * Which version of the rules produced a row.
 *
 * Stamped on every entry so a future change to the algorithm is visible in the
 * history rather than retroactive: "this −5 was applied under v1" survives the
 * day v2 decides that case is worth −3.
 */
export const TRUST_ALGO_VERSION = 1;

export const TRUST_INITIAL_REASON = 'trust.initial';
export const TRUST_PROFILE_COMPLETE_REASON = 'trust.profile_completed';

/** The seed row's key, so the starting score is granted at most once per user. */
export function trustInitialKey(userId: string): string {
  return `trust-initial:${userId}`;
}

export interface TrustMovementInput {
  userId: string;
  /** Signed and non-zero: what the *policy* asks for, before clamping. */
  delta: number;
  type: TrustLedgerType;
  /** Stable and machine-readable; the client renders the Persian. */
  reasonCode: string;
  /**
   * The exactly-once key, derived from the thing that caused the movement —
   * `trust-review:{reviewId}`, `trust-noshow:{participantId}`. Never a timestamp
   * and never random, or a retry produces a second row.
   */
  idempotencyKey: string;
  actorType: ActorType;
  actorId?: string;
  refType?: string;
  refId?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface TrustMovement {
  /** False when this key had already been applied — a retry, not a new movement. */
  applied: boolean;
  ledgerId: string;
  /** The score after this call, whether or not it applied anything. */
  score: number;
  /** What actually moved, after clamping. Zero when the score was already at a bound. */
  effectiveDelta: number;
}

export interface TrustEntry {
  delta: number;
  scoreBefore: number;
  scoreAfter: number;
  reasonCode: string;
  type: TrustLedgerType;
  algoVersion: number;
  /** Present when the policy asked for more than the bounds allowed. */
  requestedDelta: number | null;
  createdAt: Date;
}

/**
 * The only code that may write to `trust_score` or `trust_score_ledger`
 * (ADR-0007), and the mirror of `CoinService` in every structural respect:
 * exactly-once by unique index, append-only by trigger, account and ledger moved
 * together inside one transaction under one lock.
 *
 * The one place it deliberately differs from coins is **clamping**, and the
 * difference is worth stating because it decides what the ledger means:
 *
 *  - `delta` stores what actually moved, not what was asked for. A rule worth +3
 *    against somebody at 99 stores +1 and records the 3 in `metadata`. Storing
 *    the requested value instead would break `score = SUM(delta)` the first time
 *    anybody reached a bound — and that sum is the property ADR-0007's
 *    reconciliation test exists to check.
 *  - A movement clamped to *nothing* still writes a row, where a zero coin
 *    movement is rejected as a bug. The row is what consumes the idempotency key:
 *    without it, a redelivered job would find the key unused and pay out for real
 *    the moment the score dropped enough to have room. It also happens to be the
 *    honest answer to "why didn't my score go up?".
 *
 * The starting score is itself a ledger row (`INITIAL`), written lazily on the
 * first movement. That is what makes `score = SUM(delta)` true from the first
 * entry rather than from the second, with no "plus fifty" fudge factor anywhere
 * in the reconciliation.
 */
@Injectable()
export class TrustService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The current score.
   *
   * A user with no row has never moved and reads as the configured starting
   * score — not zero, which would be the worst possible reputation for somebody
   * who has done nothing wrong.
   */
  async scoreOf(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    const row = await tx.trustScore.findUnique({ where: { userId }, select: { score: true } });
    return row?.score ?? (await this.settings.getInt('trust.initial_score'));
  }

  /**
   * The explanation, newest first.
   *
   * This is what ADR-0007 means by "the admin panel renders the ledger, not the
   * number", and it is equally what the user's own `GET /me/trust` shows. A score
   * nobody can account for is a score nobody can appeal.
   */
  async historyOf(userId: string, limit = 50): Promise<TrustEntry[]> {
    const rows = await this.prisma.trustScoreLedger.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    return rows.map((row) => ({
      delta: row.delta,
      scoreBefore: row.scoreBefore,
      scoreAfter: row.scoreAfter,
      reasonCode: row.reasonCode,
      type: row.type,
      algoVersion: row.algoVersion,
      requestedDelta: requestedDeltaOf(row.metadata),
      createdAt: row.createdAt,
    }));
  }

  /**
   * Applies a movement, or recognises that it already happened.
   *
   * Pass `tx` to join a caller's transaction — the ledger write must commit with
   * whatever state change earned or cost the reputation, or a crash between the
   * two leaves a penalty nobody can trace to a cause.
   */
  async apply(input: TrustMovementInput, tx?: Prisma.TransactionClient): Promise<TrustMovement> {
    if (tx) return this.applyWithin(tx, input);
    return this.prisma.$transaction((transaction) => this.applyWithin(transaction, input));
  }

  private async applyWithin(
    tx: Prisma.TransactionClient,
    input: TrustMovementInput,
  ): Promise<TrustMovement> {
    if (!Number.isInteger(input.delta) || input.delta === 0) {
      // A caller asking for zero is a bug: it would consume an idempotency key
      // and record a movement that no rule intended. Distinct from a movement
      // that *clamps* to zero, which is a real event and is recorded.
      throw new AppError(ErrorCode.INTERNAL_ERROR);
    }

    // Created before locking: `FOR UPDATE` locks rows that exist, and a
    // first-ever movement has none. Starts at zero because the starting score
    // arrives as a ledger row immediately below — seeding the column directly
    // would put fifty points into the score that no entry accounts for.
    await tx.trustScore.createMany({
      data: { userId: input.userId, score: 0, algoVersion: TRUST_ALGO_VERSION },
      skipDuplicates: true,
    });

    // Everything below is serialised per user by this lock. The idempotency
    // check in particular must happen while holding it: read it first and two
    // concurrent movements both see "not yet applied", and the second only fails
    // at the unique index — aborting its whole transaction, and with it whatever
    // the caller was doing.
    const locked = await tx.$queryRaw<{ score: number }[]>`
      SELECT "score" FROM "trust_score" WHERE "user_id" = ${input.userId} FOR UPDATE
    `;
    let score = locked[0]?.score ?? 0;

    score = await this.seedIfNeeded(tx, input.userId, score);

    const existing = await tx.trustScoreLedger.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: { id: true, delta: true },
    });
    if (existing) {
      return { applied: false, ledgerId: existing.id, score, effectiveDelta: existing.delta };
    }

    const written = await this.writeRow(tx, {
      userId: input.userId,
      requestedDelta: input.delta,
      scoreBefore: score,
      type: input.type,
      reasonCode: input.reasonCode,
      idempotencyKey: input.idempotencyKey,
      actorType: input.actorType,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
      ...(input.refType !== undefined ? { refType: input.refType } : {}),
      ...(input.refId !== undefined ? { refId: input.refId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    });

    return {
      applied: true,
      ledgerId: written.id,
      score: written.scoreAfter,
      effectiveDelta: written.delta,
    };
  }

  /**
   * Grants the starting score, as a ledger row like everything else.
   *
   * Lazy rather than at signup so a user who never does anything costs no rows,
   * and keyed so it happens at most once. `score = SUM(delta)` holds from here on
   * with nothing added on the side.
   */
  private async seedIfNeeded(
    tx: Prisma.TransactionClient,
    userId: string,
    score: number,
  ): Promise<number> {
    // On `tx`, not the base client: this runs inside the caller's transaction,
    // and borrowing a second pool connection while holding the first is how N
    // concurrent movements deadlock the pool.
    const initial = await this.settings.getInt('trust.initial_score', tx);
    if (initial === 0) return score;

    const key = trustInitialKey(userId);
    const seeded = await tx.trustScoreLedger.findUnique({
      where: { idempotencyKey: key },
      select: { id: true },
    });
    if (seeded) return score;

    const written = await this.writeRow(tx, {
      userId,
      requestedDelta: initial,
      scoreBefore: score,
      type: 'INITIAL',
      reasonCode: TRUST_INITIAL_REASON,
      idempotencyKey: key,
      actorType: 'SYSTEM',
    });
    return written.scoreAfter;
  }

  /** The single place a row is written and the cache is moved with it. */
  private async writeRow(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      requestedDelta: number;
      scoreBefore: number;
      type: TrustLedgerType;
      reasonCode: string;
      idempotencyKey: string;
      actorType: ActorType;
      actorId?: string;
      refType?: string;
      refId?: string;
      metadata?: Prisma.InputJsonValue;
      reversesLedgerId?: string;
    },
  ): Promise<{ id: string; delta: number; scoreAfter: number }> {
    const scoreAfter = clampScore(input.scoreBefore + input.requestedDelta);
    const delta = scoreAfter - input.scoreBefore;
    const metadata = mergeMetadata(
      input.metadata,
      delta === input.requestedDelta ? null : { requestedDelta: input.requestedDelta },
    );

    const ledger = await tx.trustScoreLedger.create({
      data: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        delta,
        scoreBefore: input.scoreBefore,
        scoreAfter,
        reasonCode: input.reasonCode,
        algoVersion: TRUST_ALGO_VERSION,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        reversesLedgerId: input.reversesLedgerId ?? null,
        // From the injected clock, not the column default (ADR-0008).
        // `trust.attendance_daily_cap` filters these rows against a window
        // derived from `Clock`, and leaving the column to the database's `now()`
        // would mean the filter and the rows it filters come from two different
        // sources of time — the same divergence M4 had to fix on `event`.
        createdAt: this.clock.now(),
        // What the policy asked for, kept only when the bounds ate some of it.
        // This is what turns "your score did not move" into an explanation.
        //
        // Spread rather than assigned, because `exactOptionalPropertyTypes`
        // distinguishes an absent key from one holding `undefined`, and Prisma's
        // nullable-JSON input accepts the first and refuses the second.
        ...(metadata !== undefined ? { metadata } : {}),
      },
      select: { id: true },
    });

    await tx.trustScore.update({
      where: { userId: input.userId },
      data: { score: scoreAfter, algoVersion: TRUST_ALGO_VERSION },
    });

    return { id: ledger.id, delta, scoreAfter };
  }
}

/** Bounded to the range the CHECK constraint enforces. */
export function clampScore(score: number): number {
  return Math.min(TRUST_MAX_SCORE, Math.max(TRUST_MIN_SCORE, score));
}

function mergeMetadata(
  caller: Prisma.InputJsonValue | undefined,
  clamp: { requestedDelta: number } | null,
): Prisma.InputJsonValue | undefined {
  if (clamp === null) return caller;
  if (caller === undefined) return clamp;
  if (typeof caller === 'object' && caller !== null && !Array.isArray(caller)) {
    return { ...(caller as Record<string, Prisma.InputJsonValue>), ...clamp };
  }
  // A caller who passed a scalar or an array keeps it, under a key, rather than
  // losing it to a spread that was never going to work.
  return { value: caller, ...clamp };
}

function requestedDeltaOf(metadata: unknown): number | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)['requestedDelta'];
  return typeof value === 'number' ? value : null;
}
