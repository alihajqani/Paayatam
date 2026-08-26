import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type {
  DeliveryStatus,
  MessageCampaignKind,
  MessageCampaignStatus,
  Prisma,
} from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode, validateTelegramMessage } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolation } from '../identity/user.service';

/**
 * Who a campaign is for, as data.
 *
 * Every field narrows; an empty audience is refused rather than treated as
 * "everybody", because "I forgot to set a filter" and "I meant everybody" produce
 * the same request and only one of them is a decision. Reaching every user is
 * `everyone: true`, spelled out.
 */
export interface MessageAudience {
  /** An explicit list, by public id. The only way to reach one named person. */
  userPublicIds?: string[] | undefined;
  cityIds?: string[] | undefined;
  /** `ACTIVE` or `SUSPENDED`. Banned and deleted accounts are never reachable. */
  status?: 'ACTIVE' | 'SUSPENDED' | undefined;
  /** True for users who finished onboarding, false for those who did not. */
  profileComplete?: boolean | undefined;
  /** True for users who have hosted at least one event. */
  hasHostedEvent?: boolean | undefined;
  /** Users who have taken part in an event of any of these categories. */
  participatedCategoryIds?: string[] | undefined;
  /** Deliberate, and the only way to select the whole user base. */
  everyone?: boolean | undefined;
}

export interface MessageCampaignSummary {
  publicId: string;
  kind: MessageCampaignKind;
  status: MessageCampaignStatus;
  bodyText: string;
  parseMode: string | null;
  dryRun: boolean;
  estimatedRecipients: number;
  counts: DeliveryCounts;
  audience: MessageAudience;
  eventPublicId: string | null;
  pausedAt: Date | null;
  pauseReason: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  cancelledAt: Date | null;
}

export interface DeliveryCounts {
  total: number;
  pending: number;
  sent: number;
  rateLimited: number;
  blocked: number;
  invalid: number;
  failed: number;
  skipped: number;
}

/** One recipient the dispatcher has to enqueue. */
export interface PendingDelivery {
  recipientId: string;
  campaignId: string;
  userId: string;
}

/** What the sender needs, resolved at the last possible moment. */
export interface DeliveryTarget {
  recipientId: string;
  campaignPublicId: string;
  bodyText: string;
  parseMode: 'HTML' | undefined;
  /** Null when the account has no Telegram link or the bot is blocked. */
  telegramUserId: bigint | null;
  botBlocked: boolean;
}

/**
 * How many consecutive rate limits stop a campaign.
 *
 * Three is deliberately low. `TelegramClient` already absorbs a 429 by sleeping
 * for whatever `retry_after` asks, and BullMQ's limiter paces the queue below
 * Telegram's ceiling — so a rate limit that survives both of those is not a burst,
 * it is Telegram telling us to stop. Pushing through it is how a bot gets
 * restricted, which costs every other message in the product.
 */
export const RATE_LIMIT_BREAKER_THRESHOLD = 3;

/**
 * Outbound campaigns: one message to one person, a broadcast, or a paid
 * invitation (M22 phases 4, 11 and 12).
 *
 * ── Nothing here sends anything ──────────────────────────────────────────────
 *
 * Not one method in this file calls Telegram. Selection, confirmation and
 * bookkeeping happen in the API; delivery happens in the worker through the one
 * rate-limited queue (ADR-0005, invariant 11). That separation is what makes
 * "a broadcast to four thousand people" a request that returns in milliseconds
 * rather than a request that times out having sent nine hundred.
 *
 * ── The four properties worth stating ────────────────────────────────────────
 *
 * **A draft cannot send.** `DRAFT → CONFIRMED` is a separate request from a
 * separate button, and it is the only edge into delivery. A CHECK in migration
 * 0021 additionally forbids a dry run from ever reaching a sending state, so
 * "preview" and "send" are different verbs rather than a flag somebody forgets.
 *
 * **A double-tap produces one campaign.** `message_campaign.idempotency_key` is
 * UNIQUE, exactly as `coin_ledger.idempotency_key` is, and the create path
 * collides on it rather than checking for a recent duplicate.
 *
 * **A recipient is enqueued at most once.** `UNIQUE (campaign_id, user_id)` plus
 * BullMQ's deterministic job id are two independent layers, and they fail
 * independently — the first survives a flushed Redis, the second survives a
 * dispatcher that runs twice in the same second.
 *
 * **A blocked recipient is terminal, not a failure.** Retrying somebody who has
 * blocked the bot burns the rate budget every other user's notifications need.
 */
