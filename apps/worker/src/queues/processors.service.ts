import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  AdminTelegramService,
  ChannelService,
  ChatService,
  CoinService,
  ConversationService,
  EventLifecycleService,
  InvitationService,
  MessagingService,
  NotificationService,
  UserSettingsService,
  OutboxRelayService,
  ParticipationService,
  RATE_LIMIT_BREAKER_THRESHOLD,
  ReleaseAnnouncementService,
  RetentionService,
  ReviewService,
} from '@payetam/domain';
import { JOBS, MetricsRegistry, QUEUES, QueueService, SCHEDULE, jobId } from '@payetam/platform';
import {
  TEMPLATES,
  notificationCategory,
  preferenceKeyFor,
  menuKeyboard,
  render,
  renderChannelPost,
  type InlineKeyboard,
} from '@payetam/telegram';
import { TelegramLoggerService } from '../monitoring/telegram-logger.service';
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
/** Three consecutive five-minute sweeps: loud within the hour, quiet on a blip. */
const CHANNEL_FAILURE_ALERT_THRESHOLD = 3;

/**
 * How many recipients one dispatch pass turns into jobs.
 *
 * The limiter releases 25 a second, so 500 is twenty seconds of work — enough that
 * the queue never runs dry between minute-by-minute passes, small enough that a
 * four-thousand-recipient broadcast does not materialise as four thousand Redis
 * entries in one tick.
 */
const DISPATCH_BATCH = 500;

/**
 * How old the oldest undelivered outbox row may get before it is an incident.
 *
 * Fifteen minutes is three backstop passes. One pass can be missed by a restart
 * and two by a slow deploy; three means the row is being *tried* and is failing,
 * which is the case worth waking somebody for.
 */
const OUTBOX_STALE_MS = 15 * 60 * 1000;

@Injectable()
export class Processors implements OnModuleInit {
  private readonly logger = new Logger(Processors.name);

  constructor(
    private readonly workers: WorkerFactory,
    private readonly queues: QueueService,
    private readonly relay: OutboxRelayService,
    private readonly notifications: NotificationService,
    private readonly userSettings: UserSettingsService,
    private readonly telegram: TelegramClient,
    /** For one thing only: decrypting a relayed message at delivery time. */
    private readonly chats: ChatService,
    private readonly participation: ParticipationService,
    private readonly lifecycle: EventLifecycleService,
    private readonly reviews: ReviewService,
    private readonly channel: ChannelService,
    private readonly retention: RetentionService,
    /** Admin campaigns and paid invitations (M22 phases 4 and 11). */
    private readonly messaging: MessagingService,
    /**
     * The one broadcast nobody types: "the bot was updated, press /start".
     *
     * Created here rather than in the API because the worker is what delivers
     * it — a queued broadcast created by a process that cannot drain it would
     * sit until something else happened to run.
     */
    private readonly release: ReleaseAnnouncementService,
    /**
     * The invitation half of a campaign.
     *
     * `message_recipient` is the queue's record of a delivery and
     * `event_invitation` is the product's — the second is what a future selection
     * reads to know somebody has already been asked. They are written together
     * here so they cannot disagree.
     */
    private readonly invitations: InvitationService,
    /** Channel publishing outcomes, so a stuck channel is visible on /metrics (M16). */
    private readonly metrics: MetricsRegistry,
    /**
     * For one thing only: asking the ledger whether it still adds up (M22 phase 7).
     *
     * The worker never *moves* coins on a schedule. This reads.
     */
    private readonly coins: CoinService,
    /** Alerts a person should act on: a stuck channel, a tripped breaker (M20). */
    private readonly alerts: TelegramLoggerService,
    /**
     * Bot conversation drafts (ADR-0017), for two things only: recording the
     * message a wizard was redrawn onto when the old one was gone, and sweeping
     * drafts past their seven days. The worker never *advances* a wizard — that
     * is the API's, because it is the process the update arrives at.
     */
    private readonly conversations: ConversationService,
    /**
     * Whether the recipient is a linked moderator (ADR-0018).
     *
     * Asked here because here is where the persistent menu is attached, and the
     * menu is per-recipient. One indexed count against a table with a handful of
     * rows, on a path already bounded by Telegram's ~30/s — so it is not cached,
     * and a revoked link therefore stops showing the button on the very next
     * message rather than a minute later.
     */
    private readonly adminTelegram: AdminTelegramService,
  ) {}

