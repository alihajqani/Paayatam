import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Env } from '@payetam/config';
import {
  CatalogService,
  ChannelMembershipService,
  ChatService,
  ConsentService,
  CoinService,
  ConversationService,
  DiscoveryService,
  EventLifecycleService,
  EventService,
  GiftCodeService,
  InvitationService,
  ReportService,
  UserSettingsService,
  NotificationService,
  ParticipationService,
  ProfileService,
  ReferralService,
  ReviewService,
  asCreateEventForm,
  categoryChoice,
  eventChoice,
  touchedFields,
  genderLabel,
  reviewTagLabel,
  reportReasonLabelFa,
  adminDecisionLabelFa,
  zonedTimeToUtc,
  type ConversationSnapshot,
  type CreateEventInput,
  type EditEventForm,
  type EditProfileForm,
  type WriteReviewForm,
  type FileReportForm,
  type UpdateEventInput,
  type ConversationOutcome,
  type CreateEventForm,
  type WizardDeps,
  type WizardInput,
  SettingsService,
  TrustService,
  UserService,
  AdminOperationsService,
  AdminTelegramService,
  type AdminCaseForm,
  type AdminSession,
} from '@payetam/domain';
import {
  ENV,
  JOBS,
  QUEUES,
  QueueService,
  RATE_LIMITS,
  RateLimitService,
  jobId,
} from '@payetam/platform';
import { AppError, ERROR_MESSAGES_FA, ErrorCode, type CostType } from '@payetam/shared';
import {
  TEMPLATES,
  describeFilters,
  discoverCategoryRows,
  discoverFilterRows,
  formatDiscovered,
  formatEventDetail,
  formatParticipants,
  encodeChatCallback,
  parseDiscoverCallback,
  formatJalali,
  formatPolicies,
  formatReceivedReviews,
  formatReferral,
  formatSettings,
  settingsRows,
  parseAdminCallback,
  parseSettingCallback,
  parseStartPayload,
  adminQueueRows,
  formatAdminCasePrompt,
  formatAdminQueue,
  isNotificationField,
  MODERATION_MENU_COMMAND,
  SETTING_FIELDS,
  SETTING_LANGUAGE,
  SETTING_PRIVACY,
  SETTING_PROFILE,
  formatStanding,
  formatTrust,
  formatWallet,
  menuCommandFor,
  formatTehran,
  formatMyChats,
  formatPendingReviews,
  formatMyEvents,
  formatMyRequests,
  parseChatCallback,
  parseEventCallback,
  encodeEventCallback,
  parseReviewCallback,
  encodeReviewCallback,
  parseReportCallback,
  encodeReportAsk,
  encodeReportReason,
  reportPrompt,
  REPORT_REASON_CHOICES,
  REPORT_TARGETS,
  REVIEW_RATINGS,
  isPublicId,
  isoDay,
  parseIsoDay,
  encodeWizardCallback,
  parseWizardCallback,
  renderStep,
  renderSummary,
  tehranToday,
  toPersianDigits,
  type BotInboundText,
  type BotSender,
  type EventCallback,
  type DiscoverFilters,
  type DiscoverWhen,
  type ReportCallback,
  type ReportTargetLetter,
  type ReportReasonValue,
  type AdminCallback,
  type ParsedUpdate,
  type SettingCallback,
  type StartLink,
  type SummaryLine,
  type WizardScreen,
} from '@payetam/telegram';

/**
 * What a reply interpolates.
 *
 * JSON scalars only, and stated as a type rather than as `Record<string, unknown>`
 * with a cast at the Prisma boundary: a notification payload is rendered into a
 * message body, so the shape that reaches it should be the shape a template can
 * read (invariant 7 — public ids and numbers, never an object somebody spread).
 */
type ReplyPayload = Record<string, string | number | boolean>;

/** The sender, resolved. Both ids, because the rate limiter is keyed on the public one. */
interface BotUser {
  id: string;
  publicId: string;
  /**
   * The sender's Telegram id, carried so a handler can ask whether they are a
   * linked moderator (ADR-0018).
   *
   * **It never leaves this process.** Invariant 7 says `telegram_user_id` does
   * not appear in an API response, a log line or a frontend bundle, and nothing
   * below puts it in one — `reply` and the wizard jobs carry the *internal*
   * `user_id` and the worker resolves the Telegram id at delivery, exactly as
   * notifications do.
   */
  telegramUserId: bigint;
}

/**
 * The bot's receiving half (plan §6: `/start`, `callback_query`, `message:text`,
 * `edited_message`, `my_chat_member`).
 *
 * Outstanding since M2 named `/start` in its acceptance criteria, and deferred with
 * a note in M13: *"M13 builds the outbound half… The inbound half needs a webhook
 * handler wired to grammY, and M8's release gate therefore remains open."* This is
 * that handler.
 *
 * Three properties shape everything below.
 *
 * **It calls the same services the Mini App does.** Nothing here decides who may
 * accept a request, whether a chat is live, or whether a phone number is masked —
 * `ParticipationService` and `ChatService` do, and a rule enforced in one surface
 * protects one surface. That is what makes plan §3.3's "the bot and the Mini App
 * behave identically" true by construction rather than by two implementations being
 * kept in step.
 *
 * **It never calls Telegram.** Every reply is a row plus an enqueue, which is
 * ADR-0004's "validate, persist, enqueue" and ADR-0005's "all outbound Telegram
 * calls happen in the worker". A reply sent from here would also bypass the global
 * rate limiter, and that limiter's headroom is what keeps a notification backlog
 * from starving somebody who is watching a spinner.
 *
 * **A reply is a `notification` row.** Not a fire-and-forget send: it is deduped by
 * a UNIQUE index on a key derived from Telegram's own `update_id`, so a redelivered
 * update produces one message; it goes out through the same renderer, the same rate
 * limiter and the same block detection as every other message; and it answers "did
 * we tell them?" six weeks later, which a log line cannot.
 */
