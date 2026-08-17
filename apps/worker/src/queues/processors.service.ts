import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  EventLifecycleService,
  NotificationService,
  OutboxRelayService,
  ParticipationService,
  ReviewService,
} from '@payetam/domain';
import { JOBS, QUEUES, QueueService, SCHEDULE } from '@payetam/platform';
import { render } from '@payetam/telegram';
import { TelegramClient } from '../telegram/telegram.client';
import { WorkerFactory } from './worker.factory';

/**
 * Everything the worker actually runs (ADR-0005, plan §3.5).
 *
 * Three processors and one schedule. The division follows the queues, and the
 * queues follow what has to be paced: only Telegram is rate-limited, so only
 * `telegram-send` is throttled, and the relay is free to run as fast as Postgres
 * allows.
 */
@Injectable()
export class Processors implements OnModuleInit {
  private readonly logger = new Logger(Processors.name);

  constructor(
    private readonly workers: WorkerFactory,
    private readonly queues: QueueService,
    private readonly relay: OutboxRelayService,
    private readonly notifications: NotificationService,
    private readonly telegram: TelegramClient,
    private readonly participation: ParticipationService,
    private readonly lifecycle: EventLifecycleService,
    private readonly reviews: ReviewService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.workers.create(QUEUES.DOMAIN_EVENTS, (job) => this.onDomainEvent(job));
    this.workers.create(QUEUES.TELEGRAM_SEND, (job) => this.onSend(job));
    this.workers.create(QUEUES.SCHEDULED, (job) => this.onScheduled(job));

    for (const entry of SCHEDULE) {
      await this.queues.schedule(entry.name, entry.pattern, entry.tz);
    }
    this.logger.log(`Registered ${String(SCHEDULE.length)} repeatable jobs`);
  }

  /**
   * Drain the outbox and hand each notification to the sender.
   *
   * Enqueued with the notification's own id as the BullMQ job id, which is the
   * first idempotency layer: a relay pass that runs twice over the same outbox row
   * produces the same notification ids, and re-adding an existing job id is a
   * no-op. `notification.dedupe_key` is the second, and it holds even if Redis was
   * flushed in between.
   */
  private async onDomainEvent(_job: Job): Promise<void> {
    const result = await this.relay.drain();
    if (result.processed === 0) return;

    for (const notificationId of result.queued) {
      await this.queues.enqueue(
        QUEUES.TELEGRAM_SEND,
        JOBS.SEND_NOTIFICATION,
        `notify:${notificationId}`,
        { notificationId },
      );
    }

    this.logger.log(
      `Relayed ${String(result.processed)} events → ${String(result.created)} notifications`,
    );
  }

  /**
   * Render one notification and send it.
   *
   * The three outcomes are deliberately different things:
   *
   *  - **SENT** records the Telegram message id, so an edit or a delete can find
   *    it later (D10).
   *  - **BLOCKED** is terminal and *not* a failure: it marks `bot_blocked` and
   *    returns normally, because throwing would retry a block and burn the rate
   *    budget other users' notifications need.
   *  - **RETRY** throws, which is how a queue is told to try again.
   */
  private async onSend(job: Job): Promise<void> {
    const notificationId = (job.data as { notificationId?: string }).notificationId;
    if (notificationId === undefined) return;

    const notification = await this.notifications.load(notificationId);
    // Already sent, already undeliverable, or gone. A redelivered job finds this
    // and stops — the dedupe key working on the send side rather than the queue.
    if (!notification) return;

    if (notification.telegramUserId === null || notification.botBlocked) {
      await this.notifications.markUndeliverable(notification.id, notification.userId);
      return;
    }

    const message = render(notification.templateKey, asRecord(notification.payload));
    if (!message) {
      // A template this build does not know — a notification queued by a newer
      // deploy. Failing loudly would stall the queue behind it through a rollout,
      // so it is recorded and skipped rather than retried forever.
      await this.notifications.markFailed(
        notification.id,
        `unknown template ${notification.templateKey}`,
      );
      return;
    }

    const outcome = await this.telegram.send(notification.telegramUserId, message.text);

    switch (outcome.kind) {
      case 'SENT':
        await this.notifications.markSent(notification.id, outcome.messageId);
        return;

      case 'BLOCKED':
        await this.notifications.markUndeliverable(notification.id, notification.userId);
        this.logger.log(`Notification ${notification.id}: recipient has blocked the bot`);
        return;

      case 'RETRY':
        await this.notifications.markFailed(notification.id, outcome.reason);
        // Thrown, so BullMQ applies the backoff and eventually dead-letters it.
        throw new Error(outcome.reason);
    }
  }

  /**
   * The repeatable sweeps.
   *
   * Every one of these is a domain method M6, M10 and M11 wrote and deliberately
   * left unscheduled — "scheduling it is M13's job" appears in three separate
   * deviation notes. This is that job. They are idempotent and read the server
   * clock, which is what makes running one twice a no-op rather than a double
   * charge.
   */
  private async onScheduled(job: Job): Promise<void> {
    switch (job.name) {
      case JOBS.OUTBOX_BACKSTOP: {
        // The backstop for a relay that died mid-pass. The event-driven path is
        // the fast one; this guarantees an outbox row committed during an outage
        // is eventually delivered.
        await this.onDomainEvent(job);
        return;
      }

      case JOBS.EXPIRE_PENDING: {
        const expired = await this.participation.expireOverdue();
        if (expired > 0) this.logger.log(`Expired ${String(expired)} overdue requests`);
        return;
      }

      case JOBS.PROMOTE_WAITLIST: {
        const promoted = await this.participation.sweepWaitlists();
        if (promoted > 0) this.logger.log(`Promoted ${String(promoted)} from waitlists`);
        return;
      }

      case JOBS.EVENT_LIFECYCLE: {
        const result = await this.lifecycle.retireStarted();
        if (result.completed + result.expired > 0) {
          this.logger.log(
            `Retired ${String(result.completed)} completed, ${String(result.expired)} expired`,
          );
        }
        return;
      }

      case JOBS.SETTLE_ATTENDANCE: {
        const settled = await this.lifecycle.settleAttendance();
        if (settled.attended > 0)
          this.logger.log(`Settled ${String(settled.attended)} attendances`);
        return;
      }

      case JOBS.REVIEW_SWEEP: {
        const settled = await this.reviews.settleExpired();
        if (settled.partial + settled.empty > 0) {
          this.logger.log(
            `Review deadlines: ${String(settled.partial)} partial, ${String(settled.empty)} empty`,
          );
        }
        return;
      }

      default:
        this.logger.warn(`Unknown scheduled job ${job.name}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