@Injectable()
export class MessagingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  // ── Selection ──────────────────────────────────────────────────────────────

  /**
   * How many people this audience reaches, without writing anything.
   *
   * A count and nothing else: the preview must never be a way to enumerate users.
   * An operator deciding whether to send needs the size, not the list — and the
   * list is exactly what would turn a `message.send` permission into a data
   * export.
   */
  async estimate(audience: MessageAudience): Promise<number> {
    return this.prisma.user.count({ where: this.whereFor(audience) });
  }

  /**
   * The audience as a Prisma filter.
   *
   * Three exclusions are unconditional and are not part of the audience shape,
   * because they are not choices an operator gets to make:
   *
   *  - **Banned and deleted accounts.** There is nobody to message.
   *  - **Accounts with no Telegram link.** Every user has one today; the filter is
   *    what keeps that true if one ever does not.
   *  - **Accounts that have blocked the bot.** `bot_blocked` is set when Telegram
   *    answers 403, and re-attempting a block is the single cheapest way to waste
   *    the global rate budget (ADR-0005).
   */
  private whereFor(audience: MessageAudience): Prisma.UserWhereInput {
    const narrowing =
      audience.everyone === true ||
      audience.userPublicIds !== undefined ||
      audience.cityIds !== undefined ||
      audience.status !== undefined ||
      audience.profileComplete !== undefined ||
      audience.hasHostedEvent !== undefined ||
      audience.participatedCategoryIds !== undefined;

    if (!narrowing) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'audience', message: 'an audience must narrow, or say everyone' }],
      });
    }

    const where: Prisma.UserWhereInput = {
      status: audience.status ?? { in: ['ACTIVE', 'SUSPENDED'] },
      deletedAt: null,
      telegramAccount: { is: { botBlocked: false } },
    };

    if (audience.userPublicIds !== undefined) {
      where.publicId = { in: [...new Set(audience.userPublicIds)] };
    }
    if (audience.profileComplete !== undefined) {
      where.onboardingState = audience.profileComplete
        ? 'PROFILE_COMPLETE'
        : { in: ['NEW', 'TERMS_ACCEPTED'] };
    }
    if (audience.cityIds !== undefined) {
      where.profile = { is: { cityId: { in: [...new Set(audience.cityIds)] } } };
    }
    if (audience.hasHostedEvent !== undefined) {
      where.hostedEvents = audience.hasHostedEvent ? { some: {} } : { none: {} };
    }
    if (audience.participatedCategoryIds !== undefined) {
      where.participations = {
        some: {
          // ACCEPTED or COMPLETED: somebody who asked and was refused did not take
          // part in that category, and treating them as though they had would put
          // an interest in the filter that the data does not support.
          status: { in: ['ACCEPTED', 'COMPLETED'] },
          event: { categoryId: { in: [...new Set(audience.participatedCategoryIds)] } },
        },
      };
    }

    return where;
  }

  // ── Creating and confirming ────────────────────────────────────────────────

  /**
   * Record a campaign. **Nothing is sent, and a dry run never will be.**
   *
   * A dry run materialises its recipients and reports the counts, then finishes at
   * `COMPLETED` without ever entering `QUEUED`. That is what makes a rehearsal
   * honest — it exercises the same selection the real send would — and migration
   * 0021's CHECK is what makes it impossible to turn one into a send afterwards.
   */
  async createCampaign(input: {
    kind: MessageCampaignKind;
    bodyText: string;
    parseMode?: 'HTML' | undefined;
    audience: MessageAudience;
    dryRun?: boolean | undefined;
    idempotencyKey: string;
    actor: { type: 'ADMIN'; adminUserId: string } | { type: 'USER'; userId: string };
    eventId?: string | undefined;
    coinLedgerId?: string | undefined;
  }): Promise<MessageCampaignSummary> {
    const verdict = validateTelegramMessage(input.bodyText, input.parseMode);
    if (!verdict.ok) {
      throw new AppError(ErrorCode.MESSAGE_FORMAT_INVALID, { problems: verdict.problems });
    }

    const now = this.clock.now();
    const dryRun = input.dryRun === true;

    let campaign;
    try {
      campaign = await this.prisma.messageCampaign.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          kind: input.kind,
          status: 'DRAFT',
          bodyText: input.bodyText,
          parseMode: input.parseMode ?? null,
          filter: input.audience as Prisma.InputJsonValue,
          dryRun,
          actorType: input.actor.type,
          actorAdminId: input.actor.type === 'ADMIN' ? input.actor.adminUserId : null,
          actorUserId: input.actor.type === 'USER' ? input.actor.userId : null,
          eventId: input.eventId ?? null,
          coinLedgerId: input.coinLedgerId ?? null,
          createdAt: now,
        },
        select: CAMPAIGN_SELECT,
      });
    } catch (error) {
      // The unique key answering: this intention already produced a campaign.
      // Returned rather than refused — a retried request should see what the first
      // one made, which is what an idempotency key is for.
      if (isUniqueViolation(error)) return this.getByIdempotencyKey(input.idempotencyKey);
      throw error;
    }

    const created = await this.materialise(campaign.id, input.audience, now);

    if (dryRun) {
      await this.prisma.messageCampaign.update({
        where: { id: campaign.id },
        data: {
          status: 'COMPLETED',
          estimatedRecipients: created,
          startedAt: now,
          finishedAt: now,
        },
      });
    } else {
      await this.prisma.messageCampaign.update({
        where: { id: campaign.id },
        data: { estimatedRecipients: created },
      });
    }

    return this.get(campaign.publicId);
  }

  /**
   * Write one `message_recipient` row per selected user.
   *
   * Done at **creation** rather than at confirmation, so the number an operator
   * confirms is the number that was actually selected — a count taken now and a
   * selection taken later can differ by whoever signed up in between, and "you
   * said 400 and sent 412" is a support conversation nobody wants to have.
   *
   * `skipDuplicates` on the unique key, so running this twice writes nothing the
   * second time.
   */
  private async materialise(
    campaignId: string,
    audience: MessageAudience,
    now: Date,
  ): Promise<number> {
    const where = this.whereFor(audience);

    // Paged rather than one `findMany`: a broadcast can select the whole user
    // base, and holding every id in memory to build one enormous INSERT is the
    // kind of thing that works until the day it does not.
    const PAGE = 1_000;
    let created = 0;
    let cursor: string | undefined;

    for (;;) {
      const page: { id: string }[] = await this.prisma.user.findMany({
        where,
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      if (page.length === 0) break;

      const result = await this.prisma.messageRecipient.createMany({
        data: page.map((user) => ({ campaignId, userId: user.id, createdAt: now })),
        skipDuplicates: true,
      });
      created += result.count;

      if (page.length < PAGE) break;
      cursor = page[page.length - 1]?.id;
    }

    return created;
  }

  /**
   * The second button. `DRAFT → QUEUED`, and the only edge into delivery.
   *
   * Refuses a dry run outright rather than promoting it: a rehearsal that can
   * become a send is a rehearsal nobody trusts, and the operator has the original
   * request to send for real.
   */
  async confirm(
    publicId: string,
    confirmedByAdminId: string | null,
  ): Promise<MessageCampaignSummary> {
    const now = this.clock.now();

    const campaign = await this.prisma.messageCampaign.findUnique({
      where: { publicId },
      select: { id: true, status: true, dryRun: true },
    });
    if (campaign === null) throw new AppError(ErrorCode.NOT_FOUND);
    if (campaign.dryRun) throw new AppError(ErrorCode.MESSAGE_DRY_RUN);
    if (campaign.status !== 'DRAFT') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    // Conditional on the status, so two operators confirming at once produce one
    // transition rather than two.
    const { count } = await this.prisma.messageCampaign.updateMany({
      where: { id: campaign.id, status: 'DRAFT' },
      data: {
        status: 'QUEUED',
        confirmedAt: now,
        confirmedByAdminId,
      },
    });
    if (count === 0) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    return this.get(publicId);
  }

  /**
   * Stop a campaign.
   *
   * Every recipient still `PENDING` becomes `SKIPPED`, which is what makes cancel
   * mean something: the dispatcher selects on `PENDING`, so after this there is
   * nothing left to claim. Anything already handed to Telegram has been sent and
   * is not recalled — nothing can recall it.
   */
  async cancel(
    publicId: string,
    cancelledByAdminId: string | null,
  ): Promise<MessageCampaignSummary> {
    const now = this.clock.now();

    const campaign = await this.prisma.messageCampaign.findUnique({
      where: { publicId },
      select: { id: true, status: true },
    });
    if (campaign === null) throw new AppError(ErrorCode.NOT_FOUND);
    if (!CANCELLABLE.has(campaign.status)) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    await this.prisma.$transaction([
      this.prisma.messageRecipient.updateMany({
        where: { campaignId: campaign.id, status: 'PENDING' },
        data: { status: 'SKIPPED' },
      }),
      this.prisma.messageCampaign.updateMany({
        where: { id: campaign.id, status: { in: [...CANCELLABLE] } },
        data: { status: 'CANCELLED', cancelledAt: now, cancelledByAdminId },
      }),
    ]);

    await this.refreshCounts(campaign.id);
    return this.get(publicId);
  }

  /** Stop claiming without cancelling. The breaker's action, and an admin's. */
  async pause(campaignId: string, reason: string): Promise<void> {
    await this.prisma.messageCampaign.updateMany({
      where: { id: campaignId, pausedAt: null },
      data: { pausedAt: this.clock.now(), pauseReason: reason.slice(0, 200) },
    });
  }

  async resume(publicId: string): Promise<MessageCampaignSummary> {
    const campaign = await this.prisma.messageCampaign.findUnique({
      where: { publicId },
      select: { id: true, pausedAt: true },
    });
    if (campaign === null) throw new AppError(ErrorCode.NOT_FOUND);
    if (campaign.pausedAt === null) throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    await this.prisma.messageCampaign.update({
      where: { id: campaign.id },
      data: { pausedAt: null, pauseReason: null },
    });
    return this.get(publicId);
  }

  // ── What the worker calls ──────────────────────────────────────────────────

  /**
   * Campaigns the dispatcher should be working, oldest first.
   *
   * `QUEUED` is promoted to `SENDING` here rather than by the confirming request,
   * because "started" should mean the worker picked it up — a campaign confirmed
   * while the worker is down has not started.
   */
  async claimSendingCampaigns(limit = 5): Promise<{ id: string; publicId: string }[]> {
    const now = this.clock.now();

    await this.prisma.messageCampaign.updateMany({
      where: { status: 'QUEUED' },
      data: { status: 'SENDING', startedAt: now },
    });

    return this.prisma.messageCampaign.findMany({
      where: { status: 'SENDING', pausedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, publicId: true },
    });
  }

  /**
   * The next batch of recipients to enqueue.
   *
   * Nothing is mutated. The rows stay `PENDING` until a send job resolves them,
   * and re-enqueueing is harmless because the BullMQ job id is derived from the
   * recipient — a dispatcher that runs twice adds the same ids twice, and the
   * second add is a no-op.
   */
  async pendingDeliveries(campaignId: string, limit = 500): Promise<PendingDelivery[]> {
    const rows = await this.prisma.messageRecipient.findMany({
      where: { campaignId, status: 'PENDING' },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, campaignId: true, userId: true },
    });
    return rows.map((row) => ({
      recipientId: row.id,
      campaignId: row.campaignId,
      userId: row.userId,
    }));
  }

  /**
   * Everything one send needs, including whether there is anybody at the far end.
   *
   * `telegram_user_id` is read **here and in `NotificationService.load`** and
   * nowhere else outside the identity module — this is a path that actually talks
   * to Telegram, which is the one legitimate reason (invariant 7). It goes to the
   * client and never into a payload, a log line or a response.
   *
   * Returns null for a campaign that has since been cancelled or paused, so a job
   * already sitting in Redis when somebody hits cancel does not deliver.
   */
  async loadDelivery(recipientId: string): Promise<DeliveryTarget | null> {
    const row = await this.prisma.messageRecipient.findUnique({
      where: { id: recipientId },
      select: {
        id: true,
        status: true,
        campaign: {
          select: {
            publicId: true,
            status: true,
            pausedAt: true,
            dryRun: true,
            bodyText: true,
            parseMode: true,
          },
        },
        user: {
          select: { telegramAccount: { select: { telegramUserId: true, botBlocked: true } } },
        },
      },
    });
    if (row === null) return null;
    // Already resolved: a redelivered job finds this and stops.
    if (row.status !== 'PENDING') return null;
    if (row.campaign.dryRun) return null;
    if (row.campaign.pausedAt !== null) return null;
    if (row.campaign.status !== 'SENDING') return null;

    return {
      recipientId: row.id,
      campaignPublicId: row.campaign.publicId,
      bodyText: row.campaign.bodyText,
      parseMode: row.campaign.parseMode === 'HTML' ? 'HTML' : undefined,
      telegramUserId: row.user.telegramAccount?.telegramUserId ?? null,
      botBlocked: row.user.telegramAccount?.botBlocked ?? false,
    };
  }

  /**
   * Record what happened to one delivery.
   *
   * Conditional on `PENDING`, so a redelivered job cannot overwrite a terminal
   * outcome with a different one — the row is the second idempotency layer, and it
   * only works if it is written once.
   */
  async recordDelivery(
    recipientId: string,
    outcome: {
      status: DeliveryStatus;
      telegramMessageId?: number | undefined;
      error?: string | undefined;
    },
  ): Promise<void> {
    await this.prisma.messageRecipient.updateMany({
      where: { id: recipientId, status: 'PENDING' },
      data: {
        status: outcome.status,
        attempts: { increment: 1 },
        lastError: outcome.error?.slice(0, 500) ?? null,
        telegramMessageId: outcome.telegramMessageId ?? null,
        sentAt: outcome.status === 'SENT' ? this.clock.now() : null,
      },
    });
  }

  /** A retryable failure that is staying `PENDING`. Counts the attempt, nothing else. */
  async recordAttempt(recipientId: string, error: string): Promise<void> {
    await this.prisma.messageRecipient.updateMany({
      where: { id: recipientId, status: 'PENDING' },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 500) },
    });
  }

  /**
   * Close a campaign once nothing is pending, and say how it went.
   *
   * `PARTIALLY_FAILED` rather than `COMPLETED` whenever anything failed, because
   * "did that broadcast work?" should be answerable from the status alone. A
   * `BLOCKED` recipient does **not** count as a failure — there was nobody to
   * deliver to, which is a fact about the recipient rather than about the send.
   */
  async finalizeIfDone(campaignId: string): Promise<boolean> {
    const counts = await this.countsFor(campaignId);
    if (counts.pending > 0) return false;

    const status: MessageCampaignStatus =
      counts.sent === 0 && counts.total > 0
        ? 'FAILED'
        : counts.failed + counts.invalid + counts.rateLimited > 0
          ? 'PARTIALLY_FAILED'
          : 'COMPLETED';

    await this.prisma.messageCampaign.updateMany({
      where: { id: campaignId, status: 'SENDING' },
      data: {
        status,
        finishedAt: this.clock.now(),
        counts: counts as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  }

  /** Refresh the cached tally without changing the status. */
  async refreshCounts(campaignId: string): Promise<DeliveryCounts> {
    const counts = await this.countsFor(campaignId);
    await this.prisma.messageCampaign.update({
      where: { id: campaignId },
      data: { counts: counts as unknown as Prisma.InputJsonValue },
    });
    return counts;
  }

  private async countsFor(campaignId: string): Promise<DeliveryCounts> {
    const grouped = await this.prisma.messageRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });

    const counts: DeliveryCounts = {
      total: 0,
      pending: 0,
      sent: 0,
      rateLimited: 0,
      blocked: 0,
      invalid: 0,
      failed: 0,
      skipped: 0,
    };
    for (const row of grouped) {
      const n = row._count._all;
      counts.total += n;
      counts[COUNT_KEYS[row.status]] += n;
    }
    return counts;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async get(publicId: string): Promise<MessageCampaignSummary> {
    const row = await this.prisma.messageCampaign.findUnique({
      where: { publicId },
      select: CAMPAIGN_SELECT,
    });
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND);
    return toSummary(row, await this.countsFor(row.id));
  }

  private async getByIdempotencyKey(key: string): Promise<MessageCampaignSummary> {
    const row = await this.prisma.messageCampaign.findUnique({
      where: { idempotencyKey: key },
      select: CAMPAIGN_SELECT,
    });
    if (row === null) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return toSummary(row, await this.countsFor(row.id));
  }

  async list(
    filters: { kind?: MessageCampaignKind; limit?: number; offset?: number } = {},
  ): Promise<{ rows: MessageCampaignSummary[]; total: number }> {
    const where: Prisma.MessageCampaignWhereInput =
      filters.kind !== undefined ? { kind: filters.kind } : {};

    const [rows, total] = await Promise.all([
      this.prisma.messageCampaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(filters.limit ?? 25, 1), 100),
        skip: Math.max(filters.offset ?? 0, 0),
        select: CAMPAIGN_SELECT,
      }),
      this.prisma.messageCampaign.count({ where }),
    ]);

    // The stored tally rather than a `GROUP BY` per row: the list is a list, and
    // one aggregate per campaign is how a page of twenty becomes twenty queries.
    return { rows: rows.map((row) => toSummary(row, storedCounts(row.counts))), total };
  }

  /** The audit row every campaign action writes. Metadata, never the body. */
  async recordAudit(entry: {
    action: string;
    campaignPublicId: string;
    actorType: 'ADMIN' | 'USER';
    actorId: string;
    facts: Record<string, Prisma.InputJsonValue>;
  }): Promise<void> {
    await this.audit.record({
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      targetType: 'message_campaign',
      targetId: entry.campaignPublicId,
      after: entry.facts,
    });
  }
}

