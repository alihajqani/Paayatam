import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@payetam/db';
import { createTestPrisma, resetDatabase } from '../../../../test/integration/db';

/**
 * The dead-letter queue, mirrored into Postgres (ADR-0005, M13).
 *
 * The plan asks that *"exhausted retries land in `job_failure` and are
 * re-drivable"*. The mirroring itself lives in `WorkerFactory`, which needs a live
 * BullMQ worker to exercise; what is asserted here is the half that makes the
 * mirror worth having — the **shape** of the table, which is what makes a failure
 * survivable and re-drivable rather than merely recorded.
 *
 * Why mirror at all, when BullMQ already keeps failed jobs with
 * `removeOnFail: false`? Because Redis is the thing that gets flushed during an
 * incident, and a failure that exists only there disappears exactly when somebody
 * needs it. A row in Postgres survives, is visible in the admin panel, and can be
 * re-driven.
 */

const prisma: PrismaClient = createTestPrisma();

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function fail(jobId: string, error = 'network error reaching Telegram'): Promise<void> {
  await prisma.jobFailure.upsert({
    where: { queue_jobId: { queue: 'telegram-send', jobId } },
    create: {
      queue: 'telegram-send',
      jobName: 'send-notification',
      jobId,
      payload: { notificationId: 'n-1' },
      error,
      attempts: 5,
    },
    update: { error, attempts: 5, redrivenAt: null },
  });
}

describe('an exhausted job becomes a row', () => {
  it('records the queue, the job, its payload and why it failed', async () => {
    await fail('notify:n-1');

    const row = await prisma.jobFailure.findFirstOrThrow();
    expect(row).toMatchObject({
      queue: 'telegram-send',
      jobName: 'send-notification',
      jobId: 'notify:n-1',
      attempts: 5,
    });
    // The payload is kept, which is what makes a re-drive possible at all — the
    // job can be reconstructed from the row rather than from a lost queue entry.
    expect(row.payload).toMatchObject({ notificationId: 'n-1' });
    expect(row.redrivenAt).toBeNull();
  });

  /**
   * One row per job, not one per attempt.
   *
   * A job re-driven and failing again updates its row, so the queue depth an admin
   * sees is the number of *distinct problems* rather than the number of attempts
   * anybody has made at them. The second is a number that only ever grows and
   * tells nobody anything.
   */
  it('updates rather than accumulating when the same job fails again', async () => {
    await fail('notify:n-1', 'first failure');
    await fail('notify:n-1', 'second failure');

    const rows = await prisma.jobFailure.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).toBe('second failure');
  });

  it('is enforced by the database, not only by the upsert', async () => {
    await fail('notify:n-1');

    await expect(
      prisma.jobFailure.create({
        data: {
          queue: 'telegram-send',
          jobName: 'send-notification',
          jobId: 'notify:n-1',
          payload: {},
          error: 'again',
        },
      }),
    ).rejects.toThrow(/queue.*job_id|job_id.*queue/s);
  });

  it('keeps failures from different queues apart', async () => {
    await fail('notify:n-1');
    await prisma.jobFailure.create({
      data: {
        queue: 'domain-events',
        jobName: 'relay-domain-event',
        jobId: 'notify:n-1',
        payload: {},
        error: 'different queue, same id',
      },
    });

    await expect(prisma.jobFailure.count()).resolves.toBe(2);
  });
});

describe('re-driving', () => {
  /**
   * `redriven_at` is what stops the admin panel re-running the same failure every
   * time somebody opens the page — the queue of *outstanding* problems is the one
   * with a null here.
   */
  it('marks a failure as re-driven without deleting the record', async () => {
    await fail('notify:n-1');
    const at = new Date('2026-08-15T10:00:00.000Z');

    await prisma.jobFailure.updateMany({
      where: { queue: 'telegram-send', jobId: 'notify:n-1' },
      data: { redrivenAt: at },
    });

    const row = await prisma.jobFailure.findFirstOrThrow();
    expect(row.redrivenAt).toEqual(at);
    // The record survives, so "this job has failed before" stays answerable.
    expect(row.error).toContain('network error');
  });

  it('lists only the outstanding failures', async () => {
    await fail('notify:n-1');
    await fail('notify:n-2');
    await prisma.jobFailure.updateMany({
      where: { jobId: 'notify:n-1' },
      data: { redrivenAt: new Date() },
    });

    const outstanding = await prisma.jobFailure.findMany({ where: { redrivenAt: null } });
    expect(outstanding.map((row) => row.jobId)).toEqual(['notify:n-2']);
  });

  /** A re-drive that fails again clears the marker, so it returns to the queue. */
  it('returns to the outstanding list when a re-driven job fails again', async () => {
    await fail('notify:n-1');
    await prisma.jobFailure.updateMany({
      where: { jobId: 'notify:n-1' },
      data: { redrivenAt: new Date() },
    });

    await fail('notify:n-1', 'failed again after re-drive');

    const row = await prisma.jobFailure.findFirstOrThrow();
    expect(row.redrivenAt).toBeNull();
    expect(row.error).toBe('failed again after re-drive');
  });
});
