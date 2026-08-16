import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';

export interface DomainEvent {
  /** What it happened to: `event_participant`, `event`, `user`. */
  aggregateType: string;
  aggregateId: string;
  /** Dotted and past-tense, e.g. `waitlist.promoted`. */
  eventType: string;
  /** Allowlisted facts, never a spread of the row. */
  payload: Prisma.InputJsonValue;
}

/**
 * Writes the transactional outbox (ADR-0005).
 *
 * `emit` takes a transaction client for the same reason `AuditService.record`
 * does, and it is the entire point of the pattern: the event must commit with the
 * state change that caused it. Written afterwards, a crash in between announces
 * something that did not happen — or, worse, fails to announce something that
 * did, which for a waitlist promotion means a user whose status changed and who
 * is never told.
 *
 * The relay that drains these rows is M13. What this class guarantees is the half
 * that cannot be added later: that the row is there, exactly when the change is.
 *
 * On payloads — they are an allowlist at each call site, never an entity spread.
 * These are consumed by the notification layer and rendered into text a user
 * reads, so anything that reaches a payload can reach a message body. A Telegram
 * identifier must not be able to travel that path (ADR-0009, invariant 7).
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async emit(event: DomainEvent, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: this.clock.now(),
      },
    });
  }
}