  /**
   * Consecutive sweeps in which every channel post attempt failed.
   *
   * In memory on purpose. A failed send *deletes* its claim row so the next pass can
   * retry, which means there is nowhere in the database to keep a per-post attempt
   * count without inventing a table for it. What actually needs escalating is not
   * one post but the standing condition — the bot is not an admin of the channel, or
   * the id is wrong — and that is a property of the sweep, not of a row.
   */
  private consecutiveChannelFailures = 0;

  /**
   * Consecutive 429s per campaign, for the circuit breaker (M22 phase 4).
   *
   * Cleared by the first success, so a burst that resolves itself leaves nothing
   * behind. See `onRateLimited` for why it lives here rather than in Redis.
   */
  private readonly rateLimitStreak = new Map<string, number>();

  async onModuleInit(): Promise<void> {
    this.workers.create(QUEUES.DOMAIN_EVENTS, (job) => this.onDomainEvent(job));
    // Two job names on one queue: both talk to Telegram, so both are paced by the
    // one limiter that exists for it (ADR-0005).
    this.workers.create(QUEUES.TELEGRAM_SEND, (job) => {
      if (job.name === JOBS.BOT_CALLBACK_ANSWER) return this.onCallbackAnswer(job);
      if (job.name === JOBS.BOT_EDIT_MESSAGE) return this.onEditMessage(job);
      if (job.name === JOBS.BOT_DELETE_MESSAGE) return this.onDeleteMessage(job);
      if (job.name === JOBS.CAMPAIGN_SEND) return this.onCampaignSend(job);
      return this.onSend(job);
    });
    this.workers.create(QUEUES.SCHEDULED, (job) => this.onScheduled(job));

    for (const entry of SCHEDULE) {
      await this.queues.schedule(entry.name, entry.pattern, entry.tz);
    }
    this.logger.log(`Registered ${String(SCHEDULE.length)} repeatable jobs`);

    await this.announceRelease();
  }

