import type { JobsOptions } from 'bullmq';

/**
 * The four queues (ADR-0005, plan §3.5).
 *
 * Named here rather than as string literals at each call site, because a producer
 * and a consumer disagreeing about a queue name is a job that is enqueued
 * successfully and never runs — the failure produces no error anywhere.
 */
export const QUEUES = {
  /** Every outbound Telegram call. Nothing writes to Telegram outside this. */
  TELEGRAM_SEND: 'telegram-send',
  /** Outbox fan-out: one domain event becomes zero or more notifications. */
  DOMAIN_EVENTS: 'domain-events',
  /** The repeatable sweeps. */
  SCHEDULED: 'scheduled',
  /** Re-scan on a blacklist version bump. */
  MODERATION: 'moderation',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Concurrency per queue (ADR-0005's table).
 *
 * `telegram-send` is 5 rather than 1 because the limiter below is what actually
 * paces it; concurrency only decides how many are in flight while the limiter
 * lets them through. `scheduled` is 2 because the sweeps are minutes apart and a
 * higher number would only mean two copies of the same sweep racing.
 */
export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  [QUEUES.TELEGRAM_SEND]: 5,
  [QUEUES.DOMAIN_EVENTS]: 10,
  [QUEUES.SCHEDULED]: 2,
  [QUEUES.MODERATION]: 2,
};

/**
 * 25 messages a second, under Telegram's ~30.
 *
 * The headroom is deliberate and ADR-0005 says why: interactive replies — a user
 * pressing a button and waiting — share the same budget as the notification
 * backlog, and a queue that saturates the limit makes the interactive path feel
 * broken. Running at the limit also means every burst produces 429s, and a 429
 * costs more than the message it refused.
 */
export const TELEGRAM_GLOBAL_RATE = { max: 25, duration: 1000 } as const;

/**
 * Retry policy, applied to every queue (ADR-0005).
 *
 * Five attempts over roughly 5 s → 80 s. `removeOnFail: false` is the important
 * one: an exhausted job stays in Redis so the failure handler can mirror it into
 * `job_failure`, and a job removed on failure is a failure nobody can inspect.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: false,
};

/**
 * The job names each queue understands.
 *
 * A union rather than free strings, so a typo is a compile error instead of a job
 * that sits in Redis until its retries run out.
 */
export const JOBS = {
  /** One outbox row, fanned out into notifications. */
  RELAY_DOMAIN_EVENT: 'relay-domain-event',
  /** One notification, rendered and sent. */
  SEND_NOTIFICATION: 'send-notification',

  // The repeatable sweeps (ADR-0005's schedule).
  EVENT_LIFECYCLE: 'event-lifecycle',
  EXPIRE_PENDING: 'expire-pending',
  PROMOTE_WAITLIST: 'promote-waitlist',
  OUTBOX_BACKSTOP: 'outbox-backstop',
  REVIEW_SWEEP: 'review-sweep',
  SETTLE_ATTENDANCE: 'settle-attendance',
  /** Publish newly-eligible events, and take down posts that have gone stale. */
  CHANNEL_SYNC: 'channel-sync',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/**
 * The repeatable schedule (ADR-0005, plan §3.5).
 *
 * Every one of these is idempotent, and every one reads the server clock rather
 * than accepting a timestamp — which is what makes "run it twice" a no-op rather
 * than a double charge. The daily jobs are pinned to Tehran because they are about
 * a *person's* day: an attendance settled at 03:00 UTC would settle in the middle
 * of somebody's evening.
 */
export const SCHEDULE: ReadonlyArray<{ name: JobName; pattern: string; tz?: string }> = [
  { name: JOBS.EVENT_LIFECYCLE, pattern: '* * * * *' },
  { name: JOBS.EXPIRE_PENDING, pattern: '* * * * *' },
  { name: JOBS.PROMOTE_WAITLIST, pattern: '*/5 * * * *' },
  { name: JOBS.OUTBOX_BACKSTOP, pattern: '*/5 * * * *' },
  { name: JOBS.REVIEW_SWEEP, pattern: '0 * * * *' },
  { name: JOBS.SETTLE_ATTENDANCE, pattern: '0 3 * * *', tz: 'Asia/Tehran' },
  { name: JOBS.CHANNEL_SYNC, pattern: '*/5 * * * *' },
];
