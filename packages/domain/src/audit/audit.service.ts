import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ActorType, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';

export interface AuditEntry {
  actorType: ActorType;
  /** The actor's `public_id`, never an internal id and never a Telegram id. */
  actorId?: string;
  /** Dotted and past-tense, e.g. `profile.completed`. */
  action: string;
  targetType: string;
  targetId?: string;
  /** Changed fields only — never whole rows, never message bodies (ADR-0009). */
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ipHash?: string;
  requestId?: string;
}

/**
 * Writes the append-only audit trail (invariants 10 and 12).
 *
 * `record` takes a transaction client because an audit row must commit with the
 * change it describes. Writing it afterwards means a crash in between produces a
 * state change nobody can account for — which is the one thing an audit trail
 * exists to prevent.
 *
 * What goes in `before`/`after` is a deliberate allowlist at each call site, not
 * a spread of the entity. `audit_log` is readable by admins, so spreading a user
 * row into it would put a Telegram identifier somewhere invariant 7 says it can
 * never be.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        ...(entry.before !== undefined ? { before: entry.before } : {}),
        ...(entry.after !== undefined ? { after: entry.after } : {}),
        ipHash: entry.ipHash ?? null,
        requestId: entry.requestId ?? null,
        createdAt: this.clock.now(),
      },
    });
  }
}