  /**
   * Tell everybody the bot was updated, once per release (v0.6.5).
   *
   * ── Why the failure is swallowed ────────────────────────────────────────────
   *
   * Because this runs in `onModuleInit`, and a throw there stops the worker
   * booting. A deploy in which nobody was told about the release is a small
   * problem; a deploy in which the worker does not start is every notification,
   * every promotion, every expiry and every channel post stopping — and it would
   * be caused by the one piece of code in the process whose job is cosmetic.
   *
   * Exactly-once is `message_campaign.idempotency_key`, not this call site: three
   * restarts inside one deploy create one campaign, and the two after it find it
   * and stop. See `ReleaseAnnouncementService`.
   */
  private async announceRelease(): Promise<void> {
    try {
      const result = await this.release.announceCurrentRelease();
      if (!result.sent) {
        this.logger.log(`Release announcement skipped: ${result.reason}`);
      }
    } catch (error) {
      this.logger.error(
        `Release announcement failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
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
   *  - **RETRY** and **RATE_LIMITED** throw, which is how a queue is told to try
   *    again. They are one case here: a single notification has no campaign to
   *    trip a breaker for, and the queue's backoff is the whole of the answer.
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

    /**
     * What this person has chosen to be told about (v0.6.1).
     *
     * ── Why the check is here and not at enqueue ────────────────────────────
     *
     * The row is written either way. A preference is about **delivery**, not
     * about whether something happened: the notification is the product's
     * record that it had something to say, and «did we tell them?» six weeks
     * later should answer "we had this, and they had asked us not to" rather
     * than leaving no trace at all. Checking at enqueue would also mean a
     * preference change could not affect anything already queued.
     *
     * `essential` never consults a preference — consent, moderation outcomes,
     * account state, and every reply to something the user just did. A
     * preference that could silence `CONTENT_HIDDEN` would hide a moderation
     * decision from the person it was made about; one that could silence
     * `BOT_WALLET` would make the bot look broken to somebody who turned off
     * campaigns a month ago.
     *
     * Marked `SUPPRESSED` rather than failed: nothing went wrong, and a retry
     * would only reach the same answer more slowly.
     */
    const preference = preferenceKeyFor(notificationCategory(notification.templateKey));
    if (preference !== null) {
      const settings = await this.userSettings.get(notification.userId);
      if (!settings[preference]) {
        await this.notifications.markSuppressed(notification.id);
        this.logger.log(`Notification ${notification.id}: the recipient has opted out`);
        return;
      }
    }

    const payload = await this.withMessageBody(
      notification.templateKey,
      asRecord(notification.payload),
    );

    const message = render(notification.templateKey, payload);
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

    /**
     * The persistent menu, on the messages that can carry it.
     *
     * `reply_markup` holds one thing, so a message with inline buttons cannot
     * also carry the menu. The first version attached it only when there were no
     * inline buttons — and almost every bot message had them, because `opened()`
     * put an open-app button on nearly every template. The menu therefore almost
     * never went out, which is how it was reported as missing, and `BOT_WELCOME`
     * had to be special-cased to force it.
     *
     * The open-app buttons are gone now, so the condition finally means what it
     * says: what is left with inline buttons is the handful of messages with
     * something to *decide* — accept, reject, close, share — and every other
     * message carries the menu. The welcome no longer needs an exception, since
     * it no longer has a keyboard to lose.
     *
     * The menu persists on the client between them, so re-attaching it is belt
     * and braces for a client that missed the first one.
     */
    /**
     * The moderation button, for the accounts that have one (ADR-0018).
     *
     * Only asked when a menu is actually going out — a message with inline
     * buttons carries no menu, `reply_markup` holding one thing, so there is
     * nothing to decide and no reason to spend a query deciding it.
     */
    const menu =
      message.keyboard === undefined
        ? menuKeyboard(await this.adminTelegram.isLinked(notification.telegramUserId))
        : undefined;

    const outcome = await this.telegram.send(
      notification.telegramUserId,
      message.text,
      message.keyboard,
      { parseMode: 'HTML', menu },
    );

    switch (outcome.kind) {
      case 'SENT':
        await this.notifications.markSent(notification.id, outcome.messageId);
        /**
         * The message a wizard now lives on (ADR-0017).
         *
         * **Without this a wizard is a transcript, not a screen.** `paint` edits
         * `conversation_state.last_message_id` when it is set and sends a fresh
         * message when it is null — and nothing set it, so it stayed null and
         * every step sent a new message. In production that filled the chat with
         * old keyboards, and tapping one of those sent a callback for a step the
         * user had long since left, which the current step then refused with a
         * message about the wrong field entirely.
         *
         * It is recorded here rather than by the API because the message id does
         * not exist until Telegram has accepted the send, and this is the only
         * place that holds it.
         */
        if (notification.templateKey === TEMPLATES.BOT_WIZARD) {
          await this.conversations.rememberMessage(notification.userId, outcome.messageId);
        }
        return;

      case 'BLOCKED':
        await this.notifications.markUndeliverable(notification.id, notification.userId);
        this.logger.log(`Notification ${notification.id}: recipient has blocked the bot`);
        return;

      case 'RETRY':
      case 'RATE_LIMITED':
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
   * Redraw the message a conversation wizard lives on (ADR-0017).
   *
   * ── Why the fallback is here and not in the client ──────────────────────────
   *
   * When the message is `GONE` — deleted by the user, or past the 48 hours
   * Telegram allows an edit within — the wizard has nowhere to draw and the only
   * recovery is a fresh message. That needs a second Telegram call *and* a write
   * back to `conversation_state.last_message_id`, so it belongs to the processor
   * that already has both. A wizard that dead-ends because somebody tidied their
   * chat is a form they can neither finish nor restart.
   *
   * The payload carries the internal `user_id`; the chat id is resolved here, so
   * no Telegram identifier is ever written to Redis (invariant 7). Nothing below
   * logs one either — the messages name an outcome and nothing else.
   */
  private async onEditMessage(job: Job): Promise<void> {
    const data = job.data as {
      messageId?: number;
      userId?: string;
      text?: string;
      keyboard?: InlineKeyboard;
    };
    if (data.userId === undefined || data.messageId === undefined || data.text === undefined) {
      return;
    }

    const target = await this.notifications.telegramTargetFor(data.userId);
    // No account, or the bot is blocked: there is nobody to redraw for, and
    // retrying would burn rate budget other users' notifications need.
    if (target === null || target.botBlocked) return;

    const outcome = await this.telegram.editMessage(
      target.telegramUserId,
      data.messageId,
      data.text,
      data.keyboard,
    );

    if (outcome.kind === 'EDITED') return;

    if (outcome.kind === 'GONE') {
      const sent = await this.telegram.send(target.telegramUserId, data.text, data.keyboard);
      if (sent.kind === 'SENT') {
        await this.conversations.rememberMessage(data.userId, sent.messageId);
      }
      this.logger.log('A wizard message was gone; drew a new one');
      return;
    }

    if (outcome.kind === 'BLOCKED') {
      this.logger.log('A wizard message could not be redrawn: the bot is blocked');
      return;
    }

    // RETRY and RATE_LIMITED: let BullMQ's backoff have it.
    throw new Error(`Could not redraw a wizard message: ${outcome.reason}`);
  }

  /**
   * Remove the user's own message once a wizard has read it.
   *
   * The mirror of `onEditMessage`, and deliberately the quieter of the two: it
   * resolves the chat the same way — through `telegramTargetFor`, so no Telegram
   * identifier is ever written to Redis (invariant 7) — and then **never
   * throws**. A message that could not be deleted is a message the user still
   * sees, which is untidy; a job that retried it would spend the global rate
   * limiter's headroom on tidiness while somebody watches a spinner.
   */
  private async onDeleteMessage(job: Job): Promise<void> {
    const data = job.data as { messageId?: number; userId?: string };
    if (data.userId === undefined || data.messageId === undefined) return;

    const target = await this.notifications.telegramTargetFor(data.userId);
    if (target === null || target.botBlocked) return;

    await this.telegram.deleteMessage(target.telegramUserId, data.messageId);
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
        // …and then ask whether the drain actually kept up (M22 phase 7).
        await this.checkOutboxHealth();
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

      case JOBS.CAMPAIGN_DISPATCH: {
        await this.onCampaignDispatch();
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

      /** Conversation drafts past their seven days (ADR-0017 §3). */
      case JOBS.CONVERSATION_PURGE: {
        const removed = await this.conversations.purgeExpired();
        if (removed > 0) {
          this.logger.log(`Conversation purge: removed ${String(removed)} expired draft(s)`);
        }
        return;
      }

      /**
       * Does the ledger still add up? (M22 phase 7)
       *
       * ADR-0007 makes `coin_account.balance` a cache of `SUM(coin_ledger.amount)`,
       * and until now that invariant was asserted by tests and by nobody in
       * production. A drift means one of three things — a write that bypassed
       * `CoinService`, a partially-applied transaction, or manual `psql` — and all
       * three are things somebody needs to know about tonight rather than when a
       * user disputes a balance.
       *
       * Deliberately **read-only**. Nothing here corrects a drift: an automatic
       * "fix" would either overwrite a balance a user is holding or write a
       * plug entry into an append-only ledger, and choosing between those is a
       * judgement call with money attached. The job's whole job is to notice.
       */
      case JOBS.LEDGER_RECONCILE: {
        const drift = await this.coins.findDrift();
        if (drift.length === 0) {
          // Logged even when clean, for the same reason the purge is: a sweep that
          // silently stopped running looks exactly like one that finds nothing.
          this.logger.log('Ledger reconciliation: no drift');
          return;
        }

        this.logger.error(`Ledger reconciliation: ${String(drift.length)} account(s) drifted`);
        this.alerts.alert('ledger.drift', 'error', 'Coin balances disagree with the ledger', {
          accounts: drift.length,
          // The worst one, as a magnitude. Enough to tell a rounding artefact from
          // a duplicated grant, and no user id — a drift report goes to an
          // operations group, and ADR-0009 does not stop applying because the
          // message is an alert (§3.6 layer 2).
          largestGap: Math.max(...drift.map((row) => Math.abs(row.balance - row.ledger))),
          totalGap: drift.reduce((sum, row) => sum + (row.balance - row.ledger), 0),
          truncated: drift.length >= 20,
        });
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
   * Is the outbox keeping up? (M22 phase 7)
   *
   * Called after every backstop drain, so the question is asked of an outbox that
   * has *just* been given the chance to catch up. A row still sitting there after
   * that is not a burst — it is a row the relay keeps failing on, and because the
   * drain takes the oldest first, one stuck row blocks everything behind it.
   *
   * This is the "critical health incident" the alerting requirement names. It is
   * the one failure in the system with no user-visible symptom: nobody complains
   * about a notification they were never told existed, so the only way anyone
   * finds out is if the software says so.
   *
   * Age rather than count, for the reason `backlog()` gives. `alert()` throttles
   * on the key, so a genuinely stuck relay reports once and then stays quiet
   * rather than sending a message every five minutes for a week.
   */
  private async checkOutboxHealth(): Promise<void> {
    const backlog = await this.relay.backlog();
    if (backlog.oldestAgeMs === null || backlog.oldestAgeMs < OUTBOX_STALE_MS) return;

    this.logger.error(
      `Outbox backlog: ${String(backlog.pending)} pending, oldest ` +
        `${String(Math.round(backlog.oldestAgeMs / 60_000))}m old`,
    );
    this.alerts.alert('outbox.stale', 'error', 'The outbox is not draining', {
      pending: backlog.pending,
      oldestMinutes: Math.round(backlog.oldestAgeMs / 60_000),
      // No ids and no payloads: an outbox row's payload is the notification's, and
      // a notification is about a named person doing something (ADR-0009). The
      // count and the age are what an operator acts on anyway.
    });
  }

  /**
   * Turn confirmed campaigns into individual send jobs (M22 phase 4).
   *
   * Bounded per pass. A four-thousand-recipient broadcast becomes four thousand
   * queued jobs eventually, and building all of them in one tick would put four
   * thousand entries into Redis before the limiter has released the first — which
   * is a memory spike for no gain, since the limiter is what decides throughput.
   *
   * Nothing is mutated to "claim" a recipient. The BullMQ job id is derived from
   * the recipient row, so a second pass over the same rows re-adds ids that already
   * exist and BullMQ ignores them. That is the first of the two idempotency layers;
   * the row's own `PENDING → terminal` transition is the second.
   */
  private async onCampaignDispatch(): Promise<void> {
    const campaigns = await this.messaging.claimSendingCampaigns();

    for (const campaign of campaigns) {
      const pending = await this.messaging.pendingDeliveries(campaign.id, DISPATCH_BATCH);

      for (const delivery of pending) {
        await this.queues.enqueue(
          QUEUES.TELEGRAM_SEND,
          JOBS.CAMPAIGN_SEND,
          jobId('campaign', delivery.recipientId),
          { recipientId: delivery.recipientId, campaignId: delivery.campaignId },
        );
      }

      if (pending.length === 0) {
        // Nothing left to enqueue. Whether that means "finished" depends on what
        // the send jobs did, which `finalizeIfDone` reads rather than assumes.
        const finished = await this.messaging.finalizeIfDone(campaign.id);
        if (finished) this.logger.log(`Campaign ${campaign.publicId} finished`);
      } else {
        // Keep the panel's tally moving while a long broadcast drains, so an
        // operator watching it sees progress rather than a number that jumps at
        // the end.
        await this.messaging.refreshCounts(campaign.id);
      }
    }
  }

  /**
   * One recipient of one campaign.
   *
   * The outcomes are the same four `onSend` handles and are recorded differently,
   * because a campaign has to be able to report them separately afterwards:
   *
   *  - **SENT** records the Telegram message id.
   *  - **BLOCKED** is terminal and not a failure. There is nobody to deliver to,
   *    and retrying a block burns the budget other messages need (ADR-0005).
   *  - **RATE_LIMITED** stays pending and throws, so BullMQ backs off — and
   *    increments the campaign's breaker. Past the threshold the campaign pauses
   *    itself rather than pushing on, because a 429 that survived `auto-retry` and
   *    the global limiter is Telegram asking us to stop.
   *  - **RETRY** stays pending and throws.
   *
   * A recipient the campaign no longer wants — cancelled, paused, or already
   * resolved — comes back null from `loadDelivery` and this returns without
   * sending. That is what makes cancel mean something for a job already sitting in
   * Redis.
   */
  private async onCampaignSend(job: Job): Promise<void> {
    const data = job.data as { recipientId?: string; campaignId?: string };
    if (data.recipientId === undefined || data.campaignId === undefined) return;

    const target = await this.messaging.loadDelivery(data.recipientId);
    if (!target) return;

    if (target.telegramUserId === null || target.botBlocked) {
      await this.messaging.recordDelivery(data.recipientId, { status: 'INVALID' });
      await this.invitations.recordInvitationOutcome(data.campaignId, target.userId, 'INVALID');
      return;
    }

    const outcome = await this.telegram.send(target.telegramUserId, target.bodyText, undefined, {
      parseMode: target.parseMode,
    });

    switch (outcome.kind) {
      case 'SENT':
        this.rateLimitStreak.delete(data.campaignId);
        await this.messaging.recordDelivery(data.recipientId, {
          status: 'SENT',
          telegramMessageId: outcome.messageId,
        });
        await this.invitations.recordInvitationOutcome(data.campaignId, target.userId, 'SENT');
        return;

      case 'BLOCKED':
        await this.messaging.recordDelivery(data.recipientId, {
          status: 'BLOCKED',
          error: outcome.reason,
        });
        await this.invitations.recordInvitationOutcome(data.campaignId, target.userId, 'BLOCKED');
        return;

      case 'RATE_LIMITED': {
        await this.messaging.recordAttempt(data.recipientId, outcome.reason);
        await this.onRateLimited(data.campaignId, outcome.reason);
        throw new Error(outcome.reason);
      }

      case 'RETRY': {
        await this.messaging.recordAttempt(data.recipientId, outcome.reason);
        // A send that has run out of attempts is a failure this recipient keeps,
        // rather than a row that stays PENDING forever and stops the campaign
        // finalising.
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await this.messaging.recordDelivery(data.recipientId, {
            status: 'FAILED',
            error: outcome.reason,
          });
          await this.invitations.recordInvitationOutcome(data.campaignId, target.userId, 'FAILED');
          return;
        }
        throw new Error(outcome.reason);
      }
    }
  }

  /**
   * The circuit breaker.
   *
   * In memory, per campaign, for the reason `TelegramLoggerService` keeps its
   * throttle in memory: this is a property of the run rather than of a row, there
   * is one worker, and a breaker that needs a network round trip to decide whether
   * the network is angry is not a breaker. A restart resets it, which is the right
   * default — a fresh process should try again.
   *
   * Pausing rather than cancelling: the campaign keeps its pending recipients and
   * an operator resumes it once Telegram has calmed down. Cancelling would throw
   * away the remaining audience over what may be a five-minute problem.
   */
  private async onRateLimited(campaignId: string, reason: string): Promise<void> {
    const streak = (this.rateLimitStreak.get(campaignId) ?? 0) + 1;
    this.rateLimitStreak.set(campaignId, streak);

    this.metrics.counter(
      'payetam_campaign_rate_limited_total',
      'Campaign deliveries refused by Telegram with 429.',
      {},
    );

    if (streak < RATE_LIMIT_BREAKER_THRESHOLD) return;

    await this.messaging.pause(campaignId, `rate limited ${String(streak)} times in a row`);
    this.rateLimitStreak.delete(campaignId);

    // Keyed on the campaign, so a paused one alerts once rather than once per
    // recipient still in flight.
    this.alerts.alert(`campaign-paused:${campaignId}`, 'error', 'A campaign paused itself', {
      campaignId,
      reason,
      threshold: RATE_LIMIT_BREAKER_THRESHOLD,
    });
    this.logger.error(`Campaign ${campaignId} paused after repeated rate limits`);
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
    let sent = 0;
    let failed = 0;
    let lastReason: string | null = null;

    for (const target of await this.channel.findTakedowns()) {
      const removed = await this.telegram.deleteChannelPost(target.telegramMessageId);
      if (removed) await this.channel.markTakenDown(target.postId);
    }

    /**
     * Paid claims first, and never released on failure (M22 phase 5).
     *
     * A VIP or trending claim is re-derivable from `is_vip` and `request_count`,
     * so a failed send deletes it and the next pass re-claims. A **paid** claim is
     * the record that somebody spent fifteen coins; deleting it would lose the
     * purchase, so it stays and is retried until Telegram accepts it.
     *
     * First, because a host who paid should not queue behind the trending sweep.
     */
    const paid = await this.channel.findUnpostedPaid();

    for (const post of [...paid, ...(await this.channel.claimPending())]) {
      // Text and keyboard together, from one renderer: a post whose button linked
      // to a different event than its body is the failure two call sites invite.
      const rendered = renderChannelPost({
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
      });
      const outcome = await this.telegram.postToChannel(rendered.text, rendered.keyboard);

      if (outcome.kind === 'SENT') {
        await this.channel.markPosted(post.postId, outcome.messageId);
        this.metrics.counter(
          'payetam_channel_post_total',
          'Channel publication attempts by outcome.',
          { outcome: 'sent' },
        );
        sent += 1;
      } else {
        // Paid claims are never released — see the note above `paid`.
        if (post.kind !== 'PAID') await this.channel.releaseClaim(post.postId);
        this.metrics.counter(
          'payetam_channel_post_total',
          'Channel publication attempts by outcome.',
          { outcome: 'failed' },
        );
        failed += 1;
        lastReason = outcome.reason;
        this.logger.warn(`Channel post for ${post.eventPublicId} failed: ${outcome.reason}`);
      }
    }

    this.reportChannelHealth(sent, failed, lastReason);
  }

  /**
   * Escalates a channel that has stopped working, instead of leaving it as warnings.
   *
   * The failure this exists for is a configuration one — the bot was never made an
   * admin, or `TELEGRAM_CHANNEL_ID` is wrong — and `postToChannel` already classifies
   * it as retryable rather than terminal, so it retries forever and every individual
   * warning looks survivable. Somebody paid coins for each of those posts.
   *
   * The threshold is deliberately small: three consecutive sweeps is fifteen minutes,
   * which is long enough not to fire on one bad minute and short enough that a launch
   * misconfiguration is loud the same hour. The metric carries the same fact for
   * anything scraping `/metrics`.
   */
  private reportChannelHealth(sent: number, failed: number, lastReason: string | null): void {
    if (failed === 0) {
      this.consecutiveChannelFailures = 0;
      return;
    }
    if (sent > 0) return; // A partial failure is a per-post problem, not a stuck channel.

    this.consecutiveChannelFailures += 1;
    this.metrics.counter(
      'payetam_channel_sweep_failed_total',
      'Channel sweeps in which every publication attempt failed.',
      {},
    );

    if (this.consecutiveChannelFailures >= CHANNEL_FAILURE_ALERT_THRESHOLD) {
      // The reason is the client's own classification, which never contains the
      // channel id or the token — those are configuration, and this line is read by
      // whoever operates the deployment.
      this.logger.error(
        `Channel publishing has failed ${String(this.consecutiveChannelFailures)} sweeps in a row ` +
          `(${String(failed)} post(s) pending). Last reason: ${lastReason ?? 'unknown'}. ` +
          'Check that TELEGRAM_CHANNEL_ID is set and the bot is an administrator of that channel.',
      );
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
