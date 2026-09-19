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
   * Redraw the message a conversation wizard lives on (ADR-0017).
   *
   * On `telegram-send` for the same reason `BOT_CALLBACK_ANSWER` is:
   * `editMessageText` is an outbound Telegram call, and invariant 11 puts every
   * one of those in the worker behind the one global limiter. A wizard that
   * edited inline from the API would also be the fastest way to exhaust the
   * limiter, since it fires on *every* tap rather than once per notification.
   *
   * The payload carries the **internal** `user_id`, not a chat id. Telegram
   * addresses an edit by `(chat_id, message_id)`, so the shortcut is to put the
   * chat id in the job — and that would make Redis the one place outside
   * `identity` holding a `telegram_user_id`, which invariant 7 exists to
   * prevent. The worker resolves it at delivery through
   * `NotificationService.telegramTargetFor`, which is what every notification
   * already does. Same rule, same module, one resolution path.
   */
  BOT_EDIT_MESSAGE: 'bot-edit-message',
  /**
   * Take the user's own message out of the chat once a wizard has read it.
   *
   * A wizard is one message that changes (ADR-0017) — but only the *bot's* half
   * of it was. Every answer the user typed stayed above it, so filling in a
   * profile left a column of «۲۵», «تهران», «کوهنوردی» sitting over a form that
   * had already absorbed all three. The form looked tidy and the chat did not.
   *
   * On `telegram-send` for the reason `BOT_EDIT_MESSAGE` is: `deleteMessage` is
   * an outbound Telegram call, and invariant 11 puts every one of those in the
   * worker behind the one global limiter.
   *
   * The payload carries the **internal** `user_id` and Telegram's `message_id`,
   * never a chat id — resolved at delivery through
   * `NotificationService.telegramTargetFor`, exactly as an edit is, so Redis
   * never holds a `telegram_user_id` (invariant 7).
   *
   * Failure is nothing to retry: Telegram refuses to delete a message older than
   * 48 hours, and one that is already gone is the outcome we wanted.
   */
  BOT_DELETE_MESSAGE: 'bot-delete-message',
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
  /**
   * The two reminders before an activity starts (migration 0050).
   *
   * Its own job rather than a third thing hanging off `EVENT_LIFECYCLE`, which
   * runs every minute and looks at events that have **already begun**. This
   * looks at ones that have not, and every minute is far more often than a
   * question measured in hours needs asking.
   */
  EVENT_REMINDER: 'event-reminder',
  /**
   * Tell linked moderators the queue has work (plan 06).
   *
   * Sent from the scheduled job itself rather than as notifications: a
   * moderator is not a `user`, and the address is read from
   * `admin_telegram_link` at delivery, so no job payload carries a Telegram id.
   */
  MODERATION_DIGEST: 'moderation-digest',
  /**
   * Ask a host «همه آمدند؟» once their activity is over (plan 15).
   *
   * Its own job rather than part of `SETTLE_ATTENDANCE`, because the two answer
   * opposite ends of one window: this opens it, the moment the activity ends;
   * settlement closes it, `participation.settlement_delay_hours` later.
   */
  ATTENDANCE_PROMPT: 'attendance-prompt',
  /**
   * «پایه‌تَم در … باز شد» to the people of a city an operator just opened (plan 17).
   *
   * A job rather than part of the panel request: the worker drains the campaign,
   * so the worker creates it — `CityLaunchAnnouncementService` says why.
   */
  CITY_LAUNCH_ANNOUNCE: 'city-launch-announce',
  SETTLE_ATTENDANCE: 'settle-attendance',
  /**
   * Return the host's deposit and pay the per-guest bonus.
   *
   * Separate from `SETTLE_ATTENDANCE` and on a different cadence, because it
   * waits on something a nightly sweep cannot: the host has to have written their
   * reviews, and those arrive over the seven days *after* attendance settles.
   * There is no single moment to hang it on, so it re-asks hourly and pays the
   * first time the answer is yes.
   */
  SETTLE_HOST_REWARDS: 'settle-host-rewards',
  /** The one-per-lifetime grant to somebody who has attended, behaved, and run out. */
  GRANT_COMEBACK_COINS: 'grant-comeback-coins',
  /** Publish newly-eligible events, and take down posts that have gone stale. */
  CHANNEL_SYNC: 'channel-sync',
  /**
   * Edit a channel post whose seats line has fallen behind (v0.16.0).
   *
   * Apart from `CHANNEL_SYNC` because it runs every minute and that runs every
   * five: a request closing a seat should show in about a minute. Budgeted by
   * `ChannelService.findStaleCapacity`, which is what keeps it inside Telegram's
   * per-channel limits.
   */
  CHANNEL_CAPACITY_SYNC: 'channel-capacity-sync',
  /** The retention purge (§8): expired chats, notifications, outbox and audit rows. */
  RETENTION_PURGE: 'retention-purge',
  /** Delete conversation drafts past their seven days (ADR-0017 §3). */
  CONVERSATION_PURGE: 'conversation-purge',
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
  /**
   * Create seed events up to each configured city's floor (marketing seed
   * events, see docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md).
   */
  SEED_TOPUP: 'seed-topup',
  /** Advance every filling seed event that is due its next seat. */
  SEED_FILL: 'seed-fill',
  /**
   * Remove the synthetic people of every seed event that is over, so they never
   * add up to a user count that is not real (see
   * docs/superpowers/specs/2026-09-19-seed-event-floor-and-purge-design.md).
   */
  SEED_PURGE: 'seed-purge',
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
 * a *person's* day: a gift sent at 10:00 UTC lands in the middle of somebody's
 * afternoon. A job measured from an instant — a reminder, a settlement window —
 * has no day to be about, and carries no timezone.
 */
