import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { JobsOptions } from 'bullmq';
import type { Env } from '@payetam/config';
import { ENV } from '../config/env.provider';
import { DEFAULT_JOB_OPTIONS, QUEUES, type JobName, type QueueName } from './queues';

/**
 * The producer side of BullMQ.
 *
 * Split from the *consumer* side deliberately: the API enqueues and never
 * processes, the worker does both, and a `Worker` constructed in the API would
 * quietly start draining a queue nobody expected it to touch.
 *
 * Every queue is namespaced by `QUEUE_PREFIX`, so a development machine, a
 * staging box and CI can share one Redis without stealing each other's jobs —
 * which they otherwise would, silently, and the symptom would be "my job never
 * ran" on one machine and "a job I never created" on another.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  queue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    const queue = new Queue(name, {
      connection: { url: this.env.REDIS_URL },
      prefix: this.env.QUEUE_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Enqueue with a **deterministic** id.
   *
   * The id is the first of ADR-0005's two idempotency layers: re-adding an
   * existing job id is a no-op in BullMQ, so a relay that runs twice over the same
   * outbox row produces one job. The caller must derive it from the thing that
   * caused the work — never from a timestamp or a random value, or the layer does
   * nothing.
   */
  async enqueue(
    queueName: QueueName,
    jobName: JobName,
    jobId: string,
    payload: Record<string, unknown>,
    options: JobsOptions = {},
  ): Promise<void> {
    await this.queue(queueName).add(jobName, payload, { ...options, jobId });
  }

  /**
   * Register the repeatable sweeps.
   *
   * `upsertJobScheduler` keyed on the job's own name, so restarting the worker
   * *replaces* the schedule rather than adding a second copy — which is the
   * classic way a "once a minute" sweep ends up running four times a minute after
   * a month of deploys. BullMQ 6 replaced the old `repeat` job option with this,
   * and the upsert semantics are the reason it is an improvement rather than a
   * rename.
   */
  async schedule(jobName: JobName, pattern: string, tz?: string): Promise<void> {
    await this.queue(QUEUES.SCHEDULED).upsertJobScheduler(
      `repeat:${jobName}`,
      { pattern, ...(tz !== undefined ? { tz } : {}) },
      { name: jobName },
    );
  }

  async onModuleDestroy(): Promise<void> {
    for (const [name, queue] of this.queues) {
      await queue.close();
      this.logger.log(`Closed queue ${name}`);
    }
  }
}

/**
 * Global, like `ConfigModule` and `RedisModule`, and for the same reason: both
 * processes need it and neither should have to remember to import it.
 */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
