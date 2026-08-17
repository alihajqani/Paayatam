import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job, type Processor } from 'bullmq';
import { PrismaService } from '@payetam/db';
import type { Env } from '@payetam/config';
import {
  ENV,
  METRICS,
  MetricsRegistry,
  QUEUE_CONCURRENCY,
  TELEGRAM_GLOBAL_RATE,
  QUEUES,
  type QueueName,
} from '@payetam/platform';

/**
 * Builds BullMQ workers, and mirrors every exhausted job into `job_failure`.
 *
 * The mirroring is the part worth reading. BullMQ keeps a failed job in Redis
 * (`removeOnFail: false`), which is enough to inspect it *today* — but Redis is
 * the thing that gets flushed during an incident, and a failure that only exists
 * there disappears exactly when somebody needs it. A row in Postgres survives, is
 * visible in the admin panel, and can be re-driven (ADR-0005).
 *
 * `failed` fires on every attempt, so the mirror is written only once the job has
 * no attempts left. Writing on each would fill the table with transient network
 * blips that resolved on their own.
 */
@Injectable()
export class WorkerFactory implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerFactory.name);
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly metrics: MetricsRegistry,
  ) {}

  create(name: QueueName, processor: Processor): Worker {
    const worker = new Worker(name, processor, {
      connection: { url: this.env.REDIS_URL },
      prefix: this.env.QUEUE_PREFIX,
      concurrency: QUEUE_CONCURRENCY[name],
      // Only `telegram-send` is limited, and only because Telegram limits it.
      // Putting a limiter on the others would slow the relay for no reason —
      // Postgres is not rate-limited and the fan-out is where latency is visible.
      ...(name === QUEUES.TELEGRAM_SEND ? { limiter: { ...TELEGRAM_GLOBAL_RATE } } : {}),
    });

    worker.on('failed', (job, error) => {
      void this.onFailed(name, job, error);
    });

    /**
     * Job duration and completion, for the same reason HTTP requests are measured:
     * a queue that is keeping up and a queue that is keeping up *slowly* look
     * identical from its depth alone, right until the moment it stops keeping up.
     *
     * `job.processedOn` is BullMQ's own timestamp for when the job was picked up, so
     * this measures processing rather than time spent waiting — the two need
     * separating, because a rise in the first is a code problem and a rise in the
     * second is a capacity problem.
     */
    worker.on('completed', (job) => {
      if (job.processedOn === undefined) return;
      this.metrics.observe(
        METRICS.JOB_DURATION,
        'Job processing duration in seconds',
        (Date.now() - job.processedOn) / 1000,
        { queue: name, job: job.name },
      );
    });

    worker.on('error', (error: Error) => {
      // Worker-level errors are connection problems, not job problems. Warn rather
      // than error: BullMQ reconnects, and an error-level log per reconnect during
      // a Redis blip is how a real incident gets buried.
      this.logger.warn(`${name}: ${error.message}`);
    });

    this.workers.push(worker);
    this.logger.log(`Worker started for ${name} (concurrency ${String(QUEUE_CONCURRENCY[name])})`);
    return worker;
  }

  private async onFailed(queue: QueueName, job: Job | undefined, error: Error): Promise<void> {
    if (!job) return;

    /**
     * Counted on **every** attempt, with the terminal ones labelled separately.
     *
     * A transient failure that a retry fixed is still a signal — a queue quietly
     * retrying half its jobs is a queue about to fall over — but it is a different
     * signal from work that has given up, and the label is what keeps an alert on
     * the second from firing on the first.
     */
    const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade;
    this.metrics.counter(METRICS.JOB_FAILURES, 'Job failures by queue and outcome', {
      queue,
      job: job.name,
      outcome: attemptsLeft > 0 ? 'retrying' : 'exhausted',
    });

    if (attemptsLeft > 0) {
      this.logger.warn(
        `${queue}/${job.name} attempt ${String(job.attemptsMade)}: ${error.message}`,
      );
      return;
    }

    try {
      await this.prisma.jobFailure.upsert({
        // One row per job, so a re-driven job that fails again updates rather than
        // accumulating — the queue depth in the panel is the number of distinct
        // problems, not the number of attempts anybody has made at them.
        where: { queue_jobId: { queue, jobId: job.id ?? 'unknown' } },
        create: {
          queue,
          jobName: job.name,
          jobId: job.id ?? 'unknown',
          payload: job.data as object,
          error: error.message.slice(0, 1000),
          attempts: job.attemptsMade,
        },
        update: {
          error: error.message.slice(0, 1000),
          attempts: job.attemptsMade,
          redrivenAt: null,
        },
      });
      this.logger.error(`${queue}/${job.name} exhausted; recorded in job_failure`);
    } catch (writeError) {
      // The DLQ write failing is the one error that must not be swallowed: it
      // means a job was lost *and* nothing recorded it.
      this.logger.error(`Failed to record job_failure for ${queue}/${job.name}`, writeError);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Closing waits for in-flight jobs. On SIGTERM the worker finishes what it is
    // holding rather than abandoning it — recoverable either way through the
    // outbox, but redelivery is a retry and retries are only free because every
    // job is idempotent.
    for (const worker of this.workers) await worker.close();
  }
}
