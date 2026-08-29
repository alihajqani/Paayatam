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
  EventService,
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
  zonedTimeToUtc,
  type ConversationSnapshot,
  type CreateEventInput,
  type EditEventForm,
  type EditProfileForm,
  type UpdateEventInput,
  type ConversationOutcome,
  type CreateEventForm,
  type WizardDeps,
  type WizardInput,
  TrustService,
  UserService,
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
  formatDiscovered,
  formatJalali,
  formatPolicies,
  menuCommandFor,
  formatTehran,
  formatMyChats,
  formatPendingReviews,
  formatMyEvents,
  formatMyRequests,
  parseChatCallback,
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
  type ParsedUpdate,
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
    private readonly notifications: NotificationService,
    private readonly queues: QueueService,
    private readonly limiter: RateLimitService,
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
            return this.onCommand(update.updateId, user, intent.command);
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
  private async onCommand(updateId: number, user: BotUser, command: string): Promise<void> {
    switch (command.toLowerCase()) {
      case 'help':
        return this.reply(updateId, user.id, TEMPLATES.BOT_HELP, {});

      case 'balance': {
        const balance = await this.coins.balanceOf(user.id);
        return this.reply(updateId, user.id, TEMPLATES.BOT_BALANCE, { balance });
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
        return this.reply(updateId, user.id, TEMPLATES.BOT_REQUESTS, { text });
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
        return this.reply(updateId, user.id, TEMPLATES.BOT_MY_EVENTS, { text });
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
        if (profile === null) {
          return this.notice(
            updateId,
            user,
            'هنوز نمایه‌ای نساخته‌اید. برای تکمیل نمایه برنامه را باز کنید.',
          );
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
      case 'discover': {
        const profile = await this.profiles.find(user.id);
        if (profile === null) {
          return this.notice(
            updateId,
            user,
            'برای دیدن فعالیت‌های نزدیک، نخست نمایه‌تان را در برنامه کامل کنید.',
          );
        }

        const page = await this.discovery.search(user.id, {
          cityId: profile.city.id,
          hasCapacity: true,
          limit: DISCOVER_LIMIT,
        });
        const text = formatDiscovered(
          page.events.map((event) => ({
            title: event.title,
            categoryName: event.customCategoryLabel ?? event.categoryNameFa,
            where:
              event.districtNameFa === null
                ? event.cityNameFa
                : `${event.cityNameFa} — ${event.districtNameFa}`,
            startsAt: event.startsAt,
            // Subtracted here because the domain row carries the two counts and
            // only the wire contract precomputes the difference.
            remainingCapacity: Math.max(event.capacity - event.acceptedCount, 0),
          })),
        );
        return this.reply(updateId, user.id, TEMPLATES.BOT_DISCOVER, { text });
      }

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
        return this.reply(updateId, user.id, TEMPLATES.BOT_REVIEWS, { text });
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
        const accepted = standing.accepted
          .map(
            (entry) =>
              `• <b>${entry.policy.titleFa ?? entry.policy.label}</b>\n  ${formatTehran(
                entry.acceptedAt,
              )}`,
          )
          .join('\n');

        return this.reply(updateId, user.id, TEMPLATES.BOT_TERMS_STANDING, {
          text:
            accepted === '' ? 'سندی ثبت نشده است.' : `<b>قوانینی که پذیرفته‌اید</b>\n\n${accepted}`,
        });
      }

      case 'cancel': {
        await this.conversations.clear(user.id);
        return this.notice(updateId, user, 'لغو شد.');
      }

      default:
        return this.notice(
          updateId,
          user,
          'این فرمان را نمی‌شناسم. برای دیدن فهرست فرمان‌ها /help را بفرستید.',
        );
    }
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
    await this.gateAfterWelcome(updateId, { id: userId, publicId: created.publicId });
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
      if (wizard !== null) return this.drawWizard(updateId, user, wizard);
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
    await this.notice(
      updateId,
      user,
      'این بخش موقتاً در دسترس نیست. فعلاً از برنامه استفاده کنید.',
    );
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
          case 'EDIT_EVENT':
            return this.submitEventEdit(updateId, user, outcome.snapshot);
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
          const screen = renderSummary(await this.profileSummaryLines(profile), false);
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
   * Save the profile edits.
   *
   * **Only the keys the user answered are sent.** `UpdateProfileInput` takes a
   * partial, and a skipped step means "leave this alone" — building a full input
   * with defaults would quietly overwrite a bio somebody chose not to touch.
   * `ProfileService.update` is the authority, and it is the same call the Mini
   * App's edit screen makes.
   */
  private async submitProfile(
    updateId: number,
    user: BotUser,
    raw: Record<string, unknown>,
  ): Promise<void> {
    const form = raw as EditProfileForm;

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

    return { id: await this.users.resolveInternalId(user.publicId), publicId: user.publicId };
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
      ? 'گفتگوی بازی ندارید. از برنامه یک فعالیت انتخاب کنید و درخواست پیوستن بفرستید.'
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
