import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ChannelPostKind } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { SettingsService } from '../catalog/settings.service';
import { isUniqueViolation } from '../identity/user.service';

/** What the publisher needs to render and post one event. */
export interface PublishablePost {
  postId: string;
  eventPublicId: string;
  kind: ChannelPostKind;
  title: string;
  categoryName: string;
  cityName: string;
  districtName: string | null;
  startsAt: Date;
  capacity: number;
  acceptedCount: number;
  costType: string;
  costAmount: number | null;
}

/** A post that should come down, and the message id needed to take it down. */
export interface TakedownTarget {
  postId: string;
  telegramMessageId: number;
}

/**
 * What the channel is allowed to publish (plan §3.3, §1).
 *
 * The module's invariant is *"publishes only what admin rules allow"*, and the
 * shape of this service is that sentence: **nothing here decides to promote
 * anything.** An event reaches the channel because a host bought a placement (M9's
 * two coin sinks) or because enough people asked to join it — never because the
 * publisher liked the look of it.
 *
 * Two guards do most of the work, and neither is in this code:
 *
 *  - `UNIQUE (event_id, kind)` makes a duplicate post impossible rather than
 *    unlikely. The claim path inserts and lets the index decide.
 *  - The eligibility query filters on `status = 'PUBLISHED'` **and**
 *    `moderation_status IN ('APPROVED','FLAGGED')`, which is ADR-0012's rule
 *    applied to a second surface: FLAG publishes and opens a case, BLOCK does not
 *    publish. A blocked event reaching a public channel would be the automation
 *    failing in the most visible place it could.
 */
@Injectable()
export class ChannelService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Claim the events that have earned a post and have not had one.
   *
   * Claiming is an insert, so two publishers racing produce one post: the second
   * collides on the unique index and skips. The row is created **unposted** —
   * `posted_at` and `telegram_message_id` are filled in only once Telegram has
   * confirmed — so a crash between the claim and the send leaves a row that the
   * next pass finds and completes, rather than a post nothing recorded.
   */
  async claimPending(limit = 20): Promise<PublishablePost[]> {
    const now = this.clock.now();
    const [enabled, trendingThreshold] = await Promise.all([
      this.settings.getInt('channel.enabled'),
      this.settings.getInt('channel.trending_request_threshold'),
    ]);
    if (enabled !== 1) return [];

    const candidates = await this.prisma.event.findMany({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        // Nothing already over. A channel advertising last Tuesday is worse than
        // an empty one.
        startsAt: { gt: now },
        // ADR-0012 on a public surface: FLAG publishes, BLOCK does not.
        moderationStatus: { in: ['APPROVED', 'FLAGGED'] },
        OR: [
          { isVip: true },
          { boostedUntil: { gt: now } },
          { requestCount: { gte: trendingThreshold } },
        ],
      },
      orderBy: { publishedAt: 'asc' },
      take: limit,
      select: {
        id: true,
        publicId: true,
        title: true,
        startsAt: true,
        capacity: true,
        acceptedCount: true,
        costType: true,
        costAmount: true,
        isVip: true,
        boostedUntil: true,
        requestCount: true,
        category: { select: { nameFa: true } },
        city: { select: { nameFa: true } },
        district: { select: { nameFa: true } },
      },
    });

    const claimed: PublishablePost[] = [];

    for (const event of candidates) {
      // One event can qualify for more than one reason, and each is its own post.
      // A host who paid for VIP *and* whose event is trending gets both, which is
      // what they bought and what the audience earned.
      const kinds: ChannelPostKind[] = [];
      if (event.isVip) kinds.push('VIP');
      if (event.boostedUntil !== null && event.boostedUntil > now) kinds.push('BOOSTED');
      if (event.requestCount >= trendingThreshold) kinds.push('TRENDING');

      for (const kind of kinds) {
        let postId: string;
        try {
          const created = await this.prisma.channelPost.create({
            data: { eventId: event.id, kind, createdAt: now },
            select: { id: true },
          });
          postId = created.id;
        } catch (error) {
          // The unique index answering: already claimed, by this pass or another.
          if (isUniqueViolation(error)) continue;
          throw error;
        }

        claimed.push({
          postId,
          eventPublicId: event.publicId,
          kind,
          title: event.title,
          categoryName: event.category.nameFa,
          cityName: event.city.nameFa,
          districtName: event.district?.nameFa ?? null,
          startsAt: event.startsAt,
          capacity: event.capacity,
          acceptedCount: event.acceptedCount,
          costType: event.costType,
          costAmount: event.costAmount,
        });
      }
    }

    return claimed;
  }

  /** Telegram confirmed it. Now the row can be taken down later. */
  async markPosted(postId: string, telegramMessageId: number): Promise<void> {
    await this.prisma.channelPost.update({
      where: { id: postId },
      data: { telegramMessageId, postedAt: this.clock.now() },
    });
  }

  /**
   * A claim that never became a post.
   *
   * Deleted rather than left behind, so the next pass can claim it again. Leaving
   * it would mean one failed send permanently barred that event from the channel —
   * the unique index would refuse every future claim, and nothing would ever say
   * why.
   */
  async releaseClaim(postId: string): Promise<void> {
    await this.prisma.channelPost.deleteMany({ where: { id: postId, postedAt: null } });
  }

  /**
   * Posts whose event has stopped being publishable.
   *
   * The plan asks that "a hidden event's post is deleted", and the condition is
   * wider than hiding: cancelled, rejected, soft-deleted and simply over all mean
   * the post is now advertising something that is not on. A channel full of dead
   * links is the thing that makes people stop reading it.
   */
  async findTakedowns(limit = 50): Promise<TakedownTarget[]> {
    const now = this.clock.now();

    const rows = await this.prisma.channelPost.findMany({
      where: {
        deletedAt: null,
        postedAt: { not: null },
        OR: [
          { event: { status: { notIn: ['PUBLISHED'] } } },
          { event: { deletedAt: { not: null } } },
          { event: { moderationStatus: 'REJECTED' } },
          { event: { startsAt: { lte: now } } },
        ],
      },
      take: limit,
      select: { id: true, telegramMessageId: true },
    });

    return rows.flatMap((row) =>
      row.telegramMessageId === null
        ? []
        : [{ postId: row.id, telegramMessageId: row.telegramMessageId }],
    );
  }

  /**
   * Record that a post came down.
   *
   * The row is kept rather than deleted: it is the record that this event *was*
   * promoted, which a coin dispute needs — a host who paid for VIP and had the
   * post removed by moderation has a question, and "there is no row" is not an
   * answer. It also stops the event being re-posted the moment it becomes
   * publishable again, because the unique index still holds.
   */
  async markTakenDown(postId: string): Promise<void> {
    await this.prisma.channelPost.update({
      where: { id: postId },
      data: { deletedAt: this.clock.now() },
    });
  }
}