const CANCELLABLE = new Set<MessageCampaignStatus>(['DRAFT', 'CONFIRMED', 'QUEUED', 'SENDING']);

/** `delivery_status` → the field it increments. Exhaustive by construction. */
const COUNT_KEYS: Record<DeliveryStatus, keyof Omit<DeliveryCounts, 'total'>> = {
  PENDING: 'pending',
  SENT: 'sent',
  RATE_LIMITED: 'rateLimited',
  BLOCKED: 'blocked',
  INVALID: 'invalid',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

const CAMPAIGN_SELECT = {
  id: true,
  publicId: true,
  kind: true,
  status: true,
  bodyText: true,
  parseMode: true,
  dryRun: true,
  estimatedRecipients: true,
  counts: true,
  filter: true,
  pausedAt: true,
  pauseReason: true,
  createdAt: true,
  confirmedAt: true,
  startedAt: true,
  finishedAt: true,
  cancelledAt: true,
  event: { select: { publicId: true } },
} as const;

type CampaignRow = Prisma.MessageCampaignGetPayload<{ select: typeof CAMPAIGN_SELECT }>;

function toSummary(row: CampaignRow, counts: DeliveryCounts): MessageCampaignSummary {
  return {
    publicId: row.publicId,
    kind: row.kind,
    status: row.status,
    bodyText: row.bodyText,
    parseMode: row.parseMode,
    dryRun: row.dryRun,
    estimatedRecipients: row.estimatedRecipients,
    counts,
    audience: (row.filter ?? {}) as MessageAudience,
    eventPublicId: row.event?.publicId ?? null,
    pausedAt: row.pausedAt,
    pauseReason: row.pauseReason,
    createdAt: row.createdAt,
    confirmedAt: row.confirmedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    cancelledAt: row.cancelledAt,
  };
}

/** The cached tally, defensively — a campaign created before its first refresh has none. */
function storedCounts(value: Prisma.JsonValue): DeliveryCounts {
  const empty: DeliveryCounts = {
    total: 0,
    pending: 0,
    sent: 0,
    rateLimited: 0,
    blocked: 0,
    invalid: 0,
    failed: 0,
    skipped: 0,
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty;

  const record = value as Record<string, unknown>;
  const read = (key: keyof DeliveryCounts): number =>
    typeof record[key] === 'number' ? record[key] : 0;

  return {
    total: read('total'),
    pending: read('pending'),
    sent: read('sent'),
    rateLimited: read('rateLimited'),
    blocked: read('blocked'),
    invalid: read('invalid'),
    failed: read('failed'),
    skipped: read('skipped'),
  };
}