export const SCHEDULE: ReadonlyArray<{ name: JobName; pattern: string; tz?: string }> = [
  { name: JOBS.EVENT_LIFECYCLE, pattern: '* * * * *' },
  { name: JOBS.EXPIRE_PENDING, pattern: '* * * * *' },
  { name: JOBS.PROMOTE_WAITLIST, pattern: '*/5 * * * *' },
  { name: JOBS.OUTBOX_BACKSTOP, pattern: '*/5 * * * *' },
  { name: JOBS.REVIEW_SWEEP, pattern: '0 * * * *' },
  /**
   * Every quarter of an hour.
   *
   * The precision this owes anybody is «فردا» and «چند ساعت دیگر», not a minute
   * — so a quarter is the coarsest cadence that still puts the three-hour
   * reminder within fifteen minutes of three hours, which is well inside what
   * the message itself claims. Hourly would let it drift to «۳ ساعت دیگر» sent
   * two hours and five minutes out, on the one message whose whole value is
   * landing before the penalty step.
   *
   * No timezone: unlike the daily jobs this is not about a person's day, it is a
   * fixed offset from an instant that is already stored in UTC.
   */
  { name: JOBS.EVENT_REMINDER, pattern: '*/15 * * * *' },
  /**
   * Every quarter hour, with no timezone (plan 06).
   *
   * The job decides for itself whether it is a waking hour in Tehran, so a
   * cron `tz` would only move the ticks. A quarter is as fine as the digest's
   * own fifteen-minute delay; most passes find a quiet period and send nothing.
   */
  { name: JOBS.MODERATION_DIGEST, pattern: '*/15 * * * *' },
  /**
   * «همه آمدند؟», every quarter hour with no timezone (plan 15) — the same cadence
   * and the same reasoning as `EVENT_REMINDER`: it is a fixed offset from an
   * instant, and a quarter hour after the end is soon enough to find a host
   * still thinking about the evening.
   */
  { name: JOBS.ATTENDANCE_PROMPT, pattern: '*/15 * * * *' },
  /**
   * Hourly, at forty past, with no timezone (plan 15).
   *
   * It was 03:00 Tehran, which made the window a host had to report a no-show
   * depend on when the activity ended — five hours for one ending at 22:00. Run
   * hourly, `participation.settlement_delay_hours` *is* the window. Forty past
   * (in the worker's clock, which is UTC) keeps it off the top of the hour, where
   * `REVIEW_SWEEP` starts, and away from `SETTLE_HOST_REWARDS` at twenty past,
   * which reads what this writes.
   */
  { name: JOBS.SETTLE_ATTENDANCE, pattern: '40 * * * *' },
  /**
   * Hourly, at twenty past.
   *
   * Hourly rather than nightly because what it waits for is a *person* finishing
   * their reviews, and making a host wait until 3 a.m. to see their deposit come
   * back would turn a promise kept into a promise kept eventually. The scan is a
   * few days of completed events and almost every pass finds nothing to do.
   *
   * Twenty past, so it never starts in the same minute as the two every-minute
   * sweeps at the top of the hour.
   */
  { name: JOBS.SETTLE_HOST_REWARDS, pattern: '20 * * * *' },
  /**
   * Once a day, at ten in the morning Tehran time — and the only job here whose
   * schedule is chosen for when the *message* arrives rather than for load.
   *
   * It is an unprompted gift, so it should land when somebody is awake and might
   * act on it. At 04:00 with the purges it would be read hours later alongside
   * everything else, which is exactly the treatment that makes a gesture look
   * like an automated mailing.
   */
  { name: JOBS.GRANT_COMEBACK_COINS, pattern: '0 10 * * *', tz: 'Asia/Tehran' },
  { name: JOBS.CHANNEL_SYNC, pattern: '*/5 * * * *' },
  // Every minute, budgeted per pass — see `JOBS.CHANNEL_CAPACITY_SYNC`.
  { name: JOBS.CHANNEL_CAPACITY_SYNC, pattern: '* * * * *' },
  // Every five minutes, no timezone: an opening is an instant, and a message
  // that lands a few minutes after the operator's click is on time (plan 17).
  { name: JOBS.CITY_LAUNCH_ANNOUNCE, pattern: '*/5 * * * *' },
  // Every minute. The API nudges this queue on confirmation, so the schedule is
  // the backstop rather than the mechanism — a campaign confirmed while the worker
  // was restarting is picked up within a minute instead of never.
  { name: JOBS.CAMPAIGN_DISPATCH, pattern: '* * * * *' },
  /**
   * Once a night, in the quietest hour Tehran has.
   *
   * A privacy commitment measured in days does not need to be honoured to the
   * minute, and the purge takes locks on tables the product reads all day. 04:00
   * local is far enough from either end of the evening that a purge running long
   * costs nobody anything.
   *
   * It no longer has the night to itself. Attendance settles hourly since plan
   * 15, at forty past in the worker's clock — UTC, so ten past in Tehran, ten
   * minutes into this. The two do not contend for rows: settlement writes this
   * week's participations and audit entries, and the purge deletes what is
   * months old.
   */
  { name: JOBS.RETENTION_PURGE, pattern: '0 4 * * *', tz: 'Asia/Tehran' },
  /**
   * Conversation drafts, with the retention purge and for the same reason
   * (ADR-0017 §3).
   *
   * Daily rather than hourly: a draft's deadline is seven days out, so the worst
   * a day's granularity costs is a form living a few hours past it. Running it on
   * a request instead would make one user pay for another's expired form.
   */
  { name: JOBS.CONVERSATION_PURGE, pattern: '15 4 * * *', tz: 'Asia/Tehran' },
  /**
   * Half past four, after the purge.
   *
   * Deliberately *after* it: the purge deletes expired rows, and reconciling
   * before it would occasionally report a drift that the next half hour resolves.
   */
  { name: JOBS.LEDGER_RECONCILE, pattern: '30 4 * * *', tz: 'Asia/Tehran' },
  /**
   * Every five minutes. A pass creates at most three events per city, so a city
   * far below its floor is reached over a few passes rather than in one burst.
   */
  { name: JOBS.SEED_TOPUP, pattern: '*/5 * * * *' },
  /**
   * Every minute — a configured `fillMinutes` is typically around 5, so a
   * coarser cadence would make the "filling live" effect look stepped
   * rather than organic.
   */
  { name: JOBS.SEED_FILL, pattern: '* * * * *' },
  /**
   * Hourly, at :50 — just after `SETTLE_ATTENDANCE` (:40), so an event whose
   * settlement delay has only now passed is usually settled by the real sweep
   * first and purged straight after. Either order is safe; this one avoids
   * deleting people the settlement was about to write to. An event's synthetic
   * guests are not urgent, and an hour of lag costs nothing.
   */
  { name: JOBS.SEED_PURGE, pattern: '50 * * * *' },
];
