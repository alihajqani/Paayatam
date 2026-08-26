import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { ENV } from '@payetam/platform';
import type { Env } from '@payetam/config';
import { renderEventInvitation } from '@payetam/telegram';
import { AuditService } from '../audit/audit.service';
import { ChannelMembershipService } from '../channel/membership.service';
import { SettingsService } from '../catalog/settings.service';
import { CoinService } from '../economy/coin.service';
import { rankCandidates, type InviteCandidate, type InviteWeights } from './score';

/** What a host is shown before they are asked to pay. */
export interface InvitePreview {
  /** Everybody the pool query found, before ranking. */
  candidates: number;
  /** How many would actually be invited — never more than the configured cap. */
  selected: number;
  maxRecipients: number;
  cost: number;
  balance: number;
  affordable: boolean;
  /**
   * Why, in aggregate.
   *
   * Counts of which terms fired across the selected set. Never a name, never an
   * id: a host is entitled to know that twelve of the twenty live in their city,
   * and not to know who they are.
   */
  reasons: {
    sameCity: number;
    interestMatch: number;
    categoryHistory: number;
    recentlyActive: number;
  };
  /** Non-null when the operation would refuse; the panel renders it before the button. */
  blockedReason: 'NO_CANDIDATES' | 'INSUFFICIENT_COINS' | 'EVENT_NOT_INVITABLE' | null;
}

export interface InviteResult {
  campaignPublicId: string | null;
  invited: number;
  charged: number;
  /** True when a previous identical request already did this. */
  replayed: boolean;
}

/** Everything the invitation needs about the event it is for. */
interface InvitableEvent {
  id: string;
  publicId: string;
  cityId: string;
  categoryId: string;
  title: string;
  capacity: number;
  startsAt: Date;
  categoryName: string;
  cityName: string;
  districtName: string | null;
}

/** The reason code the ledger carries. Stable: the admin panel renders it. */
export const INVITE_SPEND_REASON = 'event.invite_top';

/**
 * The exactly-once key for one invitation purchase.
 *
 * Derived from the event **and the client's own key**, so the two questions stay
 * separate: a retried request is the same purchase, and a deliberate second batch
 * a week later is a different one. Keying on the event alone would make the second
 * batch free; keying on a timestamp would make the retry a double charge.
 */
export function inviteSpendKey(eventId: string, clientKey: string): string {
  return `invite-top:${eventId}:${clientKey}`;
}

/**
 * How many users the pool query considers before ranking.
 *
 * Bounded because the pool is "anybody in this city **or** interested in this
 * category", which on a national deployment is a large number of rows to score in
 * a request somebody is waiting on. Five hundred is roughly twenty-five times the
 * cap, which is enough headroom that the twenty chosen are genuinely the best of a
 * broad field rather than the best of whoever happened to be first.
 *
 * Ordered by `id` descending — UUIDv7, so newest first. If the pool has to be
 * truncated, recent accounts are the better half to keep: they are the ones still
 * opening the app.
 */
const CANDIDATE_POOL = 500;

/**
 * Paying to invite the twenty people most likely to come (M22 phase 11).
 *
 * ── What "most likely" is allowed to mean ────────────────────────────────────
 *
 * A deterministic sum of facts the product already holds, computed by `score.ts`,
 * which infers nothing and claims no accuracy. This service is the half that
 * decides **who is eligible at all** — and the exclusions matter more than the
 * ranking, because a good score cannot make an invitation to somebody who opted
 * out acceptable.
 *
 * ── When the ten coins are taken ─────────────────────────────────────────────
 *
 * Inside the transaction that creates the invitations, and **not at all when
 * nobody is eligible**. That is the answer to the question the requirement leaves
 * open: charging for a send with zero recipients would be charging for nothing,
 * and the preview shows the count first so the host is never surprised by either
 * outcome. Fewer than twenty eligible people sends to however many there are and
 * still costs ten — the price buys the operation, not a headcount.
 *
 * A partial delivery is not refunded. The work was performed; some recipients
 * having blocked the bot is a fact about them, and a refund proportional to
 * Telegram's mood would make the price unpredictable in the other direction.
 */
