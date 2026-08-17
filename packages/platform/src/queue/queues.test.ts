import { describe, expect, it } from 'vitest';
import { JOBS, QUEUES, QUEUE_CONCURRENCY, SCHEDULE, jobId } from './queues';

/**
 * `jobId` exists because of a bug that cost every notification the product ever
 * queued: BullMQ composes its Redis keys as `prefix:queue:jobId` and refuses a
 * custom id containing `:`, and every producer here had written `notify:${id}`.
 * The throw happened inside `queue.add`, after the relay had marked the outbox row
 * processed — so the row looked delivered, the notification sat `PENDING` forever,
 * and nothing anywhere said why.
 */
describe('jobId', () => {
  it('joins with a hyphen', () => {
    expect(jobId('notify', 'abc-123')).toBe('notify-abc-123');
  });

  /** The whole point. A colon here is a key collision, not a formatting choice. */
  it('refuses a colon', () => {
    expect(() => jobId('notify:abc')).toThrow(/only letters, digits/);
    expect(() => jobId('notify', 'a:b')).toThrow(/":"/);
  });

  it.each([
    ['a space', 'notify id'],
    ['a slash', 'notify/id'],
    ['an empty id', ''],
    ['a Persian word', 'اعلان'],
  ])('refuses %s', (_name, part) => {
    expect(() => jobId(part)).toThrow();
  });

  /** A UUID is what every real id here is, so it must pass unremarkably. */
  it('accepts the ids the product actually builds', () => {
    expect(jobId('notify', '0198f0e1-2a3b-7c4d-8e5f-6a7b8c9d0e1f')).toBe(
      'notify-0198f0e1-2a3b-7c4d-8e5f-6a7b8c9d0e1f',
    );
    expect(jobId('callback', 'AAAAAgAAABYAAAAB_abcDEF')).toBe('callback-AAAAAgAAABYAAAAB_abcDEF');
  });
});

/**
 * The queue names and the schedule are shared constants: a producer and a consumer
 * disagreeing about one is a job that is enqueued successfully and never runs, and
 * the failure produces no error anywhere.
 */
describe('the queue catalogue', () => {
  it('gives every queue a concurrency', () => {
    for (const queue of Object.values(QUEUES)) {
      expect(QUEUE_CONCURRENCY[queue]).toBeGreaterThan(0);
    }
  });

  /** BullMQ refuses a colon in a queue name for the same reason as a job id. */
  it('uses no colon in a queue name', () => {
    for (const queue of Object.values(QUEUES)) {
      expect(queue).not.toContain(':');
    }
  });

  it('schedules only jobs that exist', () => {
    const names: string[] = Object.values(JOBS);
    for (const entry of SCHEDULE) {
      expect(names).toContain(entry.name);
    }
  });

  /** One schedule per job. A duplicate would run the same sweep twice a tick. */
  it('schedules each job once', () => {
    const scheduled = SCHEDULE.map((entry) => entry.name);
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });
});