@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly users: UserService,
    private readonly chats: ChatService,
    private readonly coins: CoinService,
    private readonly events: EventService,
    private readonly discovery: DiscoveryService,
    private readonly participation: ParticipationService,
    private readonly profiles: ProfileService,
    private readonly trust: TrustService,
    private readonly reviews: ReviewService,
    private readonly conversations: ConversationService,
    private readonly catalog: CatalogService,
    private readonly consent: ConsentService,
    private readonly membership: ChannelMembershipService,
    @Inject(ENV) private readonly env: Env,
    private readonly referrals: ReferralService,
    private readonly giftCodes: GiftCodeService,
    private readonly invitations: InvitationService,
    private readonly reports: ReportService,
    private readonly userSettings: UserSettingsService,
    private readonly lifecycle: EventLifecycleService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationService,
    private readonly queues: QueueService,
    private readonly limiter: RateLimitService,
    /**
     * The moderation queue in the bot (ADR-0018).
     *
     * Two services, and the split is the security boundary. `AdminTelegramService`
     * answers *who is asking* — and answers null for almost everybody.
     * `AdminOperationsService` answers *may they do this*, in the service layer,
     * which is invariant 12 and is why this class holds no permission check of
     * its own beyond having a session at all.
     */
    private readonly adminTelegram: AdminTelegramService,
    private readonly admins: AdminOperationsService,
  ) {}

  /**
   * Handle one update.
   *
   * Every failure is caught here. The webhook answers 200 by contract (ADR-0004),
   * so a throw escaping this method would become an unhandled rejection and nothing
   * else — and an `AppError` is not a bug in any case: it is the product refusing
   * something, and the refusal has already been relayed in Persian by whoever
   * caught it closer to the action.
   */
  async dispatch(update: ParsedUpdate): Promise<void> {
    try {
      await this.route(update);
    } catch (error) {
      if (error instanceof AppError) {
        this.logger.log(`Update ${String(update.updateId)} refused: ${error.code}`);
        return;
      }
      // The message is logged; the update is not. It carries a Telegram id and a
      // message body, and neither belongs in a log line (invariant 7, T15).
      this.logger.error(
        `Update ${String(update.updateId)} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async route(update: ParsedUpdate): Promise<void> {
    const intent = update.intent;

    switch (intent.kind) {
      // `/start` is the one surface that may *create* an account, which is what
      // makes it the only entry point: everything else requires having met.
      case 'START':
        return this.onStart(update.updateId, intent.from, intent.payload);

      case 'BLOCK_CHANGED':
        // No reply, for the obvious reason. The flag is what stops the sender
        // retrying against somebody who is gone; unblocking clears it, and so does
        // any later `/start`.
        await this.users.markBotBlocked(intent.from.telegramUserId, intent.blocked);
        return;

      case 'CALLBACK':
        return this.onCallback(update, intent.from, intent.callbackQueryId, intent.data);

      default: {
        const user = await this.knownUser(intent.from);
        if (user === null) return;

        switch (intent.kind) {
          case 'TEXT':
            return this.onText(update.updateId, user, intent.message, intent.replyToMessageId);

          case 'EDITED_TEXT':
            return this.onEdit(update.updateId, user, intent.message);

          /** Criterion 11, through the bot: a Persian refusal, and nothing stored. */
          case 'UNSUPPORTED':
            return this.notice(
              update.updateId,
              user,
              ERROR_MESSAGES_FA[ErrorCode.CHAT_MEDIA_UNSUPPORTED],
            );

          case 'COMMAND':
            return this.onCommand(update.updateId, user, intent.command, intent.argument);
        }
      }
    }
  }

  /**
   * A recognised `/command`.
   *
   * **Read-only and single-turn, and that is the boundary rather than a stage.**
   * The bot answers a question whose answer is one number or one paragraph; a
   * command that needed several turns would need per-user conversation state,
   * and this handler deliberately holds none — there is nowhere for a half-typed
   * event to live, which is what keeps a redelivered update idempotent.
   *
   * Everything with a form in it stays in the Mini App. `/help` says so plainly,
   * because a bot that silently cannot do something is worse than one that says
   * where the thing is done.
   *
   * An unknown command now points at `/help` rather than at `/start`. Sending
   * somebody back to the welcome message told them nothing they had not already
   * read.
   */
  private async onCommand(
    updateId: number,
    user: BotUser,
    command: string,
    /** Whatever followed the command name, trimmed. Only `/gift` reads it. */
    argument: string | null = null,
  ): Promise<void> {
    switch (command.toLowerCase()) {
      case 'help':
        return this.reply(updateId, user.id, TEMPLATES.BOT_HELP, {});

      case 'balance': {
        const balance = await this.coins.balanceOf(user.id);
        return this.reply(updateId, user.id, TEMPLATES.BOT_BALANCE, { balance });
      }

      /**
       * `/wallet` — the balance, and where it came from.
       *
       * `/balance` answers "how many" and has since M13; it does not answer
       * "why is it that number", which is what somebody asks the moment it
       * moves. The ledger lived only in `WalletView`, so the bot could state a
       * balance and not account for it — and ADR-0007's «a balance nobody can
       * account for is a balance nobody can appeal» is about coins as much as
       * the Trust Score.
       *
       * Twenty rather than the service's default fifty: a digest is one Telegram
       * message, and `buildDigest` would drop the tail of fifty anyway with a
       * line about what did not fit.
       */
      case 'wallet': {
        const [balance, history] = await Promise.all([
          this.coins.balanceOf(user.id),
          this.coins.historyOf(user.id, WALLET_HISTORY_LIMIT),
        ]);
        return this.reply(updateId, user.id, TEMPLATES.BOT_WALLET, {
          text: formatWallet(balance, history),
        });
      }

      /**
       * `/myreviews` — what other people wrote about you.
       *
       * The bot could rate somebody from v0.5.0 and could not show you a word
       * anybody had written about *you*: `ReviewsView` held received reviews and
       * v0.4.6 removed the last button to it. So a Trust Score moved for reasons
       * its owner could read nowhere — the same complaint ADR-0007 makes about a
       * score with no ledger, one level up.
       *
       * `listForUser` takes the **reviewee's public id**, and the caller's own is
       * the one thing this handler can pass without asking. Invariant 8 is the
       * service's: a review appears only once its pair has revealed, filtered on
       * the pair's status rather than the review's.
       *
       * Who wrote it is never shown, and not by omission — `RevealedReview`
       * carries no author, because the double blind is what a pair is for.
       */
      case 'myreviews': {
        const received = await this.reviews.listForUser(user.publicId, RECEIVED_REVIEW_LIMIT);
        const text = formatReceivedReviews(
          received.map((row) => ({
            rating: row.rating,
            tags: row.tags,
            comment: row.comment,
            submittedAt: row.submittedAt,
            withoutCounterpart: row.withoutCounterpart,
          })),
          reviewTagLabel,
        );

        /**
         * A report button per review — the target letter reserved in v0.5.7.
         *
         * `POST /reviews/:publicId/report` has existed since M12 and the bot had
         * nothing to report *from*. Two per row: the labels are short and a
         * column of them under a list of reviews reads as a wall.
         */
        const reportable = received.filter((row) => isPublicId(row.publicId));
        const buttons = reportable.map((row, index) => ({
          text: `${toPersianDigits(String(index + 1))} 🚩`,
          callbackData: encodeReportAsk('v', row.publicId),
        }));
        const rows: { text: string; callbackData: string }[][] = [];
        for (let index = 0; index < buttons.length; index += 2) {
          rows.push(buttons.slice(index, index + 2));
        }

        return this.reply(updateId, user.id, TEMPLATES.BOT_RECEIVED_REVIEWS, {
          text,
          ...(rows.length > 0 ? { keyboard: JSON.stringify(rows) } : {}),
        });
      }

      /**
       * The settings board.
       *
       * Reached from the persistent menu, which is the whole point: a settings
       * screen nobody can find is one nobody uses. `/settings` exists as a
       * fallback for somebody who types it, and the menu label maps to the same
       * command through `MENU_COMMANDS`.
       */
      case 'settings':
        return this.drawSettings(updateId, user);

      /**
       * `/trust` — the score, and how it got there.
       *
       * `/profile` has shown the number since v0.4.x, and ADR-0007's «a score
       * nobody can account for is a score nobody can appeal» has been true the
       * whole time. The Mini App never rendered the ledger either — `GET
       * /me/trust` returned it and no view used it — so this is less a port than
       * the first place the product keeps that promise.
       *
       * A row never names *who*. A `REVIEW` movement means "a review moved
       * this"; naming the reviewer would undo the double-blind the review pair
       * exists to hold.
       */
      case 'trust': {
        const [score, history] = await Promise.all([
          this.trust.scoreOf(user.id),
          this.trust.historyOf(user.id, TRUST_HISTORY_LIMIT),
        ]);
        return this.reply(updateId, user.id, TEMPLATES.BOT_TRUST, {
          text: formatTrust(score, history),
        });
      }

      /**
       * `/referral` — the caller's code, and what it has earned.
       *
       * The bot is one step shorter than the screen this replaces: a referral
       * code is shared *in Telegram*, `HomeView` rendered it to be copied and
       * pasted into a chat the user was already in, and the ready-made
       * `?start=<code>` link is what people actually send. `/start` claims it,
       * so the whole loop closes inside one application.
       */
      case 'referral': {
        const summary = await this.referrals.summaryFor(user.id);
        return this.reply(updateId, user.id, TEMPLATES.BOT_REFERRAL, {
          text: formatReferral(
            {
              code: summary.code,
              invited: summary.invited,
              qualified: summary.qualified,
              coinsEarned: summary.coinsEarned,
            },
            // Optional in the environment, and the link is the point of this
            // message — so an unconfigured username degrades to the bot's own
            // handle rather than to `https://t.me/undefined?start=…`.
            this.env.TELEGRAM_BOT_USERNAME ?? 'paayatambot',
          ),
        });
      }

      /**
       * `/gift <code>` — redeem a gift or discount code.
       *
       * The first command to take an argument. `parseUpdate` matched one and
       * threw it away for everything but `/start`, so a code had nowhere to
       * ride; it is carried now, which is a smaller change than a wizard whose
       * only step is "type the code".
       *
       * The code is **not** echoed back on failure. It may be a campaign code
       * somebody was given privately, and a bot repeating it into a chat that
       * may be screenshotted is a disclosure the Mini App's form never made.
       */
      case 'gift': {
        if (argument === null) {
          return this.notice(updateId, user, 'کد را همراه دستور بفرستید — مثال: /gift ABCD1234');
        }
        if (!(await this.mayWrite(updateId, user))) return;
        try {
          const redeemed = await this.giftCodes.redeem(user.id, argument);
          return this.notice(
            updateId,
            user,
            `کد پذیرفته شد ✅\n\n${toPersianDigits(String(redeemed.coins))} سکه به حساب شما اضافه شد. ` +
              `موجودی: ${toPersianDigits(String(redeemed.balance))} سکه`,
          );
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          return this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
        }
      }

      /**
       * The digest is rendered now and stored as text, not assembled at delivery.
       * `formatMyRequests` lives in `@payetam/telegram` so the Persian stays with
       * every other message body rather than growing here.
       */
      case 'requests': {
        const mine = await this.participation.listMine(user.id);
        const text = formatMyRequests(
          mine.map((row) => ({
            title: row.event.title,
            startsAt: row.event.startsAt,
            status: row.status,
            waitlistRank: row.waitlistRank,
          })),
        );
        /**
         * «لغو» on the requests that can still be stood down from.
         *
         * PENDING and WAITLISTED only: `cancel` refuses anything else, and a
         * button that exists to be refused is worse than no button. ACCEPTED is
         * deliberately not cancellable from here — standing somebody up after
         * they have counted on you is a conversation, and `/chats` is where it
         * happens.
         */
        const cancellable = mine.filter(
          (row) =>
            (row.status === 'PENDING' || row.status === 'WAITLISTED') && isPublicId(row.publicId),
        );
        const buttons = cancellable.map((row) => ({
          text: `${toPersianDigits(String(mine.indexOf(row) + 1))} لغو`,
          callbackData: encodeEventCallback('cancel', row.publicId),
        }));
        const rows: { text: string; callbackData: string }[][] = [];
        for (let index = 0; index < buttons.length; index += 2) {
          rows.push(buttons.slice(index, index + 2));
        }

        return this.reply(updateId, user.id, TEMPLATES.BOT_REQUESTS, {
          text,
          ...(rows.length > 0 ? { keyboard: JSON.stringify(rows) } : {}),
        });
      }

      case 'myevents': {
        const owned = await this.events.listOwned(user.id);
        const text = formatMyEvents(
          owned.map((event) => ({
            title: event.title,
            startsAt: event.startsAt,
            status: event.status,
            acceptedCount: event.acceptedCount,
            capacity: event.capacity,
          })),
        );
        /**
         * A host console, not a list.
         *
         * Publishing to the channel, inviting likely guests and cancelling all
         * lived in `MyEventsView`; a host using the bot could see their
         * activities and do nothing to them. One row per event, in the digest's
         * order, and only for the ones the action is legal on — a button that
         * exists to be refused is worse than no button.
         */
        const actionable = owned.filter(
          (event) => isPublicId(event.publicId) && OPEN_EVENT_STATUSES.has(event.status),
        );
        const rows = actionable.map((event) => [
          { text: '👥 مهمان‌ها', callbackData: encodeEventCallback('who', event.publicId) },
          { text: '📣 کانال', callbackData: encodeEventCallback('post', event.publicId) },
          { text: '🚀 ارتقا', callbackData: encodeEventCallback('boost', event.publicId) },
          { text: '👥 دعوت', callbackData: encodeEventCallback('invite', event.publicId) },
          { text: '✖️ لغو', callbackData: encodeEventCallback('drop', event.publicId) },
        ]);

        return this.reply(updateId, user.id, TEMPLATES.BOT_MY_EVENTS, {
          text,
          ...(rows.length > 0 ? { keyboard: JSON.stringify(rows) } : {}),
        });
      }

      /**
       * `/chats` — the other half of the advice `ambiguityAdvice` already gives.
       *
       * The relay tells somebody with two live chats to press *reply* on the
       * message from the person they mean. That assumed they could see which
       * conversations were open and find a message from each — and the only way
       * to find out was to open the Mini App, which is the trip the bot exists
       * to save.
       *
       * `listForUser` is the same read `ChatsView` performs, sorted by the same
       * recency, so the two surfaces answer this question identically rather
       * than similarly.
       */
      case 'chats': {
        const mine = await this.chats.listForUser(user.id);
        const text = formatMyChats(
          mine.map((chat) => ({
            counterpartName: chat.counterpartName,
            eventTitle: chat.eventTitle,
            status: chat.status,
            unreadCount: chat.unreadCount,
          })),
        );
        return this.reply(updateId, user.id, TEMPLATES.BOT_CHATS, { text });
      }

      /**
       * `/profile` — and the only place a user can see their own Trust Score.
       *
       * `GET /me/trust` has existed since M18, but no Mini App view renders the
       * caller's own score: `TrustBadge` is for reading *somebody else's*, on the
       * event page and in a host's queue. So this is not a shortcut to a screen —
       * it is the first surface that answers "what is my score?" at all.
       *
       * A profile that has never been completed has no row, which is a state
       * `/start` leaves somebody in until they finish onboarding. Saying where to
       * finish beats rendering a card of empty fields.
       */
      case 'profile': {
        const profile = await this.profiles.find(user.id);
        /**
         * No profile is a **form**, not a sentence about one.
         *
         * This used to answer «برای تکمیل نمایه برنامه را باز کنید», which was
         * the second half of the loop the profile-creation bug produced: the
         * user had no profile because the wizard could not create one, and the
         * one command that names the problem sent them to an application this
         * release has just finished removing every button to.
         */
        if (profile === null) {
          if (!this.env.ENABLE_CONVERSATION_WIZARD) return this.wizardsOff(updateId, user);
          if (!(await this.mayWrite(updateId, user))) return;
          const outcome = await this.conversations.start(user.id, 'EDIT_PROFILE', updateId);
          return this.drawWizard(updateId, user, outcome);
        }

        const trustScore = await this.trust.scoreOf(user.id);
        return this.reply(updateId, user.id, TEMPLATES.BOT_PROFILE, {
          displayName: profile.displayName,
          cityName: profile.city.nameFa,
          trustScore,
        });
      }

      /**
       * `/discover` — the product's core question, answered without opening it.
       *
       * The city comes from the sender's own profile, which is what makes this
       * single-turn: `DiscoveryQuery` has fourteen filters and asking for even
       * one would mean holding a half-built query between two updates. The
       * ranking, the capacity filter and the visibility rules are all
       * `DiscoveryService`'s — the bot chooses no events, it only renders the
       * ones the same search the Mini App runs returns.
       *
       * Somebody with no profile has no city, and «فعالیتی پیدا نشد» would be a
       * false answer to a question that was never asked properly.
       */
      /**
       * `/discover` — the product's core question, answered without opening it.
       *
       * The city comes from the sender's own profile, which is what makes this
       * single-turn. Since v0.5.9 the *other* filters are in the buttons rather
       * than in a query nobody could build: `DiscoveryQuery` has fourteen
       * fields, three of them fit in a 64-byte callback, and those three are the
       * ones a person actually asks at the door — when, how much, what kind.
       *
       * The ranking, the capacity filter and the visibility rules stay
       * `DiscoveryService`'s. The bot chooses no events; it renders the ones the
       * same search the Mini App runs returns.
       */
      case 'discover':
        return this.discoverWith(updateId, user, { when: 'a', cost: 'a', categoryId: null });

      /**
       * `/reviews` — what the sender still owes, and by when.
       *
       * The deadline is the reason this is worth a command: a pending review
       * *expires*, `settleExpired` closes the pair, and the counterpart simply
       * never gets one. Received reviews are a fact that keeps and stay in
       * `ReviewsView`, which is a page somebody visits deliberately rather than
       * an answer to "what do I owe?".
       */
      case 'reviews': {
        const pending = await this.reviews.listPending(user.id);
        const text = formatPendingReviews(
          pending.map((row) => ({
            revieweeDisplayName: row.revieweeDisplayName,
            eventTitle: row.eventTitle,
            deadlineAt: row.deadlineAt,
          })),
        );
        /**
         * Five ratings per pending review, one row each, in the digest's order.
         *
         * `/reviews` used to be a list of things you owed and could not pay: the
         * form was in the Mini App and v0.4.6 removed the last button to it.
         */
        const rateable = pending.filter((row) => isPublicId(row.participantPublicId));
        const rows = rateable.map((row) =>
          REVIEW_RATINGS.map((rating) => ({
            text: `${toPersianDigits(String(rating))}⭐`,
            callbackData: encodeReviewCallback(rating, row.participantPublicId),
          })),
        );

        return this.reply(updateId, user.id, TEMPLATES.BOT_REVIEWS, {
          text,
          ...(rows.length > 0 ? { keyboard: JSON.stringify(rows) } : {}),
        });
      }

      /**
       * `/create_event` — the form that used to require the Mini App (ADR-0017).
       *
       * Starting *replaces* whatever was in progress rather than refusing:
       * somebody who types this half-way through another form has said what they
       * want, and «شما در حال انجام کار دیگری هستید» is the product arguing about
       * a form only they can see.
       */
      case 'create_event':
      case 'newevent': {
        if (!this.env.ENABLE_CONVERSATION_WIZARD) return this.wizardsOff(updateId, user);
        if (!(await this.mayWrite(updateId, user))) return;
        const outcome = await this.conversations.start(user.id, 'CREATE_EVENT', updateId);
        return this.drawWizard(updateId, user, outcome);
      }

      /**
       * `/edit_profile` — the second wizard, and the one ADR-0017 puts on the
       * critical path: a user who cannot complete a profile cannot do anything,
       * so this has to work before the Mini App can be switched off.
       */
      case 'edit_profile': {
        if (!this.env.ENABLE_CONVERSATION_WIZARD) return this.wizardsOff(updateId, user);
        if (!(await this.mayWrite(updateId, user))) return;
        const outcome = await this.conversations.start(user.id, 'EDIT_PROFILE', updateId);
        return this.drawWizard(updateId, user, outcome);
      }

      /**
       * `/terms` — `TermsView`, as a message.
       *
       * Two audiences and two answers. Somebody who **owes** an acceptance gets
       * the consent gate, which is the screen that can clear it — pointing them
       * at a read-only summary would be showing them the document and no way to
       * agree to it. Somebody who is **up to date** gets what they accepted and
       * when, which is the question a person asks about terms they have already
       * signed.
       */
      /**
       * `/edit_event` — `EditEventView`, as a conversation.
       *
       * The event list is loaded here rather than by the step, for the reason
       * `WizardDeps` does not carry it: "my events" is a per-user read, and
       * putting one into an interface every wizard shares would make every
       * wizard able to perform it.
       */
      case 'edit_event': {
        if (!this.env.ENABLE_CONVERSATION_WIZARD) return this.wizardsOff(updateId, user);
        if (!(await this.mayWrite(updateId, user))) return;

        const owned = await this.events.listOwned(user.id);
        const editable = owned.filter((event) => EDITABLE_EVENT_STATUSES.has(event.status));
        if (editable.length === 0) {
          return this.notice(
            updateId,
            user,
            'فعالیتی برای ویرایش ندارید. با /create_event یکی بسازید.',
          );
        }

        const outcome = await this.conversations.start(user.id, 'EDIT_EVENT', updateId);
        return this.drawWizard(updateId, user, outcome);
      }

      case 'terms': {
        if (!(await this.consent.hasAcceptedCurrentPolicies(user.id))) {
          const outcome = await this.conversations.start(user.id, 'ACCEPT_POLICIES', updateId);
          return this.drawWizard(updateId, user, outcome);
        }

        const standing = await this.consent.standingFor(user.id);

        return this.reply(updateId, user.id, TEMPLATES.BOT_TERMS_STANDING, {
          // Rendered by the package that owns the escaping rule, like every other
          // pre-rendered body. Built here, it interpolated an operator's
          // `title_fa` into a `<b>` tag unescaped — see `formatStanding`.
          text: formatStanding(
            standing.accepted.map((entry) => ({
              title: entry.policy.titleFa ?? entry.policy.label,
              acceptedAt: formatTehran(entry.acceptedAt),
            })),
          ),
        });
      }

      case 'cancel': {
        await this.conversations.clear(user.id);
        return this.notice(updateId, user, 'لغو شد.');
      }

      /**
       * The moderation queue (ADR-0018).
       *
       * **Not in `BOT_COMMANDS`**, and that is the whole design of it. The
       * command list is published to Telegram with `setMyCommands` and rendered
       * by `/help`, both of which every user reads — advertising a staff command
       * to everybody would turn "is there an admin surface?" into a question the
       * bot answers on request. The way in is the menu button, which only a
       * linked moderator's keyboard carries.
       *
       * A non-moderator who guesses the word gets **the unknown-command
       * sentence**, byte for byte. That is deliberate: distinguishing «you are
       * not a moderator» from «no such command» tells a stranger that the
       * command exists, which is the first thing worth knowing about a surface
       * you want to attack.
       */
      case MODERATION_MENU_COMMAND: {
        const session = await this.adminTelegram.sessionFor(user.telegramUserId);
        if (session === null) return this.unknownCommand(updateId, user);
        return this.drawModerationQueue(updateId, user, session);
      }

      default:
        return this.unknownCommand(updateId, user);
    }
  }

  /**
   * The answer to a command this bot does not have.
   *
   * A method rather than a literal because **two** paths must produce it
   * identically: a genuine typo, and `moderate` sent by somebody with no
   * moderator link. If those two ever diverge by a character, the difference is
   * an oracle for whether a staff surface exists.
   */
  private async unknownCommand(updateId: number, user: BotUser): Promise<void> {
    return this.notice(
      updateId,
      user,
      'این فرمان را نمی‌شناسم. برای دیدن فهرست فرمان‌ها /help را بفرستید.',
    );
  }

  /**
   * `/start [payload]` — M2's acceptance criterion: it creates exactly one user.
   *
   * The idempotency is `UserService`'s and it is the database's: two simultaneous
   * taps race to insert against a UNIQUE `telegram_user_id`, and the loser re-reads
   * rather than creating a second account.
   *
   * The payload is a referral code (T6). A failed claim **does not stop the
   * welcome**: somebody arriving on a stale invite link should be greeted by a
   * product rather than by an error, and `ALREADY_REFERRED` — which is what pressing
   * a start link twice produces — is not something to apologise for.
   */
  private async onStart(updateId: number, from: BotSender, payload: string | null): Promise<void> {
    const created = await this.users.findOrCreateByTelegram(from);
    const userId = await this.users.resolveInternalId(created.publicId);
    const user: BotUser = {
      id: userId,
      publicId: created.publicId,
      telegramUserId: from.telegramUserId,
    };

    /**
     * A channel post's button, tried before the referral claim.
     *
     * Told apart by shape rather than by trying each in turn: a referral code is
     * a fixed alphabet with no underscore in it, and `parseStartPayload` answers
     * null for anything that is not `event_<uuid>` or `join_<uuid>`. Attempting
     * the referral claim first would log a refusal for every channel tap.
     */
    if (payload !== null) {
      const link = parseStartPayload(payload);
      if (link !== null) return this.onStartLink(updateId, user, link);
    }

    if (payload !== null) {
      try {
        const claim = await this.referrals.claim(userId, stripReferralPrefix(payload));
        await this.reply(updateId, userId, TEMPLATES.BOT_REFERRAL_ACCEPTED, {
          pendingCoins: claim.pendingCoins,
        });
        return;
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        this.logger.log(`Referral payload on /start was refused: ${error.code}`);
      }
    }

    await this.reply(updateId, userId, TEMPLATES.BOT_WELCOME, {});

    /**
     * The gate, immediately after the welcome (v0.4.2).
     *
     * It used to wait for the first *write* — somebody would read `/help`,
     * browse `/discover`, then be stopped at `/create_event` by a screen they
     * had no reason to expect. Onboarding is the moment to ask: the user has
     * just arrived, has done nothing yet, and the acceptance is what makes
     * everything after it possible.
     *
     * Still a check rather than a step, so it costs nothing for somebody already
     * up to date — a returning user pressing `/start` gets the welcome and
     * nothing else.
     */
    await this.gateAfterWelcome(updateId, user);
  }

  /**
   * A reader arriving from the channel (v0.6.3).
   *
   * ── Why the two actions are not one screen ──────────────────────────────────
   *
   * «مشاهده در ربات» is for somebody deciding and «شرکت می‌کنم» for somebody who
   * has decided. Collapsing them into "open the detail, then press join" would
   * put a screen between a reader and the decision they had already made, which
   * is the detour the second button exists to remove.
   *
   * ── The gate, and the reason joining does not simply refuse ─────────────────
   *
   * `mayWrite` opens the consent wizard where a refused write would have
   * happened, and a brand-new reader from the channel has accepted nothing — so
   * that is the *usual* path here, not the exception. Stopping at the wizard
   * would leave them with an accepted set of policies and no way back to the
   * activity they came for, because the post is in a channel they have now left.
   *
   * So a gated join draws the activity **with its join button** underneath the
   * consent screen. Nothing is remembered — the id is in the button, exactly as
   * it is everywhere else in this bot — and the reader finishes the acceptance
   * and taps once more. A stored "pending join" would be state this surface has
   * spent two releases not keeping.
   *
   * The welcome is sent only to somebody who owes an acceptance, which is the
   * closest this service has to "has not been here before": a returning user
   * tapping a post wants the activity, not an introduction.
   */
  private async onStartLink(updateId: number, user: BotUser, link: StartLink): Promise<void> {
    const consented = await this.consent.hasAcceptedCurrentPolicies(user.id);
    if (!consented) await this.reply(updateId, user.id, TEMPLATES.BOT_WELCOME, {});

    if (link.action === 'join' && consented) {
      try {
        const participation = await this.participation.join(user.id, link.id);
        return this.notice(
          updateId,
          user,
          participation.status === 'WAITLISTED'
            ? 'ظرفیت تکمیل بود، پس در لیست انتظار ثبت شدید ⏳ اگر جایی باز شود خبرتان می‌کنیم.'
            : 'درخواست شما فرستاده شد ✅ منتظر پاسخ میزبان بمانید.',
        );
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        /**
         * The refusal, then the activity itself.
         *
         * A bare «ظرفیت تکمیل است» to somebody who has just arrived from a
         * channel tells them nothing about what they tapped. The detail screen
         * below it is what makes the refusal legible, and it carries the buttons
         * that are still legal — cancelling, reporting, or joining once the
         * reason has passed.
         */
        await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
      }
    }

    await this.drawEventDetail(updateId, user, link.id);
    if (!consented) await this.gateAfterWelcome(updateId, user);
  }

  /**
   * Open the consent gate for a user who owes an acceptance.
   *
   * Separate from `mayWrite` because the two differ in what they do when the
   * gate is *clear*: `mayWrite` returns a verdict its caller acts on, and this
   * simply stops. Folding them would give `onStart` a boolean it has no use for.
   */
  private async gateAfterWelcome(updateId: number, user: BotUser): Promise<void> {
    if (await this.consent.hasAcceptedCurrentPolicies(user.id)) return;

    const outcome = await this.conversations.start(user.id, 'ACCEPT_POLICIES', updateId);
    await this.drawWizard(updateId, user, outcome);
  }

  /**
   * Plain text in the bot's DM, relayed into a conversation.
   *
   * **Which conversation is the whole difficulty.** A user holds one Telegram chat
   * with the bot and may hold several anonymous chats behind it, and a typed message
   * names none of them. Two answers, in order:
   *
   *  1. **A reply** quotes a message we sent, and `notification.telegram_message_id`
   *     records what Telegram called it. That is exact, and the lookup is scoped to
   *     the sender's own rows — so a forged `reply_to_message` cannot address a
   *     stranger's conversation.
   *  2. **Exactly one live chat** needs no ceremony, and is the common case.
   *
   * With two live chats and no reply the answer is genuinely unknown, and the only
   * safe action is to say so. Delivering a private message to the wrong stranger is
   * the single worst thing this relay could do.
   */
  private async onText(
    updateId: number,
    user: BotUser,
    message: BotInboundText,
    replyToMessageId: number | null,
  ): Promise<void> {
    /**
     * A tap on the persistent menu is a command, not a message.
     *
     * A reply-keyboard button sends its **label** as ordinary text, so «🎟
     * فعالیت‌های من» arrives here indistinguishable from something somebody
     * typed. Without this it would be handed to the wizard as an answer, or —
     * worse — relayed into an anonymous chat, and a stranger would receive a
     * menu label.
     *
     * Checked before the wizard for that reason: the menu is how somebody
     * *leaves* a form they no longer want, and a wizard that swallowed its own
     * escape hatch would be a trap.
     */
    const menuCommand = menuCommandFor(message.text);
    if (menuCommand !== null) return this.onCommand(updateId, user, menuCommand);

    /**
     * A form in progress claims the message first (ADR-0017).
     *
     * This is the one ordering that matters in the whole wiring. Text typed while
     * a wizard is open is an *answer*, and relaying it into an anonymous chat
     * instead would send somebody's event description to a stranger — the single
     * worst thing this relay can do, and exactly what `onText`'s own comment
     * warns about. `handle` returns null when there is no wizard, which is how
     * the two cases are told apart rather than guessed between.
     */
    if (this.env.ENABLE_CONVERSATION_WIZARD) {
      const wizard = await this.conversations.handle(user.id, updateId, {
        kind: 'text',
        value: message.text,
      });
      if (wizard !== null) {
        /**
         * The answer is in the form now, so it comes out of the chat.
         *
         * Only once the wizard has **claimed** it: a message that was not an
         * answer is a chat relay or a menu tap, and deleting one of those would
         * take away something the user meant to keep. `handle` returning
         * non-null is exactly the line between the two.
         */
        await this.tidy(user, message.telegramMessageId);
        return this.drawWizard(updateId, user, wizard);
      }
    }

    // Relaying a message is a write, and the policy gate applies to it exactly as
    // it applies to `POST /chats/:id/messages`. This bypassed the gate from M13
    // until ADR-0017; see `mayWrite`.
    if (!(await this.mayWrite(updateId, user))) return;

    // The same bucket the Mini App's send spends from, keyed on the same subject: a
    // limit enforced on one of two surfaces is not a limit (T12).
    const verdict = await this.limiter.consume('CHAT_SEND', user.publicId, RATE_LIMITS.CHAT_SEND);
    if (!verdict.allowed) {
      await this.notice(updateId, user, ERROR_MESSAGES_FA[ErrorCode.RATE_LIMITED]);
      return;
    }

    const quoted =
      replyToMessageId === null
        ? null
        : await this.notifications.chatOfDeliveredMessage(user.id, replyToMessageId);
    const chatPublicId = quoted ?? (await this.chats.singleLiveChatFor(user.id));

    if (chatPublicId === null) {
      await this.notice(updateId, user, await this.ambiguityAdvice(user.id));
      return;
    }

    try {
      await this.chats.send(user.id, chatPublicId, message);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * The sender edited something they had already sent (D10).
   *
   * `NOT_FOUND` is silence rather than a notice. Telegram sends an `edited_message`
   * for every edit in the bot's DM, including edits to messages that were never
   * relayed anywhere, and answering «پیدا نشد» to those would have the bot arguing
   * with people about their own typing.
   */
  private async onEdit(updateId: number, user: BotUser, message: BotInboundText): Promise<void> {
    if (message.telegramMessageId === undefined) return;

    try {
      await this.chats.editBySourceMessage(user.id, message.telegramMessageId, message);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === ErrorCode.NOT_FOUND) return;
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * An inline-keyboard tap: `chat:accept|reject|close:<id>`.
   *
   * The toast is the *only* reply, and it is enqueued rather than sent. Accepting
   * and rejecting already notify the other party through the outbox, so a second
   * message to the person who pressed the button would be the product telling
   * somebody what they had just done.
   *
   * Authorisation is entirely the services': `accept` and `reject` verify that the
   * caller hosts the event, `close` verifies membership. A tampered button therefore
   * names a resource somebody does not own and is refused with the same Persian
   * sentence the API would return (T3.2) — the button carries no authority.
   */
  private async onCallback(
    update: ParsedUpdate,
    from: BotSender,
    callbackQueryId: string,
    data: string,
  ): Promise<void> {
    const user = await this.knownUser(from);
    if (user === null) {
      await this.answer(callbackQueryId, 'برای شروع /start را بفرستید.');
      return;
    }

    /**
     * A wizard button, tried first (ADR-0017).
     *
     * The two protocols share this handler and are told apart by prefix —
     * `wz:` versus `chat:` — so neither parser sees the other's data. A wizard
     * tap that arrives with no conversation open falls through to `null` and is
     * answered as a stale button, which is what it is: the form it belonged to
     * has been submitted, cancelled, or swept.
     */
    const wizardCallback = this.env.ENABLE_CONVERSATION_WIZARD ? parseWizardCallback(data) : null;
    if (wizardCallback !== null) {
      const input: WizardInput = {
        kind: 'callback',
        action: wizardCallback.action,
        value: wizardCallback.value,
      };
      const outcome = await this.conversations.handle(user.id, update.updateId, input);
      if (outcome === null) {
        await this.answer(callbackQueryId, 'این فرم دیگر باز نیست.');
        return;
      }

      // Answered before the redraw so the spinner stops promptly; the redraw is
      // a second job and Telegram does not pair them.
      await this.answer(callbackQueryId, '');
      await this.drawWizard(update.updateId, user, outcome, wizardCallback);
      return;
    }

    /**
     * A moderation button (ADR-0018).
     *
     * Tried early and told apart by prefix like every other protocol, and it is
     * the one branch that resolves an **admin session** before it does anything.
     * A tap with no link answers the same «این دکمه دیگر کار نمی‌کند» a stale or
     * tampered button gets, so guessing the prefix reveals nothing.
     *
     * No `mayWrite`: the consent gate is about a *user's* acceptance of the
     * terms, and a moderator working a queue is not acting as one. Sending a
     * moderator the consent wizard in the middle of an incident would be the
     * gate refusing the person whose job is to fix things.
     */
    const adminCallback = parseAdminCallback(data);
    if (adminCallback !== null) {
      const session = await this.adminTelegram.sessionFor(user.telegramUserId);
      if (session === null) {
        await this.answer(callbackQueryId, 'این دکمه دیگر کار نمی‌کند.');
        return;
      }
      await this.answer(callbackQueryId, '');
      return this.onAdminCallback(update.updateId, user, session, adminCallback);
    }

    /**
     * An event button: joining from `/discover`, or cancelling from `/requests`.
     *
     * Tried before `chat:` and told apart by prefix, exactly as the wizard is.
     * Both are writes and both go through `mayWrite` below for the reason every
     * other button does — the bot does not pass through `AuthGuard`, so the
     * policy gate is applied here or nowhere.
     */
    /**
     * A settings toggle: write it, then redraw the board.
     *
     * The redraw is a fresh message rather than an edit, for the reason every
     * other digest is: `BOT_SETTINGS` is a notification row like any other, and
     * the wizard's edit path belongs to the wizard. The cost is a short trail of
     * boards in the chat, which is the same cost `/discover` pays for filters.
     */
    const settingCallback = parseSettingCallback(data);
    if (settingCallback !== null) {
      return this.onSettingCallback(update.updateId, user, callbackQueryId, settingCallback);
    }

    /**
     * A discovery filter tap: run the search the button describes.
     *
     * No `mayWrite` gate — searching is a read, and the policy gate is about
     * writes. It is the one callback in this handler that changes nothing.
     */
    const discoverCallback = parseDiscoverCallback(data);
    if (discoverCallback !== null) {
      await this.answer(callbackQueryId, '');
      return this.discoverWith(update.updateId, user, discoverCallback);
    }

    /**
     * A report tap — the menu, or a reason.
     *
     * First of the four protocols, because it is the one that must work when
     * everything else about an interaction has gone wrong.
     */
    const reportCallback = parseReportCallback(data);
    if (reportCallback !== null) {
      if (!(await this.mayWrite(update.updateId, user))) {
        await this.answer(callbackQueryId, 'ابتدا قوانین را بپذیرید.');
        return;
      }
      return this.onReportCallback(update.updateId, user, callbackQueryId, reportCallback);
    }

    /**
     * A rating tap. Before `chat:` and `ev:`, told apart by prefix like the rest.
     */
    const reviewCallback = parseReviewCallback(data);
    if (reviewCallback !== null) {
      if (!(await this.mayWrite(update.updateId, user))) {
        await this.answer(callbackQueryId, 'ابتدا قوانین را بپذیرید.');
        return;
      }
      try {
        await this.reviews.submit(user.id, reviewCallback.id, { rating: reviewCallback.rating });
        await this.answer(
          callbackQueryId,
          `نظر شما ثبت شد ✅ (${toPersianDigits(String(reviewCallback.rating))} از ۵)`,
        );
        /**
         * The rating is written; the form is the optional half.
         *
         * Opened rather than offered as a button, because a wizard is what the
         * tags and the comment need and `conversation_state.user_id` is UNIQUE —
         * one at a time, so this replaces whatever was open, which is the same
         * rule `/create_event` follows. `review.edit_window_minutes` is what
         * makes amending legal, and `ReviewService.edit` replaces the whole
         * review with the rating carried back in unchanged.
         */
        if (this.env.ENABLE_CONVERSATION_WIZARD) {
          const outcome = await this.conversations.start(
            user.id,
            'WRITE_REVIEW',
            update.updateId,
            reviewCallback.id,
          );
          await this.drawWizard(update.updateId, user, outcome);
        }
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await this.answer(callbackQueryId, ERROR_MESSAGES_FA[error.code]);
      }
      return;
    }

    const eventCallback = parseEventCallback(data);
    if (eventCallback !== null) {
      if (!(await this.mayWrite(update.updateId, user))) {
        await this.answer(callbackQueryId, 'ابتدا قوانین را بپذیرید.');
        return;
      }
      return this.onEventCallback(update.updateId, user, callbackQueryId, eventCallback);
    }

    const callback = parseChatCallback(data);
    if (callback === null) {
      // An old build's button, or a tampered one. Indistinguishable to the person
      // who pressed it, and the same sentence serves both.
      await this.answer(callbackQueryId, 'این دکمه دیگر کار نمی‌کند.');
      return;
    }

    // Accepting, rejecting, closing and sharing are all writes, and all of them
    // bypassed the policy gate before ADR-0017. The toast says where the user has
    // been sent, because a button that silently opens a different screen is worse
    // than one that explains itself.
    if (!(await this.mayWrite(update.updateId, user))) {
      await this.answer(callbackQueryId, 'ابتدا قوانین را بپذیرید.');
      return;
    }

    try {
      switch (callback.action) {
        case 'accept':
          await this.participation.accept(user.id, callback.id);
          await this.answer(callbackQueryId, 'پذیرفته شد ✅');
          return;

        case 'reject':
          await this.participation.reject(user.id, callback.id);
          await this.answer(callbackQueryId, 'رد شد');
          return;

        case 'close':
          await this.chats.close(user.id, callback.id);
          await this.answer(callbackQueryId, 'گفتگو بسته شد 🔒');
          return;

        /**
         * «اشتراک اطلاعات تماس» — the *question*, not the act (report 6).
         *
         * Nothing is disclosed here. It sends a message spelling out exactly what
         * agreeing does, with the button that does it, and that two-step shape is
         * deliberate: consent to disclose is the one decision in this product
         * that has to be unambiguous (ADR-0009), and a single tap on a button
         * attached to a message that arrived unbidden is not.
         *
         * What this replaces is a trip to a different application — read the
         * message in the bot, open the Mini App, find the conversation, confirm
         * — for a decision that was always going to be a confirmation either way.
         */
        case 'share':
          await this.reply(update.updateId, user.id, TEMPLATES.CHAT_SHARE_CONFIRM, {
            chatPublicId: callback.id,
          });
          await this.answer(callbackQueryId, 'پیش از تأیید، توضیح را بخوانید.');
          return;

        /**
         * The act itself.
         *
         * `ChatService.shareContact` is the authority and is idempotent, so a
         * double tap is one decision. It refuses a chat that is not OPEN, which
         * is why the button is only rendered on an accepted conversation — this
         * is the second line of defence rather than the first.
         *
         * **It reveals nothing by itself**, and the confirmation says so: the
         * platform holds no phone number and will not surrender a Telegram
         * handle. What changes is that the sharer's own messages stop being
         * masked, so they can send their details themselves.
         */
        case 'shareyes':
          await this.chats.shareContact(user.id, callback.id);
          await this.answer(callbackQueryId, 'ثبت شد 🤝 حالا می‌توانید اطلاعات تماس بفرستید.');
          return;
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.answer(callbackQueryId, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * Joining an activity, and standing down from one — the half of the product
   * the bot could not do.
   *
   * ── Why this is the gap that mattered ───────────────────────────────────────
   *
   * `/discover` has listed events since M13 and offered no way to act on one.
   * The bot could *host* an activity end to end — create it, see the requests,
   * accept or reject, chat — and a guest could see activities and not ask to
   * join one. The step between those was `POST /events/:id/join`, reachable only
   * from `EventDetailView`, and v0.4.6 removed the last button that opened it.
   *
   * ── The toast says which of the two happened ────────────────────────────────
   *
   * `join` returns PENDING when there is a seat and WAITLISTED when there is
   * not, and the difference is the whole answer: one is "the host is deciding",
   * the other is "you are in a queue". A single «ثبت شد» would leave somebody on
   * a waitlist believing a host was about to reply.
   *
   * Nothing else is sent from here. The host's notification is the outbox's, and
   * a second message to the person who just pressed the button would be the
   * product telling them what they had done.
   */
  private async onEventCallback(
    updateId: number,
    user: BotUser,
    callbackQueryId: string,
    callback: EventCallback,
  ): Promise<void> {
    try {
      switch (callback.action) {
        case 'join': {
          const participation = await this.participation.join(user.id, callback.id);
          await this.answer(
            callbackQueryId,
            participation.status === 'WAITLISTED'
              ? 'در لیست انتظار ثبت شدید ⏳'
              : 'درخواست شما فرستاده شد ✅ منتظر پاسخ میزبان بمانید.',
          );
          return;
        }

        case 'cancel':
          await this.participation.cancel(user.id, callback.id);
          await this.answer(callbackQueryId, 'درخواست شما لغو شد');
          return;

        /**
         * One activity in full — the screen `EventDetailView` was.
         *
         * `findPublished` is the same read `GET /events/:publicId` makes, and it
         * answers 404 identically for "not published" and "does not exist", so
         * this is not an existence oracle either (T3.3).
         *
         * The «پیوستن» button is repeated here rather than assumed: somebody who
         * opened the detail has the decision in front of them, and sending them
         * back to the digest to act on it would be the detour this release has
         * spent the day removing.
         */
        case 'show': {
          await this.answer(callbackQueryId, '');
          return this.drawEventDetail(updateId, user, callback.id);
        }

        /**
         * The three host actions, each asked before it is done.
         *
         * The ask states the **live** cost: `economy.*` are settings an operator
         * can change, so the number is read here rather than written into a
         * template. A message naming a price the service will not charge is
         * worse than one naming none.
         */
        case 'post': {
          const cost = await this.settings.getInt('economy.event_channel_send_coins');
          await this.answer(callbackQueryId, '');
          return this.confirmSpend(
            updateId,
            user,
            `<b>انتشار در کانال</b>\n\n` +
              `این فعالیت در کانال پایه‌تَم منتشر می‌شود و ` +
              `<b>${toPersianDigits(String(cost))} سکه</b> از موجودی شما کم می‌شود.`,
            '📣 بله، منتشر کن',
            encodeEventCallback('postyes', callback.id),
          );
        }

        case 'postyes':
          await this.events.publishToChannel(user.id, callback.id);
          await this.answer(callbackQueryId, 'در کانال منتشر شد 📣');
          return;

        case 'boost': {
          const [cost, hours] = await Promise.all([
            this.settings.getInt('economy.boost_coins'),
            this.settings.getInt('economy.boost_duration_hours'),
          ]);
          await this.answer(callbackQueryId, '');
          return this.confirmSpend(
            updateId,
            user,
            `<b>ارتقای فعالیت</b>\n\n` +
              `این فعالیت به مدت ${toPersianDigits(String(hours))} ساعت بالاتر از بقیه ` +
              `دیده می‌شود و <b>${toPersianDigits(String(cost))} سکه</b> از موجودی شما کم می‌شود.`,
            '🚀 بله، ارتقا بده',
            encodeEventCallback('boostyes', callback.id),
          );
        }

        case 'boostyes':
          await this.events.boost(user.id, callback.id, 'BOOST');
          await this.answer(callbackQueryId, 'فعالیت ارتقا یافت 🚀');
          return;

        /**
         * Inviting is the one that shows a **preview** rather than a price.
         *
         * `InvitationService.preview` answers how many people the pool found and
         * how many would actually be reached, and those two differ whenever the
         * cap bites. A host spending coins deserves to know they are paying to
         * reach eleven people rather than the twenty the cap allows — and the
         * preview names no one, which is the privacy line it already holds.
         */
        case 'invite': {
          const preview = await this.invitations.preview(user.id, callback.id);
          await this.answer(callbackQueryId, '');
          if (!preview.affordable) {
            return this.notice(
              updateId,
              user,
              `برای دعوت به ${toPersianDigits(String(preview.cost))} سکه نیاز است و ` +
                `موجودی شما ${toPersianDigits(String(preview.balance))} سکه است.`,
            );
          }
          if (preview.selected === 0) {
            return this.notice(
              updateId,
              user,
              'فعلاً کسی برای دعوت پیدا نشد. کمی بعد دوباره تلاش کنید.',
            );
          }
          return this.confirmSpend(
            updateId,
            user,
            `<b>دعوت از افراد</b>\n\n` +
              `${toPersianDigits(String(preview.selected))} نفر دعوت می‌شوند ` +
              `(از ${toPersianDigits(String(preview.candidates))} نفر واجد شرایط).\n` +
              `<b>${toPersianDigits(String(preview.cost))} سکه</b> از موجودی شما کم می‌شود.`,
            '👥 بله، دعوت کن',
            encodeEventCallback('inviteyes', callback.id),
          );
        }

        case 'inviteyes': {
          // The client key is the update: a redelivered tap invites once.
          const result = await this.invitations.inviteTop(
            user.id,
            callback.id,
            `bot-${String(updateId)}`,
          );
          await this.answer(
            callbackQueryId,
            `${toPersianDigits(String(result.invited))} دعوت فرستاده شد 👥`,
          );
          return;
        }

        /**
         * Cancelling, with the consequence stated before it happens.
         *
         * `previewHostCancellation` is what `MyEventsView` calls first, and it is
         * the difference between "nobody had joined" and "you are standing four
         * people up". It cannot be undone, which is why it is asked twice.
         */
        case 'drop': {
          const preview = await this.events.previewHostCancellation(user.id, callback.id);
          await this.answer(callbackQueryId, '');
          return this.confirmSpend(
            updateId,
            user,
            `<b>لغو فعالیت</b>\n\n` +
              `${toPersianDigits(String(preview.affected))} نفر پذیرفته شده‌اند و ` +
              `به همه اطلاع داده می‌شود.\n\n<i>این کار برگشت‌پذیر نیست.</i>`,
            '✖️ بله، لغو کن',
            encodeEventCallback('dropyes', callback.id),
          );
        }

        case 'dropyes':
          await this.events.cancelByHost(user.id, callback.id);
          await this.answer(callbackQueryId, 'فعالیت لغو شد');
          return;

        /**
         * Who is coming — the screen three earlier batches needed.
         *
         * `markNoShow` takes a participant public id and the bot had no way to
         * name one: `/myevents` counted guests and said nothing about who, so a
         * host could not record that somebody did not turn up.
         *
         * `listForEvent` refuses an event that is not the caller's, and answers
         * not-yours and not-found identically (T3.3) — so this needs no
         * ownership check of its own.
         */
        case 'who': {
          await this.answer(callbackQueryId, '');
          return this.drawParticipants(updateId, user, callback.id);
        }

        /**
         * A no-show, asked before it is recorded.
         *
         * It moves somebody's Trust Score down and there is no undo in the bot,
         * which is the same bar the paid actions clear with two taps.
         */
        case 'noshow': {
          await this.answer(callbackQueryId, '');
          return this.confirmSpend(
            updateId,
            user,
            `<b>ثبت غیبت</b>\n\n` +
              `این کار امتیاز اعتماد این نفر را کم می‌کند و به او اطلاع داده می‌شود.\n\n` +
              `<i>فقط وقتی ثبت کنید که واقعاً نیامده باشد.</i>`,
            '🚫 بله، غایب بود',
            encodeEventCallback('noshowyes', callback.id),
          );
        }

        case 'noshowyes':
          await this.lifecycle.markNoShow(user.id, callback.id);
          await this.answer(callbackQueryId, 'غیبت ثبت شد');
          return;
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      /**
       * The refusal is a **toast**, not a notification row.
       *
       * «ظرفیت تکمیل است» and «قبلاً درخواست داده‌اید» are answers to a tap, and
       * a tap that is answered twice — once as a toast and once as a message
       * that stays in the chat — reads as two different failures. The ones that
       * need to persist are the ones somebody else caused, and those arrive
       * through the outbox.
       *
       * Truncated by `answerCallback` at Telegram's 200 characters; every
       * sentence in `ERROR_MESSAGES_FA` is far inside that.
       */
      await this.answer(callbackQueryId, ERROR_MESSAGES_FA[error.code]);
      // A refusal the user can act on gets a message too, because a toast is
      // gone in three seconds and «نمایه‌تان را کامل کنید» is an instruction.
      if (error.code === ErrorCode.PROFILE_INCOMPLETE) {
        await this.notice(
          updateId,
          user,
          'برای پیوستن به فعالیت‌ها نخست نمایه‌تان را کامل کنید — /edit_profile',
        );
      }
    }
  }

  /**
   * Reporting — the menu, then the filing.
   *
   * ── What the reporter is told ───────────────────────────────────────────────
   *
   * That it was filed. Never how many others reported and never who: a count
   * would let somebody probe how close a rival's event is to being hidden.
   * `triggeredReview` says whether this was the report that crossed the
   * threshold, and even that is rendered as a warmer thank-you rather than as a
   * number.
   *
   * **Nobody is notified.** Telling one side of an anonymous chat that the other
   * reported them is the single message this area must never send, and the only
   * thing that leaves here is a toast to the person who tapped.
   *
   * A refusal is a toast for the same reason a join refusal is — except
   * `CANNOT_REPORT_OWN_CONTENT`, which is a mis-tap worth explaining rather than
   * a policy worth restating.
   */
  private async onReportCallback(
    updateId: number,
    user: BotUser,
    callbackQueryId: string,
    callback: ReportCallback,
  ): Promise<void> {
    if (callback.asking) {
      await this.answer(callbackQueryId, '');

      /**
       * The form, when there is one to open (v0.5.8).
       *
       * v0.5.7 filed from the reason alone, and `report.description` is nullable
       * — so that was a complete report. But «HARASSMENT» with two sentences
       * under it is a great deal more use to a moderator than the word by
       * itself, and `ReportService` has only `file`: no update path, so the
       * description is collected before the row exists or not at all.
       *
       * The target letter is **seeded** rather than asked. A public id does not
       * carry its table, and whether this is an event, a conversation or a user
       * is known to the button that was tapped and nothing else.
       */
      if (this.env.ENABLE_CONVERSATION_WIZARD) {
        const outcome = await this.conversations.start(
          user.id,
          'FILE_REPORT',
          updateId,
          callback.id,
          { target: callback.target },
        );
        return this.drawWizard(updateId, user, outcome);
      }

      /**
       * Wizards off: the v0.5.7 path, kept as the fallback.
       *
       * One reason per row — they are sentences, not labels, and a two-column
       * grid of «آزار و توهین» beside «نگرانی برای ایمنی» is a mis-tap on the
       * two that matter most. It files without a description, which is worse
       * than the form and much better than a safety control that is switched off
       * with the wizards.
       */
      const rows = REPORT_REASON_CHOICES.map((choice) => [
        {
          text: choice.label,
          callbackData: encodeReportReason(callback.target, choice.reason, callback.id),
        },
      ]);
      return this.reply(updateId, user.id, TEMPLATES.BOT_REPORT_REASONS, {
        text: reportPrompt(callback.target),
        keyboard: JSON.stringify(rows),
      });
    }

    if (callback.reason === null) return;

    try {
      const filed = await this.reports.file(user.id, {
        targetType: REPORT_TARGETS[callback.target],
        targetPublicId: callback.id,
        reason: callback.reason,
      });
      await this.answer(
        callbackQueryId,
        filed.triggeredReview
          ? 'گزارش شما ثبت شد و در حال بررسی است. ممنون که اطلاع دادید.'
          : 'گزارش شما ثبت شد. ممنون که اطلاع دادید.',
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.answer(callbackQueryId, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * File the report the form describes.
   *
   * The reason is required by the wizard, so a form that reaches here without
   * one is a step that was skipped when it should not have been — refused rather
   * than filed as `OTHER`, because a reason nobody chose is worse than no report
   * for a moderator sorting a queue.
   *
   * Nothing is notified and nothing is echoed: the same two rules v0.5.7 set.
   */
  private async submitReport(
    updateId: number,
    user: BotUser,
    snapshot: ConversationSnapshot,
  ): Promise<void> {
    const form = snapshot.form as FileReportForm;
    const targetPublicId = snapshot.targetPublicId;

    await this.conversations.clear(user.id);

    const target = form.target;
    if (targetPublicId === null || target === undefined || form.reason === undefined) {
      return this.notice(updateId, user, 'گزارش ثبت نشد. دوباره تلاش کنید.');
    }
    if (!isReportTarget(target)) return;

    try {
      const filed = await this.reports.file(user.id, {
        targetType: REPORT_TARGETS[target],
        targetPublicId,
        reason: form.reason as ReportReasonValue,
        ...(form.description !== undefined ? { description: form.description } : {}),
      });
      await this.notice(
        updateId,
        user,
        filed.triggeredReview
          ? 'گزارش شما ثبت شد و در حال بررسی است. ممنون که اطلاع دادید.'
          : 'گزارش شما ثبت شد. ممنون که اطلاع دادید.',
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * Who is coming to one activity, with the host's actions on each of them.
   *
   * ── Why no-show is offered only after the event ends ────────────────────────
   *
   * `markNoShow` refuses while `endsAt` is in the future, and a button that
   * exists to be refused is worse than no button. So the row a guest gets
   * depends on where the activity is in its life: a pending request gets accept
   * and reject, and an accepted guest gets a no-show only once there is
   * something to have been absent from.
   */
  // ── admin moderation in the bot (ADR-0018) ─────────────────────────────────

  /**
   * A `ad:` tap, with the session already resolved by the caller.
   *
   * The session is passed in rather than re-read: it was needed to decide
   * whether the button was answerable at all, and reading it twice would be two
   * chances for a revocation to land between them — which is a race with no
   * right answer. What matters is that it is re-read on **every update**, so a
   * revoked link stops working on the moderator's next tap.
   */
  private async onAdminCallback(
    updateId: number,
    user: BotUser,
    session: AdminSession,
    callback: AdminCallback,
  ): Promise<void> {
    if (callback.action === 'list' || callback.id === null) {
      return this.drawModerationQueue(updateId, user, session);
    }

    /**
     * Opening a case **is** starting the decision form.
     *
     * There is no read-only case screen in between, because there is nothing a
     * moderator would do on one except decide — and `conversation_state.user_id`
     * is UNIQUE, so a screen that later started a wizard would be two chances to
     * discard whatever else was open rather than one.
     */
    if (!this.env.ENABLE_CONVERSATION_WIZARD) return this.wizardsOff(updateId, user);

    let detail;
    try {
      detail = await this.admins.caseForReview(session, callback.id);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }

    /**
     * A decided case is not re-decidable, and saying so beats opening a form the
     * submit will refuse.
     *
     * `decideCase` enforces this itself — it is the authority — so this is the
     * second line rather than the first. What it buys is that a moderator who
     * taps a stale queue does not write a note into a form that cannot land.
     */
    if (!OPEN_CASE_STATUSES.has(detail.status)) {
      return this.notice(updateId, user, 'این پرونده پیش‌تر تصمیم‌گیری شده است.');
    }

    const outcome = await this.conversations.start(user.id, 'ADMIN_CASE', updateId, detail.id, {
      /**
       * The case as the moderator will read it, rendered **now** and carried in
       * the draft.
       *
       * A step's `prompt` is pure and cannot read a database, and a redelivery
       * re-renders without advancing — so a headline re-read on every draw would
       * be a query per redraw and, worse, could change under somebody mid-form.
       * Plain text, because `renderStep` escapes what it is given.
       */
      headline: formatAdminCasePrompt({
        id: detail.id,
        subjectType: detail.subjectType,
        status: detail.status,
        trigger: detail.trigger,
        reportCount: detail.reportCount,
        createdAt: detail.createdAt,
        eventTitle: detail.eventTitle,
        eventDescription: detail.eventDescription,
        eventStatus: detail.eventStatus,
        reportReasons: detail.reportReasons,
        matchedTermCount: detail.matchedTermCount,
      }),
      // Seeded so the false-positive step can ask `when` it applies, which is
      // only where the automation is the thing being judged (ADR-0012).
      trigger: detail.trigger,
    });
    return this.drawWizard(updateId, user, outcome);
  }

  /**
   * The queue, oldest first — a queue nobody works from the bottom.
   *
   * `listCases` asserts `event.moderate` in the service layer, which is where
   * invariant 12 puts it: this method holds no check of its own beyond having a
   * session at all, and that is on purpose. A read guarded here and nowhere else
   * would be a read the next caller forgets to guard.
   */
  private async drawModerationQueue(
    updateId: number,
    user: BotUser,
    session: AdminSession,
  ): Promise<void> {
    let cases;
    try {
      cases = await this.admins.listCases(session);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }

    /**
     * The event titles, in one query rather than one per case.
     *
     * `listCases` takes up to a hundred rows and the digest shows far fewer, but
     * the read happens before the cap — so a per-case lookup would be a hundred
     * round trips to render ten lines.
     */
    const eventIds = cases.filter((row) => row.subjectType === 'EVENT').map((row) => row.subjectId);
    const titles = await this.admins.eventTitlesFor(session, eventIds);

    const lines = cases
      .filter((row) => isPublicId(row.id))
      .map((row) => ({
        id: row.id,
        subjectType: row.subjectType,
        status: row.status,
        trigger: row.trigger,
        reportCount: row.reportCount,
        createdAt: row.createdAt,
        eventTitle: titles.get(row.subjectId) ?? null,
      }));

    const rows = adminQueueRows(lines);
    await this.reply(updateId, user.id, TEMPLATES.BOT_ADMIN_CASES, {
      text: formatAdminQueue(lines),
      ...(rows.length > 0 ? { keyboard: JSON.stringify(rows) } : {}),
    });
  }

  /**
   * The decision, once the form is filled in.
   *
   * **The session is resolved again here**, and that is the load-bearing line of
   * this whole feature. A wizard can be open for seven days; a link can be
   * revoked, an admin suspended, a role removed. Deciding from the session that
   * opened the form would let a revoked moderator finish work they started
   * before losing access — which is exactly the failure a revocation exists to
   * prevent.
   *
   * `decideCase` then asserts `event.moderate` for itself and writes the audit
   * row naming `session.adminUserId`. That is invariant 12: the check is in the
   * service, so it holds for this caller and for every caller that does not
   * exist yet.
   */
  private async submitAdminCase(
    updateId: number,
    user: BotUser,
    snapshot: ConversationSnapshot,
  ): Promise<void> {
    const form = snapshot.form as AdminCaseForm;
    const caseId = snapshot.targetPublicId;

    const session = await this.adminTelegram.sessionFor(user.telegramUserId);
    if (session === null || caseId === null) {
      await this.conversations.clear(user.id);
      return this.notice(updateId, user, ERROR_MESSAGES_FA[ErrorCode.FORBIDDEN]);
    }

    const decision =
      form.decision === 'APPROVED' || form.decision === 'REJECTED' ? form.decision : null;
    if (decision === null || form.note === undefined) {
      // A form that reaches here incomplete means a step was skipped that should
      // not have been, and inventing a decision for it would close somebody's
      // case on nobody's judgement.
      return this.notice(updateId, user, ERROR_MESSAGES_FA[ErrorCode.VALIDATION_FAILED]);
    }

    try {
      await this.admins.decideCase(session, caseId, {
        decision,
        note: form.note,
        ...(form.falsePositive !== undefined ? { falsePositive: form.falsePositive } : {}),
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.conversations.clear(user.id);
      return this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }

    await this.conversations.clear(user.id);
    await this.notice(
      updateId,
      user,
      decision === 'APPROVED'
        ? 'پرونده بسته شد: محتوا تأیید شد. ✅'
        : 'پرونده بسته شد: محتوا رد شد. ⛔️',
    );
    // Straight back to the queue, because a moderator with one case has
    // usually got several — and a decision that ends in a dead end is a
    // decision somebody has to find their way back from.
    return this.drawModerationQueue(updateId, user, session);
  }

  /**
   * One activity in full, and the buttons that belong to whoever is reading it.
   *
   * `findPublished` is the same read `GET /events/:publicId` makes, and it
   * answers 404 identically for "not published" and "does not exist", so this is
   * not an existence oracle either (T3.3).
   *
   * ── Why the keyboard depends on who is asking ───────────────────────────────
   *
   * The **host** sees who is coming. Joining is refused for them by
   * `HOST_CANNOT_JOIN` and reporting their own content by
   * `CANNOT_REPORT_OWN_CONTENT`, so offering either would be two buttons that
   * exist to be declined.
   *
   * Everybody else sees joining, and the two ways to say something is wrong. The
   * host is reportable from here because this is the one screen that names them —
   * everywhere else in the product they are a display name behind an anonymous
   * chat — and reporting was the last user-facing safety control with no bot
   * surface at all.
   *
   * ── Why it is a method and not a `case` ─────────────────────────────────────
   *
   * Two callers now: the `ev:show` button, and a reader arriving from a channel
   * post. A second copy would be a second answer to "what does a guest see about
   * an activity", and the copy is the one that would fall behind.
   *
   * A refusal is a `notice` rather than a toast, because this caller may have no
   * callback query to answer: somebody following a `?start=` link pressed a link,
   * not a button.
   */
  private async drawEventDetail(
    updateId: number,
    user: BotUser,
    eventPublicId: string,
  ): Promise<void> {
    let event;
    try {
      event = await this.discovery.findPublished(eventPublicId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }

    return this.reply(updateId, user.id, TEMPLATES.BOT_EVENT_DETAIL, {
      text: formatEventDetail({
        title: event.title,
        description: event.description,
        categoryName: event.customCategoryLabel ?? event.categoryNameFa,
        where:
          event.districtNameFa === null
            ? event.cityNameFa
            : `${event.cityNameFa} — ${event.districtNameFa}`,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        capacity: event.capacity,
        acceptedCount: event.acceptedCount,
        costType: event.costType,
        costAmount: event.costAmount,
        costNote: event.costNote,
        minAge: event.minAge,
        maxAge: event.maxAge,
        hostDisplayName: event.hostDisplayName,
        hostTrustScore: event.hostTrustScore,
      }),
      keyboard: JSON.stringify(
        event.hostPublicId === user.publicId
          ? [
              [
                {
                  text: '👥 مهمان‌ها',
                  callbackData: encodeEventCallback('who', eventPublicId),
                },
              ],
            ]
          : [
              [
                {
                  text: '➕ پیوستن به این فعالیت',
                  callbackData: encodeEventCallback('join', eventPublicId),
                },
              ],
              [
                { text: '🚩 گزارش فعالیت', callbackData: encodeReportAsk('e', eventPublicId) },
                ...(isPublicId(event.hostPublicId)
                  ? [
                      {
                        text: '🚩 گزارش میزبان',
                        callbackData: encodeReportAsk('u', event.hostPublicId),
                      },
                    ]
                  : []),
              ],
            ],
      ),
    });
  }

  private async drawParticipants(
    updateId: number,
    user: BotUser,
    eventPublicId: string,
  ): Promise<void> {
    let event;
    try {
      event = await this.events.findOwned(user.id, eventPublicId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }

    const participants = await this.participation.listForEvent(user.id, eventPublicId);
    const text = formatParticipants(
      event.title,
      participants.map((row) => ({
        displayName: row.displayName,
        trustScore: row.trustScore,
        status: row.status,
        waitlistRank: row.waitlistRank,
      })),
    );

    const ended = event.endsAt <= new Date();
    const rows = participants
      .filter((row) => isPublicId(row.publicId))
      .map((row, index) => {
        const number = toPersianDigits(String(index + 1));
        if (row.status === 'PENDING' || row.status === 'WAITLISTED') {
          return [
            {
              text: `${number} ✅ پذیرش`,
              callbackData: encodeChatCallback('accept', row.publicId),
            },
            { text: `${number} ✖️ رد`, callbackData: encodeChatCallback('reject', row.publicId) },
          ];
        }
        if (row.status === 'ACCEPTED' && ended) {
          return [
            {
              text: `${number} 🚫 غایب بود`,
              callbackData: encodeEventCallback('noshow', row.publicId),
            },
          ];
        }
        return [];
      })
      .filter((row) => row.length > 0);

    await this.reply(updateId, user.id, TEMPLATES.BOT_PARTICIPANTS, {
      text,
      ...(rows.length > 0 ? { keyboard: JSON.stringify(rows) } : {}),
    });
  }

  /**
   * A tap on the settings board.
   *
   * ── Why one handler and not three ───────────────────────────────────────────
   *
   * Every row on this board is a `st:` button and every one of them ends with the
   * same act — write, then redraw — so the branch is over *where the value
   * lives*, which is the only thing that actually differs. Three handlers would
   * be three copies of the redraw.
   *
   * The three stores are deliberate and are not going to be merged. Copying
   * `invite_opt_out` into `user_settings` would give the invitation pool two
   * sources of truth for whether somebody wants to hear from hosts, and the pool
   * reads the profile.
   *
   * ── Privacy is inverted exactly once ────────────────────────────────────────
   *
   * The button carries «دریافت دعوت» — the positive reading the user sees — and
   * the column is `invite_opt_out`. The negation happens here, at the write, and
   * nowhere else; a payload that already carried the stored polarity would make
   * the label and the data disagree, which is where an inversion bug hides.
   *
   * ── A refusal is a toast, not a wall ────────────────────────────────────────
   *
   * `ProfileService.update` answers `PROFILE_INCOMPLETE` for somebody with no
   * profile row, which the board avoids by offering the profile form instead of
   * the switch. The catch is still here because the board is a message that can
   * be tapped long after it was drawn, and a stale button should cost a toast.
   */
  private async onSettingCallback(
    updateId: number,
    user: BotUser,
    callbackQueryId: string,
    callback: SettingCallback,
  ): Promise<void> {
    if (isNotificationField(callback.field)) {
      await this.userSettings.update(user.id, {
        [SETTING_FIELDS[callback.field]]: callback.value,
      });
      await this.answer(callbackQueryId, callback.value ? 'روشن شد' : 'خاموش شد');
      return this.drawSettings(updateId, user);
    }

    if (callback.field === SETTING_PRIVACY) {
      /**
       * The same bucket `PATCH /me/profile` and `PUT /me/settings` spend from,
       * keyed on the same subject.
       *
       * «A limit enforced on one of two surfaces is not a limit» is this file's
       * own rule about the chat relay (T12), and it applies here for a concrete
       * reason: this is the one settings row that writes through
       * `ProfileService.update`, which means one `audit_log` row per tap. The
       * three notification switches are an upsert of one boolean and write no
       * audit at all, which is why they are not metered.
       */
      const verdict = await this.limiter.consume(
        'PROFILE_UPDATE',
        user.publicId,
        RATE_LIMITS.PROFILE_UPDATE,
      );
      if (!verdict.allowed) {
        await this.answer(callbackQueryId, ERROR_MESSAGES_FA[ErrorCode.RATE_LIMITED]);
        return;
      }

      try {
        // The same method the profile wizard submits through, so the invitation
        // pool cannot see one answer from one surface and another from the other.
        await this.profiles.update(user.id, { inviteOptOut: !callback.value });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await this.answer(callbackQueryId, ERROR_MESSAGES_FA[error.code]);
        return this.drawSettings(updateId, user);
      }
      await this.answer(
        callbackQueryId,
        callback.value ? 'دعوت‌ها روشن شد' : 'دیگر دعوتی دریافت نمی‌کنید',
      );
      return this.drawSettings(updateId, user);
    }

    /**
     * The profile form, opened from the row that would have been the privacy
     * switch.
     *
     * A wizard replaces whatever was open — `conversation_state.user_id` is
     * UNIQUE — which is the same rule every other entry point follows, so the
     * toast says where the tap has taken them rather than leaving a form to
     * appear unexplained.
     */
    if (callback.field === SETTING_PROFILE) {
      if (!this.env.ENABLE_CONVERSATION_WIZARD) {
        await this.answer(callbackQueryId, 'این بخش موقتاً در دسترس نیست.');
        return;
      }
      if (!(await this.mayWrite(updateId, user))) {
        await this.answer(callbackQueryId, 'ابتدا قوانین را بپذیرید.');
        return;
      }
      await this.answer(callbackQueryId, 'فرم نمایه باز شد');
      const outcome = await this.conversations.start(user.id, 'EDIT_PROFILE', updateId);
      return this.drawWizard(updateId, user, outcome);
    }

    /**
     * Language, which is a fact rather than a choice.
     *
     * `user.locale` is fa-IR for everybody and every template, date format and
     * error message in the product is written in it. The button exists so the row
     * is not the one dead thing on a board of live ones, and it answers where the
     * tap happened instead of leaving a line of italics to be read.
     */
    if (callback.field === SETTING_LANGUAGE) {
      await this.answer(callbackQueryId, 'فعلاً فقط فارسی در دسترس است.');
      return;
    }
  }

  /**
   * The settings board, drawn from the three places its state actually lives.
   *
   * Notifications are `user_settings`; privacy is `user_profile.invite_opt_out`,
   * which the invitation pool already reads; language is `user.locale`. Nothing
   * is duplicated into a settings table, because a setting with two homes is a
   * setting that will disagree with itself.
   */
  private async drawSettings(updateId: number, user: BotUser): Promise<void> {
    const [settings, profile] = await Promise.all([
      this.userSettings.get(user.id),
      this.profiles.find(user.id),
    ]);

    const state = {
      notifyChat: settings.notifyChat,
      notifyEvents: settings.notifyEvents,
      notifyCampaigns: settings.notifyCampaigns,
      // No profile yet means nothing has opted out, which is the default.
      inviteOptOut: profile?.inviteOptOut ?? false,
      locale: this.env.APP_LOCALE,
      // Distinct from `inviteOptOut === false`: somebody with no profile row has
      // no flag to flip, and `update` refuses rather than creating one.
      hasProfile: profile !== null,
    };

    await this.reply(updateId, user.id, TEMPLATES.BOT_SETTINGS, {
      text: formatSettings(state),
      keyboard: JSON.stringify(settingsRows(state)),
    });
  }

  /**
   * One search, for `/discover` and for every filter tap.
   *
   * ── Why the filters live in the buttons ─────────────────────────────────────
   *
   * The bot holds no per-user query state, and `/discover` was city-only since
   * M13 for exactly that reason: asking for a filter would mean keeping a
   * half-built search between two updates. It does not have to — the whole set
   * fits in a callback, so each button carries the complete query it produces
   * and this handler stays as stateless as it was.
   *
   * The city is still the profile's. A filter for it would be asking somebody
   * where they are when the product already knows.
   *
   * ── Why the filters are named in the body ───────────────────────────────────
   *
   * «فعالیتی پیدا نشد» under an active filter reads as "your city is empty",
   * which is a different and much more discouraging claim than "nothing free
   * today". The digest says what it searched for whenever that is not
   * everything.
   */
  private async discoverWith(
    updateId: number,
    user: BotUser,
    filters: DiscoverFilters,
  ): Promise<void> {
    const profile = await this.profiles.find(user.id);
    if (profile === null) {
      return this.notice(
        updateId,
        user,
        'برای دیدن فعالیت‌های نزدیک، نخست نمایه‌تان را کامل کنید — /edit_profile',
      );
    }

    const now = new Date();
    const range = dateRangeFor(filters.when, now);
    const catalog = await this.catalog.snapshot();
    const category =
      filters.categoryId === null
        ? null
        : (catalog.categories.find((row) => row.id === filters.categoryId) ?? null);

    const page = await this.discovery.search(user.id, {
      cityId: profile.city.id,
      hasCapacity: true,
      limit: DISCOVER_LIMIT,
      ...(range !== null ? { dateFrom: range.from, dateTo: range.to } : {}),
      ...(filters.cost === 'f' ? { costType: 'FREE' as const } : {}),
      // A category that no longer exists is dropped rather than searched for: an
      // operator can deactivate one while somebody holds a button naming it.
      ...(category !== null ? { categoryId: category.id } : {}),
    });

    const text =
      formatDiscovered(
        page.events.map((event) => ({
          title: event.title,
          categoryName: event.customCategoryLabel ?? event.categoryNameFa,
          where:
            event.districtNameFa === null
              ? event.cityNameFa
              : `${event.cityNameFa} — ${event.districtNameFa}`,
          startsAt: event.startsAt,
          remainingCapacity: Math.max(event.capacity - event.acceptedCount, 0),
        })),
      ) + describeFilters(filters, category?.nameFa ?? null);

    const joinable = page.events.filter((event) => isPublicId(event.publicId));
    const eventRows = joinable.map((event, index) => [
      {
        text: `${toPersianDigits(String(index + 1))} جزئیات`,
        callbackData: encodeEventCallback('show', event.publicId),
      },
      {
        text: `${toPersianDigits(String(index + 1))} پیوستن`,
        callbackData: encodeEventCallback('join', event.publicId),
      },
    ]);

    /**
     * The events first, then the filters.
     *
     * A keyboard is read top-down and the events are what somebody came for; a
     * filter row above them would make the list look like a settings screen.
     */
    const rows = [
      ...eventRows,
      ...discoverFilterRows(filters),
      ...discoverCategoryRows(
        filters,
        catalog.categories.map((row) => ({ id: row.id, label: row.nameFa })),
      ),
    ];

    await this.reply(updateId, user.id, TEMPLATES.BOT_DISCOVER, {
      text,
      keyboard: JSON.stringify(rows),
    });
  }

  /**
   * The asking half of a paid or irreversible host action.
   *
   * A message rather than a second toast: a toast is gone in three seconds, and
   * a decision that spends coins or stands four people up should still be on the
   * screen when somebody comes back to it. The same shape `CHAT_SHARE_CONFIRM`
   * uses, for the same reason.
   */
  private async confirmSpend(
    updateId: number,
    user: BotUser,
    text: string,
    confirmLabel: string,
    callbackData: string,
  ): Promise<void> {
    await this.reply(updateId, user.id, TEMPLATES.BOT_CONFIRM_SPEND, {
      text,
      keyboard: JSON.stringify([[{ text: confirmLabel, callbackData }]]),
    });
  }

  // ── the consent gate ────────────────────────────────────────────────────────

  /**
   * May this user write anything?
   *
   * ── The hole this closes ────────────────────────────────────────────────────
   *
   * The policy gate has always lived in `AuthGuard`, applied per route with
   * `@RequiresCurrentPolicies()`. **The bot never passes through `AuthGuard`** —
   * `BotService` calls domain services directly — so every write the bot could
   * already do bypassed it: relaying a chat message, accepting or rejecting a
   * request, sharing contact details. ADR-0017 widened that to creating events
   * and editing profiles, which is what made it worth finding.
   *
   * `BotService`'s own doc comment says a rule enforced on one surface protects
   * one surface. This is that rule, on this surface.
   *
   * ── Why it returns a boolean instead of throwing ────────────────────────────
   *
   * Because the answer to "you have not accepted the terms" is not a refusal, it
   * is **a screen**: the consent wizard opens where the refused action would have
   * happened, and the user is one button from being able to do it. Throwing would
   * make every caller translate an error code back into that flow.
   */
  private async mayWrite(updateId: number, user: BotUser): Promise<boolean> {
    if (await this.consent.hasAcceptedCurrentPolicies(user.id)) return true;

    const outcome = await this.conversations.start(user.id, 'ACCEPT_POLICIES', updateId);
    await this.drawWizard(updateId, user, outcome);
    return false;
  }

  // ── conversation wizards (ADR-0017) ─────────────────────────────────────────

  /**
   * The wizards are switched off (`ENABLE_CONVERSATION_WIZARD=0`).
   *
   * The bot is read-only again, which is what it was for its whole life until
   * ADR-0017 — so the honest answer is the one `/help` used to give: the form is
   * in the app. Drafts already in `conversation_state` are untouched and resume
   * if the flag goes back on, which is what makes turning it off something
   * somebody will actually do during an incident.
   */
  private async wizardsOff(updateId: number, user: BotUser): Promise<void> {
    await this.notice(updateId, user, 'این بخش موقتاً در دسترس نیست. کمی بعد دوباره تلاش کنید.');
  }

  /**
   * Draw whatever the conversation store says comes next.
   *
   * ── One message, edited ─────────────────────────────────────────────────────
   *
   * A wizard lives on a single message. The first screen is a notification like
   * every other reply — a row plus an enqueue, so it is deduped and rate-limited
   * with everything else — and each screen after it is an `editMessageText` job.
   * `lastMessageId` is what makes the second addressable, and it is recorded by
   * the worker when the message is actually sent, not guessed here.
   *
   * Until the first screen has been delivered there is no id to edit, so the
   * fallback is another notification. That is the honest behaviour rather than a
   * bug: a user tapping faster than the queue drains gets a second message, not a
   * lost step.
   */
  private async drawWizard(
    updateId: number,
    user: BotUser,
    outcome: ConversationOutcome,
    callback?: { action: string; value: string },
  ): Promise<void> {
    switch (outcome.kind) {
      case 'cancelled':
        return this.notice(updateId, user, 'فرم بسته شد. هر وقت خواستید /create_event را بفرستید.');

      case 'submit':
        switch (outcome.snapshot.kind) {
          case 'ACCEPT_POLICIES':
            return this.finishConsent(updateId, user);
          case 'EDIT_PROFILE':
            return this.submitProfile(updateId, user, outcome.snapshot.form);
          case 'WRITE_REVIEW':
            return this.submitReviewDetail(updateId, user, outcome.snapshot);
          case 'FILE_REPORT':
            return this.submitReport(updateId, user, outcome.snapshot);
          case 'EDIT_EVENT':
            return this.submitEventEdit(updateId, user, outcome.snapshot);
          case 'ADMIN_CASE':
            return this.submitAdminCase(updateId, user, outcome.snapshot);
          default:
            return this.submitWizard(updateId, user, outcome.snapshot.form);
        }

      case 'summary': {
        /**
         * The consent gate has nothing to review: it collects one decision, and
         * the decision *is* the submission. Falling through to a summary screen
         * would show somebody a «بازبینی نهایی» of a form with no fields.
         */
        if (outcome.snapshot.kind === 'ACCEPT_POLICIES') {
          return this.finishConsent(updateId, user);
        }
        if (outcome.snapshot.kind === 'EDIT_EVENT') {
          const editing = asCreateEventForm(outcome.snapshot.form);
          const screen = renderSummary(await this.summaryLines(editing), false);
          return this.paint(updateId, user, outcome.snapshot.lastMessageId, screen);
        }
        if (outcome.snapshot.kind === 'EDIT_PROFILE') {
          const profile = outcome.snapshot.form as EditProfileForm;
          const screen = renderSummary(await this.profileSummaryLines(profile), false, 'ثبت نمایه');
          return this.paint(updateId, user, outcome.snapshot.lastMessageId, screen);
        }
        if (outcome.snapshot.kind === 'FILE_REPORT') {
          const form = outcome.snapshot.form as FileReportForm;
          const lines: SummaryLine[] = [];
          if (form.reason !== undefined) {
            lines.push({ label: 'دلیل', value: reportReasonLabelFa(form.reason) });
          }
          lines.push({
            label: 'توضیح',
            value: form.description ?? 'بدون توضیح',
          });
          const screen = renderSummary(lines, false, 'فرستادن گزارش');
          return this.paint(updateId, user, outcome.snapshot.lastMessageId, screen);
        }
        /**
         * A moderator reviews what they are about to write into a permanent
         * record, exactly as a host reviews an event before publishing it.
         *
         * The case's own text is deliberately **not** repeated here: it was the
         * question on the first step and it is long, and a summary that scrolls
         * past the «ثبت» button is a summary nobody reads to the end of.
         */
        if (outcome.snapshot.kind === 'ADMIN_CASE') {
          const form = outcome.snapshot.form as AdminCaseForm;
          const lines: SummaryLine[] = [
            { label: 'تصمیم', value: adminDecisionLabelFa(form.decision ?? '—') },
          ];
          if (form.falsePositive !== undefined) {
            lines.push({
              label: 'هشدار خودکار',
              value: form.falsePositive ? 'اشتباه بود' : 'درست بود',
            });
          }
          lines.push({ label: 'توضیح', value: form.note ?? '—' });
          const screen = renderSummary(lines, false, 'ثبت تصمیم');
          return this.paint(updateId, user, outcome.snapshot.lastMessageId, screen);
        }
        if (outcome.snapshot.kind === 'WRITE_REVIEW') {
          const form = outcome.snapshot.form as WriteReviewForm;
          const lines: SummaryLine[] = [];
          if (form.tag !== undefined) {
            lines.push({ label: 'برچسب', value: reviewTagLabel(form.tag) });
          }
          if (form.comment !== undefined) lines.push({ label: 'توضیح', value: form.comment });
          const screen = renderSummary(
            lines.length > 0 ? lines : [{ label: 'چیزی اضافه نشد', value: 'هر دو مرحله رد شد' }],
            false,
            'ثبت نظر',
          );
          return this.paint(updateId, user, outcome.snapshot.lastMessageId, screen);
        }
        const form = asCreateEventForm(outcome.snapshot.form);
        const screen = renderSummary(await this.summaryLines(form), form.wantsDetails !== true);
        return this.paint(updateId, user, outcome.snapshot.lastMessageId, screen);
      }

      case 'redelivery':
      case 'step': {
        if (outcome.kind === 'redelivery') {
          // Nothing advanced; there is nothing new to draw. Redrawing the same
          // screen would be a second identical edit, which Telegram calls a 400.
          return;
        }

        let outcomeToDraw = outcome;

        /**
         * The moment after `pick` is answered, and the only place a draft is
         * filled in by anything but a step.
         *
         * A step's `accept` is pure and cannot load the event, so the form would
         * otherwise be empty — and an edit wizard whose summary offers to replace
         * every field with nothing is worse than no edit wizard. `patchForm` is
         * the caller's half of that; the wizard's note explains why the purity is
         * worth the asymmetry.
         */
        if (
          outcome.snapshot.kind === 'EDIT_EVENT' &&
          outcome.snapshot.targetPublicId === null &&
          typeof outcome.snapshot.form['eventPublicId'] === 'string'
        ) {
          const chosen = outcome.snapshot.form['eventPublicId'];
          const prefilled = await this.prefillEvent(user, chosen);
          if (prefilled !== null) outcomeToDraw = { ...outcome, snapshot: prefilled };
        }

        const step = outcomeToDraw.step;

        // The consent gate draws itself: its buttons are an acceptance and a set
        // of channel links, neither of which is a choice from a list.
        if (outcome.snapshot.kind === 'ACCEPT_POLICIES') {
          const screen = await this.consentScreen(outcomeToDraw);
          return this.paint(updateId, user, outcomeToDraw.snapshot.lastMessageId, screen);
        }

        /**
         * `pick` is the one step whose options are a per-user read, so they are
         * loaded here rather than through `WizardDeps` — see the wizard's note.
         */
        const choices =
          step.key === 'pick'
            ? (await this.events.listOwned(user.id))
                .filter((event) => EDITABLE_EVENT_STATUSES.has(event.status))
                .map((event) => eventChoice(event.publicId, event.title))
            : step.load === undefined
              ? []
              : await step.load(outcomeToDraw.snapshot.form, this.wizardDeps());

        /**
         * `page` and `goto` carry where the *view* should be, not what was
         * answered — a page of cities, a month of the calendar. They are read off
         * the tap rather than stored, because they describe a screen rather than
         * a decision, and a stored one would survive a step it does not belong to.
         */
        const page = callback?.action === 'page' ? Number.parseInt(callback.value, 10) || 0 : 0;
        const anchor = callback?.action === 'goto' ? parseIsoDay(callback.value) : null;
        const earliest = tehranToday(new Date());

        const screen = renderStep({
          prompt: step.prompt(outcomeToDraw.snapshot.form),
          ui: step.ui,
          stepKey: step.key,
          choices,
          page,
          anchor: anchor ?? earliest,
          earliest,
          ...(outcomeToDraw.error !== undefined ? { error: outcomeToDraw.error } : {}),
          position: outcomeToDraw.position,
          total: outcomeToDraw.total,
          canGoBack: outcomeToDraw.position > 1,
          optional: step.optional === true,
          cancellable: step.cancellable !== false,
        });
        return this.paint(updateId, user, outcomeToDraw.snapshot.lastMessageId, screen);
      }
    }
  }

  /**
   * The consent gate's two screens.
   *
   * **The policy text is not stored in the draft.** It is read here, live, so a
   * version published while somebody is mid-acceptance is the one they are shown
   * and the one they accept — a snapshot in `form_data` would let a user agree to
   * a document that had been superseded while they read it.
   */
  /**
   * The consent screen.
   *
   * **The policy text is not stored in the draft.** It is read here, live, so a
   * version published while somebody is mid-acceptance is the one they are shown
   * and the one they accept — a snapshot in `form_data` would let a user agree to
   * a document that had been superseded while they read it.
   */
  private async consentScreen(
    outcome: Extract<ConversationOutcome, { kind: 'step' }>,
  ): Promise<WizardScreen> {
    const pending = await this.consent.currentPolicies();
    /**
     * The documents themselves, not their titles.
     *
     * The first version of this screen printed «TERMS v1 — قوانین استفاده از
     * پایه‌تَم» and an «می‌پذیرم» button, which is a label rather than something
     * anybody can agree to. `formatPolicies` renders the stored Markdown, and it
     * is passed through `prompt` — which `renderStep` escapes — so it is
     * assembled *after* that as pre-rendered HTML, the same arrangement
     * `BOT_WIZARD` already uses.
     */
    const documents = formatPolicies(
      pending.map((policy) => ({
        // `title_fa` is empty on the deployed rows; `label` is «TERMS v1».
        title: policy.titleFa !== null && policy.titleFa !== '' ? policy.titleFa : policy.label,
        summary: policy.changeSummaryFa ?? policy.summaryFa,
        contentMd: policy.contentMd,
      })),
    );

    const screen = renderStep({
      prompt: outcome.step.prompt({}),
      ui: 'confirm',
      stepKey: outcome.step.key,
      actions: [
        [
          {
            text: '✅ می‌پذیرم',
            callbackData: encodeWizardCallback({ action: 'agree', value: '' }),
          },
        ],
      ],
      position: outcome.position,
      total: outcome.total,
      canGoBack: false,
      optional: false,
      cancellable: false,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });

    // Appended after `renderStep` because the documents are already HTML and the
    // renderer escapes what it is given.
    return { ...screen, text: `${screen.text}\n\n${documents}` };
  }

  /**
   * Write the acceptance, then decide whether the channel gate still stands.
   *
   * `ConsentService.acceptPolicies` is the authority and the same call
   * `POST /onboarding/consent` makes — idempotent by a unique constraint, so a
   * double tap is one acceptance. The context it records names the bot rather
   * than an IP address, because there is no request here and inventing one would
   * put a fiction in a consent record.
   */
  private async finishConsent(updateId: number, user: BotUser): Promise<void> {
    const policies = await this.consent.currentPolicies();

    try {
      await this.consent.acceptPolicies(
        user.id,
        policies.map((policy) => policy.id),
        { appVersion: 'bot' },
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
      return;
    }

    await this.conversations.clear(user.id);

    /**
     * The channel requirement, checked *after* the acceptance rather than before.
     *
     * Two gates, cleared in this order deliberately: a user who has accepted the
     * terms but not joined a channel has made progress that must not be lost if
     * the probe fails. It is a **check, not a step** — an operator can switch the
     * requirement on next week or add a channel, so nobody ever "finishes" it,
     * which is exactly why the Mini App declares `/join-channels` outside
     * `ONBOARDING_PATHS`.
     *
     * The gate fails open on everything except an authoritative NOT_MEMBER
     * (`PROJECT_MEMORY` §8): a Telegram outage degrades the gate rather than the
     * product.
     */
    if (await this.channelsBlock(updateId, user)) return;

    /**
     * Consent, then the profile — the rest of onboarding, without being asked
     * for.
     *
     * The gate used to end at «ثبت شد ✅ حالا می‌توانید از پایه‌تم استفاده کنید»,
     * naming `/discover` and `/create_event`. Both of those then stopped the user
     * again, because **a user with no profile has no city**, and a city is what
     * `/discover` searches by and what `/create_event` asks for first. The
     * product congratulated somebody on finishing and then refused their next
     * two moves.
     *
     * So a new user is handed the profile form instead of a list of commands
     * that will not work yet. Somebody who already has a profile — a returning
     * user re-accepting a republished policy — gets the old message, because for
     * them it is true.
     */
    if (this.env.ENABLE_CONVERSATION_WIZARD && (await this.profiles.find(user.id)) === null) {
      await this.notice(
        updateId,
        user,
        'قوانین پذیرفته شد ✅\n\nیک قدم مانده: نمایه‌تان را کامل کنید تا بتوانید فعالیت بسازید و در فعالیت‌های نزدیک شرکت کنید.',
      );
      const outcome = await this.conversations.start(user.id, 'EDIT_PROFILE', updateId);
      return this.drawWizard(updateId, user, outcome);
    }

    await this.reply(updateId, user.id, TEMPLATES.BOT_CONSENT_ACCEPTED, {});
  }

  /**
   * Show the channel-join screen when the requirement stands, and say whether it
   * did.
   *
   * A message with links rather than a wizard step, for the reason
   * `finishConsent` gives. Returns true when the user was stopped, so callers
   * read as `if (await this.channelsBlock(...)) return;`.
   */
  private async channelsBlock(updateId: number, user: BotUser): Promise<boolean> {
    const state = await this.membership.stateFor(user.id);
    if (!state.required) return false;

    const missing = state.channels.filter((channel) => !channel.allowed);
    if (missing.length === 0) return false;

    const buttons = missing
      .filter((channel) => channel.joinUrl !== null)
      .map((channel) => [{ text: `عضویت در ${channel.title}`, url: channel.joinUrl as string }]);

    if (buttons.length === 0) {
      // Configured as required but with no join link — the operator's mistake,
      // and `ChannelConfigStatus` warns about it. Say what is true rather than
      // showing an empty keyboard.
      await this.notice(updateId, user, 'برای ادامه باید در کانال‌های اعلام‌شده عضو باشید.');
      return true;
    }

    await this.reply(updateId, user.id, TEMPLATES.BOT_CHANNEL_GATE, {
      keyboard: JSON.stringify(buttons),
    });
    return true;
  }

  /**
   * Fill the draft with what the chosen event currently says.
   *
   * Loaded through `findOwned`, which is **host-scoped**: a public id belonging
   * to somebody else's event is a `NOT_FOUND`, not a prefill. The button that
   * carried it was built from this user's own list, so the only way to get here
   * with a stranger's id is to forge one — and this is where that fails, in the
   * service, rather than in the button.
   */
  private async prefillEvent(
    user: BotUser,
    publicId: string,
  ): Promise<ConversationSnapshot | null> {
    let event;
    try {
      event = await this.events.findOwned(user.id, publicId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return null;
    }

    await this.conversations.rememberTarget(user.id, publicId);

    const startsAt = event.startsAt;
    const hours = Math.round((event.endsAt.getTime() - startsAt.getTime()) / 3_600_000);

    return this.conversations.patchForm(user.id, {
      title: event.title,
      description: event.description,
      categoryId: event.category.id,
      customCategoryLabel: event.customCategoryLabel ?? undefined,
      cityId: event.city.id,
      districtId: event.district?.id,
      day: isoDay(startsAt),
      hour: Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: TEHRAN,
          hour: '2-digit',
          hour12: false,
        }).format(startsAt),
      ),
      durationHours: hours > 0 ? hours : 2,
      capacity: event.capacity,
      costType: event.costType,
      costAmount: event.costAmount ?? undefined,
      minAge: event.minAge ?? undefined,
      maxAge: event.maxAge ?? undefined,
    });
  }

  /**
   * Save the edits.
   *
   * `EventService.update` takes a **partial**, and only the fields the host
   * actually walked through are sent — the draft was prefilled, so an unchanged
   * field is written back as the value it already had, which is a no-op rather
   * than a loss. `expectedVersion` is deliberately omitted: the contract says so
   * — *"the bot will edit the same events without a version to hand"*.
   */
  private async submitEventEdit(
    updateId: number,
    user: BotUser,
    snapshot: ConversationSnapshot,
  ): Promise<void> {
    const form = snapshot.form as EditEventForm;
    const publicId = snapshot.targetPublicId;
    if (publicId === null) {
      await this.notice(updateId, user, 'فعالیتی برای ویرایش انتخاب نشده است.');
      return;
    }

    const request = toUpdateEventInput(form, touchedFields(snapshot.form));
    try {
      await this.events.update(user.id, publicId, request);
      await this.conversations.clear(user.id);
      await this.notice(updateId, user, 'فعالیت به‌روز شد ✅');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The draft survives, for the reason it survives a refused creation.
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /** Edit the wizard's message, or send the first one. */
  private async paint(
    updateId: number,
    user: BotUser,
    lastMessageId: number | null,
    screen: WizardScreen,
  ): Promise<void> {
    if (lastMessageId === null) {
      await this.reply(updateId, user.id, TEMPLATES.BOT_WIZARD, {
        text: screen.text,
        keyboard: JSON.stringify(screen.keyboard),
      });
      return;
    }

    await this.queues.enqueue(
      QUEUES.TELEGRAM_SEND,
      JOBS.BOT_EDIT_MESSAGE,
      /**
       * One redraw per update: a redelivered update produces the same id and
       * BullMQ absorbs the second.
       *
       * The two parts are **separate arguments**, not joined with a colon.
       * `jobId` refuses a `:` because it would collide with BullMQ's own key
       * namespace — and building the id by hand threw on every single wizard
       * step in production, which `dispatch` caught and logged. The conversation
       * advanced in the database and nothing reached the screen, so the wizard
       * looked frozen after the first answer.
       */
      jobId('wizard', String(updateId), String(lastMessageId)),
      {
        userId: user.id,
        messageId: lastMessageId,
        text: screen.text,
        keyboard: screen.keyboard,
      },
    );
  }

  /**
   * Create the event the form describes.
   *
   * `EventService.create` is the authority and `createEventRequest` is the
   * schema — the same two the API uses. Nothing here decides what an event may
   * be; if the assembled form is refused, the refusal is the one the Mini App
   * would have shown, and the draft is **kept** so the user can correct it
   * rather than retyping sixteen answers.
   */
  private async submitWizard(
    updateId: number,
    user: BotUser,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const form = asCreateEventForm(raw);
    const request = toCreateEventRequest(form);
    if (request === null) {
      await this.notice(updateId, user, 'فرم کامل نیست. با «ویرایش» آن را تکمیل کنید.');
      return;
    }

    try {
      const created = await this.events.create(user.id, request);
      await this.conversations.clear(user.id);
      await this.reply(updateId, user.id, TEMPLATES.BOT_EVENT_CREATED, {
        title: form.title ?? '',
        eventPublicId: created.publicId,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The draft survives on purpose: a refusal the user can fix is not a reason
      // to make them start again.
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * Save the profile — creating it when there is none, editing it when there is.
   *
   * ── The bug this shape exists for ───────────────────────────────────────────
   *
   * This called `ProfileService.update` unconditionally, and `update` **refuses a
   * profile that does not exist**: its third statement is `if (!existing) throw
   * PROFILE_INCOMPLETE`, because an edit of nothing is not an edit. That was
   * correct while the wizard was only ever reached from `/edit_profile` by
   * somebody who had onboarded in the Mini App.
   *
   * v0.4.7 pointed the consent gate straight at this wizard, and every new user
   * therefore filled in a whole profile, pressed «ثبت», and was answered «برای
   * ادامه، ابتدا پروفایل خود را کامل کنید» — the Persian for `PROFILE_INCOMPLETE`,
   * reported by the very form that was completing it. Nothing was written, so
   * `/discover` refused them, `/profile` said they had no profile, and there was
   * no way out of it from inside the bot.
   *
   * ── Why two calls and not one ───────────────────────────────────────────────
   *
   * `complete` is an onboarding step: it advances `onboarding_state`, grants the
   * joining coins and moves the Trust Score. None of that may happen again when
   * somebody fixes a typo in their bio, and `ProfileService`'s own note says the
   * way to guarantee it cannot is for the edit path to hold no code that could.
   * So the branch belongs here, at the one place that knows which of the two the
   * user is doing.
   *
   * **Only the keys the user answered are sent on the edit path.** A skipped step
   * means "leave this alone", and building a full input with defaults would
   * quietly overwrite a bio somebody chose not to touch.
   *
   * **Creation has three fields it cannot invent.** Every step in this wizard is
   * optional — that is what makes it an *edit* wizard — so a first-time user can
   * skip their way to a form with no name, no birth year or no city, and
   * `CompleteProfileInput` requires all three. They are named back rather than
   * refused generically, and the draft survives so the answer is one tap away.
   */
  private async submitProfile(
    updateId: number,
    user: BotUser,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const form = raw as EditProfileForm;

    if ((await this.profiles.find(user.id)) === null) {
      return this.createProfile(updateId, user, form);
    }

    try {
      await this.profiles.update(
        user.id,
        {
          ...(form.displayName !== undefined ? { displayName: form.displayName } : {}),
          ...(form.gender !== undefined ? { gender: form.gender } : {}),
          ...(form.birthYear !== undefined ? { birthYear: form.birthYear } : {}),
          ...(form.cityId !== undefined ? { cityId: form.cityId } : {}),
          ...(form.districtId !== undefined ? { districtId: form.districtId } : {}),
          ...(form.bio !== undefined ? { bio: form.bio } : {}),
        },
        { kind: 'USER' },
      );
      await this.conversations.clear(user.id);
      await this.notice(updateId, user, 'نمایه شما به‌روز شد ✅');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The draft survives, for the reason it survives a refused event.
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * The first profile, through the wizard that used to be edit-only.
   *
   * `interestIds` is empty and that is a real gap rather than a placeholder: the
   * wizard has no interests step, and `complete` requires the array. Interests
   * drive discovery ranking, so a bot-onboarded user starts with none until the
   * wizard grows a step for them — which is better than the alternative this
   * replaces, where they had no profile at all.
   */
  private async createProfile(
    updateId: number,
    user: BotUser,
    form: EditProfileForm,
  ): Promise<void> {
    const missing: string[] = [];
    if (form.displayName === undefined) missing.push('نام');
    if (form.birthYear === undefined) missing.push('سال تولد');
    if (form.cityId === undefined) missing.push('شهر');

    if (
      form.displayName === undefined ||
      form.birthYear === undefined ||
      form.cityId === undefined
    ) {
      // The draft is left open on purpose: «ویرایش» on the summary walks back to
      // the step they skipped, and clearing it would make them start over.
      await this.notice(
        updateId,
        user,
        `برای ساختن نمایه به این مورد${missing.length > 1 ? 'ها' : ''} هم نیاز داریم: ` +
          `${missing.join('، ')}.\n\nروی «ویرایش» بزنید و کامل کنید.`,
      );
      return;
    }

    try {
      await this.profiles.complete(user.id, {
        displayName: form.displayName,
        birthYear: form.birthYear,
        cityId: form.cityId,
        ...(form.gender !== undefined ? { gender: form.gender } : {}),
        ...(form.districtId !== undefined ? { districtId: form.districtId } : {}),
        ...(form.bio !== undefined ? { bio: form.bio } : {}),
        interestIds: [],
      });
      await this.conversations.clear(user.id);
      await this.notice(
        updateId,
        user,
        'نمایه شما ساخته شد ✅\n\nحالا می‌توانید با /discover فعالیت‌های نزدیک را ببینید ' +
          'یا با /create_event یکی بسازید.',
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      // The draft survives, for the reason it survives a refused event.
      await this.notice(updateId, user, ERROR_MESSAGES_FA[error.code]);
    }
  }

  /**
   * The tags and the comment, onto a review whose rating is already in.
   *
   * `edit` rather than `submit`, and the rating is **read back rather than
   * asked for again**: it was written the moment the star was tapped, and asking
   * somebody to restate it would make the optional half feel like a second
   * review. `ReviewService.edit` replaces the whole thing, so anything not
   * carried here is cleared — which is why the rating goes back in unchanged.
   *
   * A closed edit window is not an error worth apologising for. The rating stands
   * and that is the part that matters; the notice says so rather than implying
   * the whole review was lost.
   */
  private async submitReviewDetail(
    updateId: number,
    user: BotUser,
    snapshot: ConversationSnapshot,
  ): Promise<void> {
    const form = snapshot.form as WriteReviewForm;
    const participantPublicId = snapshot.targetPublicId;

    await this.conversations.clear(user.id);

    // Both steps skipped: the rating is already written and there is nothing to
    // add, so saying «ثبت شد» twice would be the product congratulating itself.
    if (participantPublicId === null || (form.tag === undefined && form.comment === undefined)) {
      return;
    }

    try {
      const existing = await this.reviews.findOwn(user.id, participantPublicId);
      if (existing === null) return;

      await this.reviews.edit(user.id, participantPublicId, {
        rating: existing.rating,
        ...(form.tag !== undefined ? { tags: [form.tag] } : {}),
        ...(form.comment !== undefined ? { comment: form.comment } : {}),
      });
      await this.notice(updateId, user, 'نظر شما کامل شد ✅');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      await this.notice(updateId, user, `امتیاز شما ثبت شده است. ${ERROR_MESSAGES_FA[error.code]}`);
    }
  }

  /** The profile summary — only what was actually changed. */
  private async profileSummaryLines(form: EditProfileForm): Promise<SummaryLine[]> {
    const catalog = await this.catalog.snapshot();
    const city = catalog.cities.find((candidate) => candidate.id === form.cityId);

    const lines: SummaryLine[] = [];
    if (form.displayName !== undefined) lines.push({ label: 'نام', value: form.displayName });
    if (form.gender !== undefined) {
      lines.push({ label: 'جنسیت', value: genderLabel(form.gender) });
    }
    if (form.birthYear !== undefined) {
      lines.push({ label: 'سال تولد', value: toPersianDigits(String(form.birthYear)) });
    }
    if (city !== undefined) lines.push({ label: 'شهر', value: city.nameFa });
    if (form.bio !== undefined) lines.push({ label: 'معرفی', value: form.bio });

    // Everything skipped: the summary would be a heading over nothing.
    return lines.length > 0 ? lines : [{ label: 'تغییری ثبت نشد', value: 'همهٔ مرحله‌ها رد شدند' }];
  }

  /** What the wizard's `choice` steps load, resolved against the live catalog. */
  private wizardDeps(): WizardDeps {
    const snapshot = () => this.catalog.snapshot();
    return {
      categories: async () =>
        (await snapshot()).categories.map((category) =>
          categoryChoice(category.id, category.nameFa, category.allowsCustomLabel),
        ),
      provinces: async () =>
        (await snapshot()).provinces.map((province) => ({
          value: province.id,
          label: province.nameFa,
        })),
      citiesOf: async (provinceId) =>
        (await snapshot()).cities
          .filter((city) => city.provinceId === provinceId)
          .map((city) => ({ value: city.id, label: city.nameFa })),
      districtsOf: async (cityId) =>
        (await snapshot()).cities
          .find((city) => city.id === cityId)
          ?.districts.map((district) => ({ value: district.id, label: district.nameFa })) ?? [],
    };
  }

  /** The summary, in the order the questions were asked. */
  private async summaryLines(form: CreateEventForm): Promise<SummaryLine[]> {
    const catalog = await this.catalog.snapshot();
    const city = catalog.cities.find((candidate) => candidate.id === form.cityId);
    const category = catalog.categories.find((candidate) => candidate.id === form.categoryId);
    const day = form.day === undefined ? null : parseIsoDay(form.day);

    const district = city?.districts.find((candidate) => candidate.id === form.districtId);
    const where =
      city === undefined
        ? '—'
        : district === undefined
          ? city.nameFa
          : `${city.nameFa} — ${district.nameFa}`;

    /**
     * Everything the wizard has collected, whether or not it was asked on the
     * fast path.
     *
     * Production found this printing six fields and omitting the age range until
     * a *second* review screen — so a host who set one could not see it on the
     * screen with the «ثبت» button on it. A review that shows some of what is
     * about to be published is worse than none: it teaches people the list is
     * complete.
     *
     * Optional fields appear only when answered, which is different: an absent
     * row means «not set», and a «—» beside every unset field would bury the six
     * that matter.
     */
    const lines: SummaryLine[] = [
      { label: 'نام', value: form.title ?? '—' },
      { label: 'دسته', value: form.customCategoryLabel ?? category?.nameFa ?? '—' },
      { label: 'مکان', value: where },
      {
        label: 'زمان',
        value:
          day === null
            ? '—'
            : `${formatJalali(day)} — ساعت ${toPersianDigits(
                String(form.hour ?? 0).padStart(2, '0'),
              )}:۰۰`,
      },
      {
        label: 'مدت',
        value:
          form.durationHours === undefined
            ? '—'
            : `${toPersianDigits(String(form.durationHours))} ساعت`,
      },
      { label: 'ظرفیت', value: `${toPersianDigits(String(form.capacity ?? 0))} نفر` },
      { label: 'هزینه', value: costSummary(form) },
    ];

    if (form.genderPreference !== undefined) {
      lines.push({
        label: 'برای',
        value: form.genderPreference === 'MALE_ONLY' ? 'فقط آقایان' : 'فقط بانوان',
      });
    }
    if (form.minAge !== undefined || form.maxAge !== undefined) {
      lines.push({
        label: 'سن',
        value: `${toPersianDigits(String(form.minAge ?? 18))} تا ${toPersianDigits(
          String(form.maxAge ?? 120),
        )}`,
      });
    }
    if (form.rules !== undefined) lines.push({ label: 'قواعد', value: form.rules });
    if (form.externalLink !== undefined) lines.push({ label: 'لینک', value: form.externalLink });

    /**
     * The description is last and trimmed.
     *
     * It is up to 2000 characters and the summary shares one message with a
     * keyboard; printing it whole would push the «ثبت» button off a phone
     * screen. Enough to recognise what you wrote, not enough to re-read it.
     */
    if (form.description !== undefined) {
      const text =
        form.description.length > 160 ? `${form.description.slice(0, 159)}…` : form.description;
      lines.push({ label: 'توضیح', value: text });
    }

    return lines;
  }

  // ── replying ────────────────────────────────────────────────────────────────

  /**
   * Queue one reply and ask the worker to send it.
   *
   * The dedupe key is Telegram's `update_id`, which is monotonic and unique per
   * bot: a redelivered update — Telegram retries any webhook call that did not
   * answer 200 — produces the same key, the UNIQUE index absorbs the second
   * attempt, and the deterministic BullMQ job id makes the enqueue idempotent as
   * well. ADR-0005's two layers, applied to an inbound cause instead of an outbox
   * row.
   */
  private async reply(
    updateId: number,
    userId: string,
    templateKey: string,
    payload: ReplyPayload,
  ): Promise<void> {
    const queued = await this.notifications.queue({
      userId,
      templateKey,
      /**
       * The update **and the template**, because one update can produce two
       * messages.
       *
       * `/start` from somebody who owes an acceptance sends a welcome *and*
       * opens the consent gate. Keyed on the update alone the second is deduped
       * away by the UNIQUE index and silently never sends — which is a redelivery
       * guarantee doing exactly its job to a message that was not a redelivery.
       *
       * Per (update, template) is still exactly-once for the property that
       * matters: Telegram retrying one update produces the same pair of messages,
       * once each. What it stops being is exactly-one-message-per-update, which
       * was never the rule — only an assumption that held while every branch
       * replied once.
       */
      dedupeKey: `bot:${String(updateId)}:${templateKey}`,
      payload,
    });
    // Already queued by an earlier delivery of this same update. Enqueueing again
    // would be harmless — the job id is the same — but saying so is clearer.
    if (!queued.created) return;

    await this.queues.enqueue(
      QUEUES.TELEGRAM_SEND,
      JOBS.SEND_NOTIFICATION,
      jobId('notify', queued.id),
      { notificationId: queued.id },
    );
  }

  /** A one-sentence reply in the bot's own voice, rather than about an event. */
  private async notice(updateId: number, user: BotUser, text: string): Promise<void> {
    await this.reply(updateId, user.id, TEMPLATES.BOT_NOTICE, { text });
  }

  /**
   * Take a typed wizard answer out of the chat (report: "delete user messages").
   *
   * **A wizard is one message that changes, and half of it was not.** The bot
   * edits its own screen (ADR-0017), but every answer the user typed stayed
   * above it — so completing a profile left «۲۵», «تهران» and «کوهنوردی» stacked
   * over a form that had already absorbed all three, and the form that was
   * supposed to be a screen read as a transcript again.
   *
   * Enqueued rather than called, for the reason every other outbound Telegram
   * call is (invariant 11), and keyed on **the user and the message**: Telegram
   * numbers messages per chat, so two people's `message_id` collide routinely
   * and a job id without the user would silently drop the second deletion.
   *
   * There is no failure branch. The worker treats "could not delete" as done —
   * Telegram refuses anything older than 48 hours, and a message the user has
   * already removed is the outcome this wanted.
   */
  private async tidy(user: BotUser, telegramMessageId: number | undefined): Promise<void> {
    if (telegramMessageId === undefined) return;

    await this.queues.enqueue(
      QUEUES.TELEGRAM_SEND,
      JOBS.BOT_DELETE_MESSAGE,
      jobId('tidy', user.id, String(telegramMessageId)),
      { userId: user.id, messageId: telegramMessageId },
    );
  }

  private async answer(callbackQueryId: string, text: string): Promise<void> {
    await this.queues.enqueue(
      QUEUES.TELEGRAM_SEND,
      JOBS.BOT_CALLBACK_ANSWER,
      // Telegram's callback query id is unique per tap, so it is the job id: a
      // redelivered update answers the same query once.
      jobId('callback', callbackQueryId),
      { callbackQueryId, text },
    );
  }

  // ── resolving ───────────────────────────────────────────────────────────────

  /**
   * The sender, or null when we have never met them or they may not be here.
   *
   * **Null is silence, not a prompt.** Replying "press /start" needs a notification
   * row and there is no user to hang one on; the alternative — a job carrying a raw
   * Telegram id — would put an identifier into Redis to deliver a sentence almost
   * nobody will see. Telegram's own clients send `/start` on first contact and
   * `/start` creates the account, so the case this drops is a user whose account has
   * been anonymised (M15) writing again, and their next `/start` works normally.
   *
   * A banned or deleted account is silence for the same reason it is a 403 in the
   * API: `assertUsable` in `UserService` is the rule, and repeating it here keeps the
   * bot from becoming the one surface that forgot.
   */
  private async knownUser(from: BotSender): Promise<BotUser | null> {
    const user = await this.users.findByTelegramId(from.telegramUserId);
    if (!user || user.status === 'BANNED' || user.status === 'DELETED') return null;

    return {
      id: await this.users.resolveInternalId(user.publicId),
      publicId: user.publicId,
      telegramUserId: from.telegramUserId,
    };
  }

  /**
   * What to say when a plain message could belong to any of several conversations.
   *
   * Two situations, two answers, and telling them apart matters: somebody with no
   * live chat has nothing to reply *to*, so advising them to press "reply" would be
   * instructions they cannot follow.
   */
  private async ambiguityAdvice(userId: string): Promise<string> {
    const live = (await this.chats.listForUser(userId)).filter(
      (chat) => chat.status === 'ANONYMOUS' || chat.status === 'OPEN',
    );

    return live.length === 0
      ? 'گفتگوی بازی ندارید. با /discover یک فعالیت پیدا کنید و درخواست پیوستن بفرستید.'
      : 'چند گفتگوی باز دارید. روی پیام همان نفر «Reply» بزنید تا بدانم پاسخ برای کدام گفتگو است. برای دیدن فهرست گفتگوها /chats را بفرستید.';
  }
}

/**
 * How many activities `/discover` renders.
 *
 * Well under `buildDigest`'s own ceiling, and deliberately so: this is a *taste*
 * of what is on, not the catalogue. Twenty results in a Telegram message is a
 * wall somebody scrolls past; five is a reason to open the app, which is where
 * the filters and the join button are.
 */
const DISCOVER_LIMIT = 5;

/**
 * How much of the ledger `/wallet` shows.
 *
 * Twenty rather than `historyOf`'s default fifty: a digest is one Telegram
 * message, and `buildDigest` would drop the tail of fifty anyway with a line
 * saying what did not fit. Asking for what fits is more honest than asking for
 * more and truncating it.
 */
const WALLET_HISTORY_LIMIT = 20;

/** The same reasoning as `WALLET_HISTORY_LIMIT`: what fits in one message. */
const TRUST_HISTORY_LIMIT = 20;

/** The same reasoning again: what fits in one Telegram message. */
const RECEIVED_REVIEW_LIMIT = 15;

/**
 * The statuses a host may still act on.
 *
 * A cancelled or finished activity cannot be published, invited for, or
 * cancelled again, and `EventService` refuses all three — so the buttons are not
 * drawn rather than drawn and refused.
 */
const OPEN_EVENT_STATUSES = new Set(['DRAFT', 'PUBLISHED']);

/**
 * The case statuses a decision may still be taken on (ADR-0018).
 *
 * The same three `listCases` queues by default and the same three `decideCase`
 * admits. It is checked before the form opens as well as inside the service —
 * the service is the authority, and this saves a moderator writing a note into a
 * form whose submit cannot land.
 */
const OPEN_CASE_STATUSES = new Set(['OPEN', 'IN_REVIEW', 'ESCALATED']);

/**
 * What «امروز» and «این هفته» mean, in Tehran.
 *
 * `dateFrom` is **now** rather than the start of the day: an activity that began
 * two hours ago is not something anybody can still join, and a "today" that
 * listed it would be answering a different question. `dateTo` is the end of the
 * window, so «امروز» ends at midnight Tehran rather than twenty-four hours out —
 * a person asking what is on today means the day, not the next day either.
 */
function dateRangeFor(when: DiscoverWhen, now: Date): { from: Date; to: Date } | null {
  if (when === 'a') return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TEHRAN,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // Midnight *tonight* in Tehran, expressed as the instant the next day starts.
  const endOfToday = new Date(`${parts}T23:59:59.999+03:30`);

  return {
    from: now,
    to: when === 't' ? endOfToday : new Date(endOfToday.getTime() + 6 * 86_400_000),
  };
}

/**
 * Is this letter one the report protocol knows?
 *
 * The form carries a string because `form_data` is JSON, and a draft written by
 * a newer deploy could name a letter this build has no target for. Narrowed here
 * rather than cast, so an unknown one is dropped rather than indexed into
 * `REPORT_TARGETS` as `undefined` and sent to the service as a missing type.
 */
function isReportTarget(value: string): value is ReportTargetLetter {
  return Object.hasOwn(REPORT_TARGETS, value);
}

/**
 * The zone every wall-clock answer in a wizard is read in.
 *
 * A literal rather than `env.APP_TIMEZONE`, for the same reason `formatTehran`
 * is: the product is Tehran-local by policy (D12, ADR-0008), and a configurable
 * zone here would let a deploy silently move every event a host has scheduled.
 */
const TEHRAN = 'Asia/Tehran';

/**
 * The statuses an event may still be edited in.
 *
 * A cancelled or completed event is history, and a deleted one is gone. The
 * authority is still `EventService.update`, which refuses the rest on its own —
 * this only decides what is worth *offering*, because a list whose entries
 * mostly refuse is a list that wastes a tap to say no.
 */
const EDITABLE_EVENT_STATUSES = new Set(['DRAFT', 'PENDING_MODERATION', 'PUBLISHED', 'HIDDEN']);

/**
 * `/start ref_ABCD2345` and `/start ABCD2345` are the same invitation.
 *
 * A prefix is what a link generator naturally adds. `normalizeCode` in the domain
 * strips whitespace and hyphens but not this, and it is stripped here — where the
 * link format is known — rather than by loosening a validator the API also uses.
 */
function stripReferralPrefix(payload: string): string {
  return payload.replace(/^ref[_-]/i, '');
}

/**
 * The assembled form, as the contract wants it — or null when it is not finished.
 *
 * Null rather than a partial: `EventService.create` takes a `CreateEventRequest`
 * and every field below is one the schema requires. A form reaching here
 * incomplete means a step was skipped that should not have been, and inventing a
 * default for it would publish an event nobody described.
 *
 * `startsAt` and `endsAt` are built here because this is where the two halves
 * meet: the day came from a calendar button and the hour from a list, and the
 * database stores the UTC instant they name (ADR-0008).
 */
function toCreateEventRequest(form: CreateEventForm): CreateEventInput | null {
  const day = form.day === undefined ? null : parseIsoDay(form.day);
  if (
    form.title === undefined ||
    form.description === undefined ||
    form.categoryId === undefined ||
    form.cityId === undefined ||
    form.capacity === undefined ||
    form.costType === undefined ||
    form.hour === undefined ||
    day === null
  ) {
    return null;
  }

  const parts = isoDay(day)
    .split('-')
    .map((part: string) => Number.parseInt(part, 10)) as [number, number, number];
  const startsAt = zonedTimeToUtc(parts[0], parts[1], parts[2], form.hour, 0, TEHRAN);
  const endsAt = new Date(startsAt.getTime() + (form.durationHours ?? 2) * 3_600_000);

  return {
    title: form.title,
    description: form.description,
    categoryId: form.categoryId,
    cityId: form.cityId,
    startsAt,
    endsAt,
    capacity: form.capacity,
    costType: form.costType,
    ...(form.customCategoryLabel !== undefined
      ? { customCategoryLabel: form.customCategoryLabel }
      : {}),
    ...(form.districtId !== undefined ? { districtId: form.districtId } : {}),
    ...(form.costAmount !== undefined ? { costAmount: form.costAmount } : {}),
    ...(form.costNote !== undefined ? { costNote: form.costNote } : {}),
    ...(form.rules !== undefined ? { rules: form.rules } : {}),
    ...(form.genderPreference !== undefined ? { genderPreference: form.genderPreference } : {}),
    ...(form.minAge !== undefined ? { minAge: form.minAge } : {}),
    ...(form.maxAge !== undefined ? { maxAge: form.maxAge } : {}),
    ...(form.externalLink !== undefined ? { externalLink: form.externalLink } : {}),
  };
}

/** «رایگان» / «۵۰٬۰۰۰ تومان» / «دنگی», for the summary. */
function costSummary(form: CreateEventForm): string {
  switch (form.costType) {
    case 'FREE':
      return 'رایگان';
    case 'SPLIT':
      return 'دنگی';
    case 'FIXED':
    case 'APPROX':
      return `${toPersianDigits(String(form.costAmount ?? 0))} تومان`;
    default:
      return '—';
  }
}

/**
 * The edited form, as `EventService.update` wants it.
 *
 * A partial, and every key is present because the draft was **prefilled** from
 * the event — so a field the host skipped is written back as what it already
 * said. That is a no-op at the database and it is why an edit cannot silently
 * clear something: there is no "absent means delete" path through this.
 *
 * `startsAt`/`endsAt` are rebuilt only when both halves are known, for the same
 * reason `toCreateEventRequest` refuses an incomplete form: a time assembled
 * from a missing hour would move an event to midnight.
 */
function toUpdateEventInput(form: EditEventForm, touched: Set<string>): UpdateEventInput {
  const input: UpdateEventInput = {};
  const changed = (key: keyof EditEventForm): boolean =>
    touched.has(key) && form[key] !== undefined;

  if (changed('title')) input.title = form.title as string;
  if (changed('description')) input.description = form.description as string;
  if (changed('categoryId')) input.categoryId = form.categoryId as string;
  if (changed('customCategoryLabel')) {
    input.customCategoryLabel = form.customCategoryLabel as string;
  }
  if (changed('cityId')) input.cityId = form.cityId as string;
  if (changed('districtId')) input.districtId = form.districtId as string;
  if (changed('capacity')) input.capacity = form.capacity as number;
  if (changed('costType')) input.costType = form.costType as CostType;
  if (changed('costAmount')) input.costAmount = form.costAmount as number;
  if (changed('minAge')) input.minAge = form.minAge as number;
  if (changed('maxAge')) input.maxAge = form.maxAge as number;

  /**
   * The time is rebuilt only when the host actually answered one of its steps.
   *
   * The wizard offers whole hours, so rebuilding from a *prefilled* day and hour
   * would move an event scheduled at 22:45 to 22:00 — a change the host did not
   * ask for, made by skipping a question. Both halves are read from the form
   * because either may be the prefilled one; what gates the write is that at
   * least one was chosen.
   */
  const day = form.day === undefined ? null : parseIsoDay(form.day);
  const timeChosen = touched.has('day') || touched.has('hour') || touched.has('durationHours');
  if (timeChosen && day !== null && form.hour !== undefined) {
    const parts = isoDay(day)
      .split('-')
      .map((part: string) => Number.parseInt(part, 10)) as [number, number, number];
    const startsAt = zonedTimeToUtc(parts[0], parts[1], parts[2], form.hour, 0, TEHRAN);
    input.startsAt = startsAt;
    input.endsAt = new Date(startsAt.getTime() + (form.durationHours ?? 2) * 3_600_000);
  }

  return input;
}