@Injectable()
export class InvitationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    /** For `TELEGRAM_BOT_USERNAME` alone — the deep link in the invitation. */
    @Inject(ENV) private readonly env: Env,
    private readonly settings: SettingsService,
    private readonly coins: CoinService,
    /** The channel-membership gate (M22 phase 6), in the service that owns the act. */
    private readonly membership: ChannelMembershipService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What it would do, and what it would cost. **Writes nothing and charges nothing.**
   *
   * The requirement is explicit that an admin or a host must not be able to
   * trigger a charge through a preview, and the way that is guaranteed here is
   * that there is no write path in this method at all — not a campaign, not an
   * invitation row, not a ledger entry.
   */
  async preview(hostUserId: string, eventPublicId: string): Promise<InvitePreview> {
    const event = await this.loadInvitableEvent(hostUserId, eventPublicId);
    const [weights, maxRecipients, cost, balance] = await Promise.all([
      this.weights(),
      this.settings.getInt('events.top_invite_max_recipients'),
      this.settings.getInt('economy.event_top_invite_coins'),
      this.coins.balanceOf(hostUserId),
    ]);

    const pool = await this.candidatePool(event, hostUserId);
    const ranked = rankCandidates(
      pool,
      { cityId: event.cityId, categoryId: event.categoryId },
      weights,
      maxRecipients,
    );

    const reasons = {
      sameCity: ranked.filter((row) => row.breakdown.sameCity > 0).length,
      interestMatch: ranked.filter((row) => row.breakdown.interestMatch > 0).length,
      categoryHistory: ranked.filter((row) => row.breakdown.categoryHistory > 0).length,
      recentlyActive: ranked.filter((row) => row.breakdown.recentActivity > 0).length,
    };

    return {
      candidates: pool.length,
      selected: ranked.length,
      maxRecipients,
      cost,
      balance,
      affordable: balance >= cost,
      reasons,
      blockedReason:
        ranked.length === 0 ? 'NO_CANDIDATES' : balance < cost ? 'INSUFFICIENT_COINS' : null,
    };
  }

  /**
   * Charge, record and queue.
   *
   * One transaction: the coins leave, the invitations are written and the campaign
   * is created together, or none of it happens. A host charged for invitations
   * that were never recorded has no way to tell that from a delivery failure.
   *
   * The **selection runs inside the transaction too**, so the twenty who are
   * charged for are the twenty that existed at the moment of payment rather than
   * at the moment of the preview.
   */
  async inviteTop(
    hostUserId: string,
    eventPublicId: string,
    clientKey: string,
  ): Promise<InviteResult> {
    const event = await this.loadInvitableEvent(hostUserId, eventPublicId);
    await this.membership.assertAllowed(hostUserId, 'EVENT_INVITE');
    const [weights, maxRecipients, cost] = await Promise.all([
      this.weights(),
      this.settings.getInt('events.top_invite_max_recipients'),
      this.settings.getInt('economy.event_top_invite_coins'),
    ]);

    const idempotencyKey = inviteSpendKey(event.id, clientKey);

    // Already done. Returned rather than refused, because a retry should see what
    // the first attempt produced — the whole point of the client's key.
    const existing = await this.prisma.messageCampaign.findUnique({
      where: { idempotencyKey },
      select: { publicId: true, _count: { select: { invitations: true } } },
    });
    if (existing !== null) {
      return {
        campaignPublicId: existing.publicId,
        invited: existing._count.invitations,
        charged: 0,
        replayed: true,
      };
    }

    const pool = await this.candidatePool(event, hostUserId);
    const ranked = rankCandidates(
      pool,
      { cityId: event.cityId, categoryId: event.categoryId },
      weights,
      maxRecipients,
    );

    if (ranked.length === 0) {
      // **Not charged.** There is nobody to message, so there is nothing to buy.
      // Recorded anyway, because "I paid and nothing happened" and "I asked and
      // nobody qualified" look identical from the outside and only one is true.
      await this.audit.record({
        actorType: 'USER',
        actorId: hostUserId,
        action: 'event.invite_top.no_candidates',
        targetType: 'event',
        targetId: event.id,
        after: { candidates: pool.length, charged: 0 },
      });
      return { campaignPublicId: null, invited: 0, charged: 0, replayed: false };
    }

    const now = this.clock.now();

    const campaign = await this.prisma.$transaction(async (tx) => {
      const movement =
        cost > 0
          ? await this.coins.apply(
              {
                userId: hostUserId,
                amount: -cost,
                type: 'INVITE_SPEND',
                reasonCode: INVITE_SPEND_REASON,
                idempotencyKey,
                actorType: 'USER',
                actorId: hostUserId,
                refType: 'event',
                refId: event.id,
                metadata: { recipients: ranked.length },
              },
              tx,
            )
          : null;

      const created = await tx.messageCampaign.create({
        data: {
          idempotencyKey,
          kind: 'EVENT_INVITE',
          // Straight to QUEUED: the host confirmed by paying, and a second
          // confirmation step would be asking somebody to agree twice to the thing
          // they just bought.
          status: 'QUEUED',
          /**
           * Rendered **once, here**, rather than at delivery.
           *
           * `body_text` is what a dispute is about — "what did you send my
           * users?" — and a body composed per recipient would answer that with
           * whatever the event looks like now. Rendering once means the twenty
           * recipients all got the same message and the row proves what it was.
           */
          bodyText: renderEventInvitation({
            title: event.title,
            categoryName: event.categoryName,
            cityName: event.cityName,
            districtName: event.districtName,
            startsAt: event.startsAt,
            capacity: event.capacity,
            eventPublicId: event.publicId,
            botUsername: this.env.TELEGRAM_BOT_USERNAME ?? 'payetam_bot',
          }),
          parseMode: 'HTML',
          filter: { eventPublicId },
          estimatedRecipients: ranked.length,
          actorType: 'USER',
          actorUserId: hostUserId,
          eventId: event.id,
          coinLedgerId: movement?.ledgerId ?? null,
          confirmedAt: now,
          createdAt: now,
        },
        select: { id: true, publicId: true },
      });

      /**
       * The invitation rows, and the recipient rows beside them.
       *
       * Two tables on purpose. `event_invitation` answers "has this person already
       * been invited to this event?" for every future selection and outlives the
       * campaign; `message_recipient` is what the dispatcher claims. Both carry a
       * unique index, so a retry that got past the campaign key still writes each
       * person once.
       */
      await tx.eventInvitation.createMany({
        data: ranked.map((row) => ({
          eventId: event.id,
          userId: row.userId,
          campaignId: created.id,
          score: row.score,
          scoreBreakdown: row.breakdown as unknown as Prisma.InputJsonValue,
          createdAt: now,
        })),
        skipDuplicates: true,
      });

      await tx.messageRecipient.createMany({
        data: ranked.map((row) => ({ campaignId: created.id, userId: row.userId, createdAt: now })),
        skipDuplicates: true,
      });

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: hostUserId,
          action: 'event.invite_top.purchased',
          targetType: 'event',
          targetId: event.id,
          after: {
            campaignPublicId: created.publicId,
            candidates: pool.length,
            invited: ranked.length,
            coinsCharged: movement === null ? 0 : cost,
            // The score range, so an audit can see the selection was not arbitrary
            // without listing who was in it.
            topScore: ranked[0]?.score ?? 0,
            lowestSelectedScore: ranked[ranked.length - 1]?.score ?? 0,
          },
        },
        tx,
      );

      return created;
    });

    return {
      campaignPublicId: campaign.publicId,
      invited: ranked.length,
      charged: cost,
      replayed: false,
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async weights(): Promise<InviteWeights> {
    const values = await this.settings.getNumbers([
      'invite.weight_same_city',
      'invite.weight_interest_match',
      'invite.weight_category_history',
      'invite.weight_recent_activity',
      'invite.weight_trust',
      'invite.penalty_recent_invite',
    ]);
    return {
      sameCity: values['invite.weight_same_city'],
      interestMatch: values['invite.weight_interest_match'],
      categoryHistory: values['invite.weight_category_history'],
      recentActivity: values['invite.weight_recent_activity'],
      trust: values['invite.weight_trust'],
      recentInvitePenalty: values['invite.penalty_recent_invite'],
    };
  }

  /**
   * The host's own event, and only if inviting to it makes sense.
   *
   * Not-yours and not-found answer identically, exactly as `EventService.boost`
   * does: a stranger must not be able to ask this endpoint whether an event exists
   * (T3.3). "Published and still upcoming" is a separate code, because that one the
   * host can act on.
   */
  private async loadInvitableEvent(hostUserId: string, publicId: string): Promise<InvitableEvent> {
    const event = await this.prisma.event.findUnique({
      where: { publicId },
      select: {
        id: true,
        publicId: true,
        hostUserId: true,
        cityId: true,
        categoryId: true,
        title: true,
        capacity: true,
        startsAt: true,
        status: true,
        deletedAt: true,
        category: { select: { nameFa: true } },
        city: { select: { nameFa: true } },
        district: { select: { nameFa: true } },
      },
    });
    if (!event || event.deletedAt !== null) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    if (event.hostUserId !== hostUserId) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

    // Inviting people to something they cannot join, or that has already started,
    // spends coins on nothing.
    if (event.status !== 'PUBLISHED' || event.startsAt <= this.clock.now()) {
      throw new AppError(ErrorCode.EVENT_NOT_INVITABLE);
    }

    return {
      id: event.id,
      publicId: event.publicId,
      cityId: event.cityId,
      categoryId: event.categoryId,
      title: event.title,
      capacity: event.capacity,
      startsAt: event.startsAt,
      categoryName: event.category.nameFa,
      cityName: event.city.nameFa,
      districtName: event.district?.nameFa ?? null,
    };
  }

  /**
   * Everybody who could plausibly be invited, with the facts the scorer needs.
   *
   * ── The exclusions, and why each one is not negotiable ───────────────────────
   *
   *  - **The host.** Inviting yourself to your own event.
   *  - **Anybody who opted out.** `user_profile.invite_opt_out` is a preference the
   *    product asked for and must therefore honour without an override.
   *  - **Anybody already invited to this event**, ever — `UNIQUE (event_id,
   *    user_id)` would refuse the row anyway, and filtering here means the twenty
   *    slots go to twenty new people rather than being silently consumed.
   *  - **Anybody already taking part**, including a pending request. They have
   *    already found it.
   *  - **Anybody unreachable**: no Telegram link, or the bot blocked. Retrying a
   *    block burns the rate budget every other message needs (ADR-0005).
   *  - **Anybody not `ACTIVE`.** A suspended account is not somebody to recruit.
   *
   * The pool itself is "in this city **or** interested in this category", because
   * a score with a city term needs candidates who fail it to have any ordering
   * power — and because scoring the entire user base for every preview is not a
   * query anybody should be waiting on.
   */
  private async candidatePool(
    event: InvitableEvent,
    hostUserId: string,
  ): Promise<InviteCandidate[]> {
    const now = this.clock.now();
    const [recentInviteDays, recentActivityDays] = await Promise.all([
      this.settings.getInt('invite.recent_invite_days'),
      this.settings.getInt('invite.recent_activity_days'),
    ]);
    const inviteCutoff = new Date(now.getTime() - recentInviteDays * 86_400_000);
    const activityCutoff = new Date(now.getTime() - recentActivityDays * 86_400_000);

    const rows = await this.prisma.user.findMany({
      where: {
        id: { not: hostUserId },
        status: 'ACTIVE',
        deletedAt: null,
        onboardingState: 'PROFILE_COMPLETE',
        telegramAccount: { is: { botBlocked: false } },
        profile: { is: { inviteOptOut: false } },
        invitationsReceived: { none: { eventId: event.id } },
        participations: { none: { eventId: event.id } },
        OR: [
          { profile: { is: { cityId: event.cityId } } },
          { interests: { some: { interest: { categoryId: event.categoryId } } } },
        ],
      },
      orderBy: { id: 'desc' },
      take: CANDIDATE_POOL,
      select: {
        id: true,
        profile: { select: { cityId: true } },
        interests: { select: { interest: { select: { categoryId: true } } } },
        trustScore: { select: { score: true } },
        // Bounded, and enough for both terms: how many of the last twenty were in
        // this category, and whether any of them was recent.
        participations: {
          where: { status: { in: ['ACCEPTED', 'COMPLETED'] } },
          orderBy: { requestedAt: 'desc' },
          take: 20,
          select: { requestedAt: true, event: { select: { categoryId: true } } },
        },
        invitationsReceived: {
          where: { createdAt: { gte: inviteCutoff } },
          take: 1,
          select: { id: true },
        },
      },
    });

    return rows.map((row) => ({
      userId: row.id,
      cityId: row.profile?.cityId ?? null,
      interestCategoryIds: row.interests.flatMap((link) =>
        link.interest.categoryId === null ? [] : [link.interest.categoryId],
      ),
      categoryAttendances: row.participations.filter(
        (participation) => participation.event.categoryId === event.categoryId,
      ).length,
      recentlyActive: row.participations.some(
        (participation) => participation.requestedAt >= activityCutoff,
      ),
      trustScore: row.trustScore?.score ?? null,
      invitedRecently: row.invitationsReceived.length > 0,
    }));
  }

  /**
   * Mark the invitation rows that go with a delivery outcome.
   *
   * Called by the worker beside `MessagingService.recordDelivery`, so the two
   * tables agree: `message_recipient` is the queue's record and `event_invitation`
   * is the product's, and a future selection reads the second.
   */
  async recordInvitationOutcome(
    campaignId: string,
    userId: string,
    status: 'SENT' | 'BLOCKED' | 'INVALID' | 'FAILED' | 'SKIPPED',
  ): Promise<void> {
    await this.prisma.eventInvitation.updateMany({
      where: { campaignId, userId, status: 'PENDING' },
      data: { status, sentAt: status === 'SENT' ? this.clock.now() : null },
    });
  }

  /** The delivery statistics a host is shown afterwards. */
  async statsFor(campaignPublicId: string): Promise<Record<string, number>> {
    const campaign = await this.prisma.messageCampaign.findUnique({
      where: { publicId: campaignPublicId },
      select: { id: true },
    });
    if (campaign === null) throw new AppError(ErrorCode.NOT_FOUND);

    const grouped = await this.prisma.eventInvitation.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    });

    return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  }
}
