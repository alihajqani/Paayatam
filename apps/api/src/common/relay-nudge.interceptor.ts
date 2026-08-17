import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { JOBS, QUEUES, QueueService, jobId } from '@payetam/platform';
import type { FastifyRequest } from 'fastify';
import { Observable, tap } from 'rxjs';

/** Only the methods that can have written an outbox row. */
const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * The event-driven half of the outbox relay (ADR-0005).
 *
 * **The bug this closes.** `QUEUES.DOMAIN_EVENTS` had a consumer and no producer:
 * `JOBS.RELAY_DOMAIN_EVENT` was defined, the worker subscribed, and nothing anywhere
 * ever enqueued it. So every domain event waited for `OUTBOX_BACKSTOP`, whose cron
 * pattern fires once every five minutes — and the code around it says plainly what
 * was intended: *"The
 * event-driven path is the fast one; this guarantees an outbox row committed during
 * an outage is eventually delivered."* The backstop was doing both jobs.
 *
 * Measured on real traffic before this existed: outbox → relay averaged **143s** and
 * peaked at **272s**, while the Telegram send that follows it took 1.7s. A uniform
 * arrival against a 300s sweep predicts exactly that, which is how the sweep was
 * identified as the whole of the delay.
 *
 * **Why an interceptor rather than an emit-time enqueue.** `OutboxService.emit()`
 * runs *inside* the caller's transaction, and BullMQ is not transactional: a job
 * added there would be visible to the worker before the row it refers to had
 * committed, and would survive a rollback that the row did not. By the time a
 * response is being returned the transaction has committed, so this is the earliest
 * point at which a nudge is unconditionally safe.
 *
 * **What it does not change.** The relay itself, its ordering (`drain()` reads
 * `createdAt ASC`), its idempotency (deterministic notification job ids plus
 * `notification.dedupe_key`), the retry semantics, and the backstop are all
 * untouched. This only makes the drain happen now instead of within five minutes.
 * A drain that finds nothing is one indexed read against
 * `outbox_event_unprocessed_idx`.
 */
@Injectable()
export class RelayNudgeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RelayNudgeInterceptor.name);

  constructor(private readonly queues: QueueService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!MUTATING.has(request.method)) return next.handle();

    return next.handle().pipe(
      tap({
        // Only on success. A request that threw has nothing committed to relay, and
        // the backstop remains the answer for anything this misses.
        next: () => {
          void this.nudge();
        },
      }),
    );
  }

  private async nudge(): Promise<void> {
    try {
      await this.queues.enqueue(
        QUEUES.DOMAIN_EVENTS,
        JOBS.RELAY_DOMAIN_EVENT,
        // Coalesced to one job per second across the whole API: a burst of requests
        // needs one drain, not one drain each, and `drain()` takes up to 100 rows a
        // pass. The id is monotonic, so it never collides with a past window.
        jobId('relay', String(Math.floor(Date.now() / 1000))),
        {},
      );
    } catch (error) {
      /**
       * Deliberately swallowed.
       *
       * The work is already committed and the backstop will deliver it; failing the
       * user's response because Redis hiccuped would turn a five-minute delay into a
       * visible error, which is strictly worse. Logged so a persistently unreachable
       * queue is visible as something other than "the product feels slow".
       */
      this.logger.warn(
        `Could not nudge the outbox relay; the backstop will cover it: ${String(error)}`,
      );
    }
  }
}
