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
  /**
   * The toast on an inline-keyboard tap.
   *
   * On `telegram-send` with everything else that talks to Telegram, because
   * `answerCallbackQuery` is an outbound Telegram call and ADR-0004 puts every one
   * of those in the worker: the webhook validates, persists and enqueues. It shares
   * the global rate limiter for the same reason, and the limiter's headroom exists
   * precisely for this — somebody is watching a spinner while it runs.
   *
   * The payload is a callback query id and a sentence. It carries **no chat id and
   * no user**, which is what keeps a Telegram identifier out of Redis.
   */
  BOT_CALLBACK_ANSWER: 'bot-callback-answer',
  /**
   * One recipient of an admin campaign or a paid invitation (M22 phases 4 and 11).
   *
   * On `telegram-send` with everything else, so it shares the one global limiter:
   * a four-thousand-recipient broadcast must not be able to starve the reply
   * somebody is watching a spinner for. The job id is derived from the recipient
   * row, so re-adding it is a no-op and the dispatcher is free to run twice.
   */
  CAMPAIGN_SEND: 'campaign-send',

  // The repeatable sweeps (ADR-0005's schedule).
  EVENT_LIFECYCLE: 'event-lifecycle',
  EXPIRE_PENDING: 'expire-pending',
  PROMOTE_WAITLIST: 'promote-waitlist',
  OUTBOX_BACKSTOP: 'outbox-backstop',
  REVIEW_SWEEP: 'review-sweep',
  SETTLE_ATTENDANCE: 'settle-attendance',
  /** Publish newly-eligible events, and take down posts that have gone stale. */
  CHANNEL_SYNC: 'channel-sync',
  /** The retention purge (§8): expired chats, notifications, outbox and audit rows. */
  RETENTION_PURGE: 'retention-purge',
  /**
   * Turn confirmed campaigns into individual send jobs (M22 phase 4).
   *
   * On `scheduled` rather than `telegram-send`, because it talks to Postgres and
   * not to Telegram — putting it behind the 25/s limiter would pace the *planning*
   * of a broadcast at the speed of its delivery.
   *
   * Enqueued directly by the API the moment a campaign is confirmed, so a send
   * starts in seconds; the minute-by-minute schedule below is the backstop for a
   * worker that was down when that happened.
   */
  CAMPAIGN_DISPATCH: 'campaign-dispatch',
  /**
   * Ask the ledger whether it still adds up (M22 phase 7).
   *
   * ADR-0007's invariant has been asserted by a test since M9 and by nobody in
   * production. A nightly check is what turns "the balance is a cache of the
   * ledger" from a property the tests believe into one the deployment knows — and
   * a coin inconsistency found by a machine at 4 a.m. is a different incident from
   * one found by a user disputing their balance in six weeks.
   */
  LEDGER_RECONCILE: 'ledger-reconcile',
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/**
 * Build a deterministic job id.
 *
 * **`:` is forbidden in a BullMQ custom job id**, and finding that out the hard way
 * is what this function exists to prevent. BullMQ composes its Redis keys as
 * `prefix:queue:jobId`, so a colon inside the id would produce a key that collides
 * with the namespace — and version 6 refuses it outright: `Job.addJob` throws
 * `Custom Id cannot contain :`.
 *
 * Every producer in this repository had written `notify:${id}`, which meant **not one
 * notification was ever enqueued**. The throw happened inside `queue.add`, after the
 * relay had already marked the outbox row processed, so the outbox backstop could not
 * recover it either: the row looked delivered and the notification sat `PENDING` with
 * zero attempts, forever. It was found by sending one `/start` to a running API and
 * asking why nothing arrived — not by any test, because no test drove a real queue.
 *
 * A function rather than a lint rule or a comment, because the id has to be composed
 * *somehow* and this is the composing. `-` separates; anything outside
 * `[A-Za-z0-9_-]` is refused loudly rather than passed to a library that will refuse
 * it later and less clearly.
 */
export function jobId(...parts: readonly string[]): string {
  const id = parts.join('-');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(
      `Invalid BullMQ job id ${JSON.stringify(id)}: only letters, digits, "_" and "-" are allowed ` +
        '(a ":" would collide with BullMQ\'s own key namespace).',
    );
  }
  return id;
}

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
  // Every minute. The API nudges this queue on confirmation, so the schedule is
  // the backstop rather than the mechanism — a campaign confirmed while the worker
  // was restarting is picked up within a minute instead of never.
  { name: JOBS.CAMPAIGN_DISPATCH, pattern: '* * * * *' },
  /**
   * Once a night, in the quietest hour Tehran has.
   *
   * A privacy commitment measured in days does not need to be honoured to the
   * minute, and the purge takes locks on tables the product reads all day. 04:00
   * local is after the attendance settlement at 03:00, so the two never contend,
   * and it is far enough from either end of the evening that a purge running long
   * costs nobody anything.
   */
  { name: JOBS.RETENTION_PURGE, pattern: '0 4 * * *', tz: 'Asia/Tehran' },
  /**
   * Half past four, after the purge.
   *
   * Deliberately *after* it: the purge deletes expired rows, and reconciling
   * before it would occasionally report a drift that the next half hour resolves.
   */
  { name: JOBS.LEDGER_RECONCILE, pattern: '30 4 * * *', tz: 'Asia/Tehran' },
];
