import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  ChannelService,
  ChatService,
  EventLifecycleService,
  NotificationService,
  OutboxRelayService,
  ParticipationService,
  RetentionService,
  ReviewService,
} from '@payetam/domain';
import { JOBS, QUEUES, QueueService, SCHEDULE, jobId } from '@payetam/platform';
import { TEMPLATES, render, renderChannelPost } from '@payetam/telegram';
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
    /** For one thing only: decrypting a relayed message at delivery time. */
    private readonly chats: ChatService,
    private readonly participation: ParticipationService,
    private readonly lifecycle: EventLifecycleService,
    private readonly reviews: ReviewService,
    private readonly channel: ChannelService,
    private readonly retention: RetentionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.workers.create(QUEUES.DOMAIN_EVENTS, (job) => this.onDomainEvent(job));
    // Two job names on one queue: both talk to Telegram, so both are paced by the
    // one limiter that exists for it (ADR-0005).
    this.workers.create(QUEUES.TELEGRAM_SEND, (job) =>
      job.name === JOBS.BOT_CALLBACK_ANSWER ? this.onCallbackAnswer(job) : this.onSend(job),
    );
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
        jobId('notify', notificationId),
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

    const payload = await this.withMessageBody(
      notification.templateKey,
      asRecord(notification.payload),
    );

    const message = render(notification.templateKey, payload, this.telegram.botUsername);
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

    const outcome = await this.telegram.send(
      notification.telegramUserId,
      message.text,
      message.keyboard,
    );

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
   * Put the message body into a chat notification, at the last possible moment.
   *
   * **This is the other half of M8's decision that the outbox carries no text.**
   * `outbox_event.payload` and `notification.payload` are plain jsonb, so a
   * relayed sentence stored in either would undo the encrypted column beside it;
   * M8 therefore wrote the payload with ids and an alias only, and left a note
   * saying "M13's relay decrypts the row the payload points at". That decryption
   * did not exist, so every relayed chat message was delivered with an **empty
   * body** — a notification that said «میهمان ۱:» and nothing else.
   *
   * The plaintext lives in this local variable for the length of one send. It is
   * not written back to the notification row, which is the point: a retry decrypts
   * again rather than finding the text waiting in a column.
   */
  private async withMessageBody(
    templateKey: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (templateKey !== TEMPLATES.CHAT_MESSAGE && templateKey !== TEMPLATES.CHAT_MESSAGE_EDITED) {
      return payload;
    }

    const chatPublicId = payload['chatPublicId'];
    const seq = payload['seq'];
    if (typeof chatPublicId !== 'string' || typeof seq !== 'number') return payload;

    const text = await this.chats.plaintextForDelivery(chatPublicId, seq);
    // Null means the message is gone — purged (M15) between queueing and sending.
    // The template renders an empty body, which is the honest outcome: there is
    // nothing left to relay, and refusing would retry against a row that will
    // never come back.
    return text === null ? payload : { ...payload, text };
  }

  /**
   * The toast on an inline-keyboard tap (plan §6's `callback_query`).
   *
   * Enqueued by the webhook rather than answered inline, because
   * `answerCallbackQuery` is an outbound Telegram call and ADR-0004 puts every one
   * of those in the worker. It **never throws**: the work the tap asked for was
   * committed before this job existed, and a callback query id expires in seconds,
   * so retrying can only fail again and more slowly.
   */
  private async onCallbackAnswer(job: Job): Promise<void> {
    const data = job.data as { callbackQueryId?: string; text?: string };
    if (data.callbackQueryId === undefined) return;

    await this.telegram.answerCallback(data.callbackQueryId, data.text ?? '');
  }

  /**
   * The repeatable sweeps.
   *
   * Every one of these is a domain method M6, M10 and M11 wrote and deliberately
   * left unscheduled — "scheduling it is M13's job" appears in three separate
   * deviation notes. This is that job. They are idempotent and read the server
   * clock, which is what makes running one twice a no-op rather than a double
   * charge.
   *
   * A sweep that *did* something drains the outbox immediately afterwards rather
   * than leaving its events for the next backstop. These sweeps are the only
   * producers of domain events inside the worker — the API nudges the relay from its
   * own side (`RelayNudgeInterceptor`) — and a promotion or an expiry that a user is
   * waiting to hear about should not sit for five minutes because the thing that
   * created it happened to be a cron job.
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
        if (expired > 0) {
          this.logger.log(`Expired ${String(expired)} overdue requests`);
          await this.onDomainEvent(job);
        }
        return;
      }

      case JOBS.PROMOTE_WAITLIST: {
        const promoted = await this.participation.sweepWaitlists();
        if (promoted > 0) {
          this.logger.log(`Promoted ${String(promoted)} from waitlists`);
          // A promotion is somebody being told they got a seat. Draining here rather
          // than waiting for the next backstop is the difference between "you are in"
          // arriving now and arriving up to five minutes later.
          await this.onDomainEvent(job);
        }
        return;
      }

      case JOBS.EVENT_LIFECYCLE: {
        const result = await this.lifecycle.retireStarted();
        if (result.completed + result.expired > 0) {
          this.logger.log(
            `Retired ${String(result.completed)} completed, ${String(result.expired)} expired`,
          );
          await this.onDomainEvent(job);
        }
        return;
      }

      case JOBS.SETTLE_ATTENDANCE: {
        const settled = await this.lifecycle.settleAttendance();
        if (settled.attended > 0) {
          this.logger.log(`Settled ${String(settled.attended)} attendances`);
          await this.onDomainEvent(job);
        }
        return;
      }

      case JOBS.CHANNEL_SYNC: {
        await this.syncChannel();
        return;
      }

      /**
       * The retention purge (§8), which M15 built as a service and left here to
       * schedule — the same split every other sweep above went through.
       *
       * Logged unconditionally, unlike the sweeps. A purge that quietly stopped
       * finding anything is indistinguishable from a purge that quietly stopped
       * running, and the difference is a privacy commitment being broken with no
       * signal at all. One line a night is a cheap way to be able to tell.
       */
      case JOBS.RETENTION_PURGE: {
        const purged = await this.retention.purge();
        this.logger.log(
          `Retention purge: ${String(purged.chatMessages)} messages, ` +
            `${String(purged.chats)} chats, ${String(purged.notifications)} notifications, ` +
            `${String(purged.outboxRows)} outbox, ${String(purged.auditRows)} audit`,
        );
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

  /**
   * Publish what has newly earned a post, and take down what has gone stale.
   *
   * The order matters: takedowns first, so a channel being read *right now* stops
   * advertising a cancelled event before it gains new entries. A reader who taps a
   * dead link is a reader who trusts the channel less.
   *
   * A failed post releases its claim rather than leaving the row behind. Leaving
   * it would mean one failed send permanently barred that event from the channel —
   * the unique index would refuse every future claim, and nothing would say why.
   */
  private async syncChannel(): Promise<void> {
    for (const target of await this.channel.findTakedowns()) {
      const removed = await this.telegram.deleteChannelPost(target.telegramMessageId);
      if (removed) await this.channel.markTakenDown(target.postId);
    }

    for (const post of await this.channel.claimPending()) {
      const outcome = await this.telegram.postToChannel(
        renderChannelPost({
          kind: post.kind,
          title: post.title,
          categoryName: post.categoryName,
          cityName: post.cityName,
          districtName: post.districtName,
          startsAt: post.startsAt,
          capacity: post.capacity,
          acceptedCount: post.acceptedCount,
          costType: post.costType,
          costAmount: post.costAmount,
          eventPublicId: post.eventPublicId,
          botUsername: this.telegram.botUsername,
        }),
      );

      if (outcome.kind === 'SENT') {
        await this.channel.markPosted(post.postId, outcome.messageId);
      } else {
        await this.channel.releaseClaim(post.postId);
        this.logger.warn(`Channel post for ${post.eventPublicId} failed: ${outcome.reason}`);
      }
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
