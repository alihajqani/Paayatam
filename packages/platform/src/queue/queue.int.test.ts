import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import type { Env } from '@payetam/config';
import { QueueService } from './queue.module';
import { JOBS, QUEUES, jobId } from './queues';

/**
 * The producer side against a **real Redis**, which nothing else in this repository
 * did.
 *
 * M13 recorded the gap in as many words — *"No integration test drives a live BullMQ
 * worker… the mirroring code in `WorkerFactory` is exercised by nothing, and that is a
 * genuine gap rather than a judgement that it does not matter"* — and the gap had
 * already cost something: every producer built its job id as `notify:${id}`, BullMQ 6
 * refuses a custom id containing `:`, and so **not one notification was ever
 * enqueued**. The relay had marked the outbox row processed before the throw, so the
 * backstop could not recover it and the notification sat `PENDING` with zero attempts.
 *
 * Everything either side of the queue was tested. The queue was not, and the queue was
 * where it broke. This file is small on purpose: it asserts that a job the product
 * actually builds *lands*, and that adding it twice produces one — which is the first
 * of ADR-0005's two idempotency layers and was equally untested.
 */

/** Its own prefix, so a developer's queued jobs are neither read nor obliterated. */
const PREFIX = `payetam:test:${String(process.pid)}`;

const env = {
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:56379',
  QUEUE_PREFIX: PREFIX,
} as unknown as Env;

const service = new QueueService(env);

/** A second, independent handle — the consumer's view of what the producer wrote. */
let inspector: Queue;

beforeAll(() => {
  inspector = new Queue(QUEUES.TELEGRAM_SEND, {
    connection: { url: env.REDIS_URL },
    prefix: PREFIX,
  });
});

afterAll(async () => {
  await inspector.obliterate({ force: true });
  await inspector.close();
  await service.onModuleDestroy();
});

describe('enqueueing a job the product builds', () => {
  it('lands a notification job that a worker can read back', async () => {
    const notificationId = '0198f0e1-2a3b-7c4d-8e5f-6a7b8c9d0e1f';
    const id = jobId('notify', notificationId);

    await service.enqueue(QUEUES.TELEGRAM_SEND, JOBS.SEND_NOTIFICATION, id, { notificationId });

    const job = await inspector.getJob(id);
    expect(job).toBeDefined();
    expect(job?.name).toBe(JOBS.SEND_NOTIFICATION);
    expect(job?.data).toEqual({ notificationId });
  });

  /**
   * ADR-0005's first idempotency layer: *"re-adding an existing job id is a no-op in
   * BullMQ, so a relay that runs twice over the same outbox row produces one job."*
   * Asserted rather than assumed, because the entire crash-safety argument rests on it.
   */
  it('produces one job when the same id is added twice', async () => {
    const id = jobId('notify', 'twice-0198f0e12a3b7c4d');

    await service.enqueue(QUEUES.TELEGRAM_SEND, JOBS.SEND_NOTIFICATION, id, { n: 1 });
    await service.enqueue(QUEUES.TELEGRAM_SEND, JOBS.SEND_NOTIFICATION, id, { n: 2 });

    const jobs = await inspector.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((job) => job.id === id)).toHaveLength(1);
    // The first write wins: the second add is discarded, not merged.
    expect((await inspector.getJob(id))?.data).toEqual({ n: 1 });
  });

  it('lands the callback-answer job on the same queue', async () => {
    const id = jobId('callback', 'AAAAAgAAABYAAAAB_test');

    await service.enqueue(QUEUES.TELEGRAM_SEND, JOBS.BOT_CALLBACK_ANSWER, id, {
      callbackQueryId: 'AAAAAgAAABYAAAAB:test',
      text: 'پذیرفته شد',
    });

    const job = await inspector.getJob(id);
    expect(job?.name).toBe(JOBS.BOT_CALLBACK_ANSWER);
  });

  /**
   * **The failure that prompted this file.**
   *
   * Kept as a test rather than only as a comment: it is the reason `jobId` exists, and
   * without it a future refactor that goes back to string interpolation would be
   * silently reintroducing a bug that produces no error message anywhere near the
   * cause.
   */
  it('is refused outright when the id contains a colon', async () => {
    await expect(
      service.enqueue(QUEUES.TELEGRAM_SEND, JOBS.SEND_NOTIFICATION, 'notify:with-a-colon', {}),
    ).rejects.toThrow(/Custom Id cannot contain :/);
  });
});

describe('the repeatable schedule', () => {
  /**
   * `upsertJobScheduler` keyed on the job's own name, so restarting the worker
   * *replaces* a schedule rather than adding a second copy — which is the classic way
   * a "once a minute" sweep ends up running four times a minute after a month of
   * deploys.
   */
  it('replaces a schedule rather than adding a second copy', async () => {
    await service.schedule(JOBS.OUTBOX_BACKSTOP, '*/5 * * * *');
    await service.schedule(JOBS.OUTBOX_BACKSTOP, '*/5 * * * *');
    await service.schedule(JOBS.OUTBOX_BACKSTOP, '*/10 * * * *');

    const schedulers = await service.queue(QUEUES.SCHEDULED).getJobSchedulers();
    const ours = schedulers.filter((scheduler) => scheduler.key.includes(JOBS.OUTBOX_BACKSTOP));

    expect(ours).toHaveLength(1);
    expect(ours[0]?.pattern).toBe('*/10 * * * *');

    await service.queue(QUEUES.SCHEDULED).obliterate({ force: true });
  });
});
