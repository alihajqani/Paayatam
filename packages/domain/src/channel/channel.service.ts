import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ChannelPostKind, Prisma } from '@payetam/db';
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
        requestCount: { gte: trendingThreshold },
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
        requestCount: true,
        category: { select: { nameFa: true } },
        city: { select: { nameFa: true } },
        district: { select: { nameFa: true } },
        districtLabel: true,
      },
    });

    const claimed: PublishablePost[] = [];

    for (const event of candidates) {
      // TRENDING is the only automatic kind left: VIP and BOOSTED were the two
      // a host *bought*, and promotion is gone (v0.7.0). The loop stays a loop
      // because `PAID` is claimed on the same table by `publishToChannel`, and a
      // second automatic kind would land here rather than in a second code path.
      const kinds: ChannelPostKind[] = ['TRENDING'];

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
          districtName: event.district?.nameFa ?? event.districtLabel,
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

  /**
   * Claim the one publication a host paid for (M22 phase 5).
   *
   * Joins the caller's transaction, because the claim and the coin movement have
   * to commit together: a charge without a row is a host who paid for nothing, and
   * a row without a charge is a free post.
   *
   * `UNIQUE (event_id, kind)` is the duplicate guard, and it is what makes the
   * purchase exactly-once at the database rather than at the price. Returns false
   * when the row already exists, so the caller can refuse the second purchase with
   * a message instead of taking the coins again.
   */
  async claimPaidPublication(
    tx: Prisma.TransactionClient,
    eventId: string,
    republishSeq = 0,
  ): Promise<boolean> {
    try {
      await tx.channelPost.create({
        data: { eventId, kind: 'PAID', republishSeq, createdAt: this.clock.now() },
        select: { id: true },
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /**
   * The live paid post for an event, and the sequence a renewal would take.
   *
   * Read under the caller's event lock, so the sequence it returns cannot be
   * taken by a concurrent renewal between the read and the insert — the unique
   * index on `(event_id, kind, republish_seq)` is the backstop either way.
   */
  async currentPaidPublication(
    tx: Prisma.TransactionClient,
    eventId: string,
  ): Promise<{ id: string; postedAt: Date | null; republishSeq: number } | null> {
    return tx.channelPost.findFirst({
      where: { eventId, kind: 'PAID', deletedAt: null, supersededAt: null },
      orderBy: { republishSeq: 'desc' },
      select: { id: true, postedAt: true, republishSeq: true },
    });
  }

  /**
   * Mark the post a renewal replaces, so the sweep takes the old message down.
   *
   * `supersededAt` rather than `deletedAt`: the message is still in the channel
   * at this moment, and `deletedAt` means Telegram has confirmed it is gone.
   * Writing the latter here would make the takedown sweep skip the very row it
   * needs to act on, leaving two copies of one activity in the channel forever.
   */
  async supersedePaidPublication(tx: Prisma.TransactionClient, postId: string): Promise<void> {
    await tx.channelPost.update({
      where: { id: postId },
      data: { supersededAt: this.clock.now() },
    });
  }

  /**
   * Paid claims Telegram has not confirmed yet.
   *
   * A separate read from `claimPending` because the two have opposite failure
   * behaviour. A trending claim that fails to send is **released** — the
   * row is re-derivable from `request_count`, so deleting it costs
   * nothing and leaving it would bar the event forever. A paid claim is the record
   * that somebody paid; it is never released, and every sweep retries it until
   * Telegram accepts it.
   */
  async findUnpostedPaid(limit = 20): Promise<PublishablePost[]> {
    const rows = await this.prisma.channelPost.findMany({
      where: { kind: 'PAID', postedAt: null, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: {
        id: true,
        event: {
          select: {
            publicId: true,
            title: true,
            startsAt: true,
            capacity: true,
            acceptedCount: true,
            costType: true,
            costAmount: true,
            category: { select: { nameFa: true } },
            city: { select: { nameFa: true } },
            district: { select: { nameFa: true } },
            districtLabel: true,
          },
        },
      },
    });

    return rows.map((row) => ({
      postId: row.id,
      eventPublicId: row.event.publicId,
      kind: 'PAID' as const,
      title: row.event.title,
      categoryName: row.event.category.nameFa,
      cityName: row.event.city.nameFa,
      districtName: row.event.district?.nameFa ?? row.event.districtLabel,
      startsAt: row.event.startsAt,
      capacity: row.event.capacity,
      acceptedCount: row.event.acceptedCount,
      costType: row.event.costType,
      costAmount: row.event.costAmount,
    }));
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
          // A renewal replaced this post. The event is perfectly fine — which is
          // why none of the conditions above catch it — and the old message still
          // has to come down, or the channel carries two copies of one activity.
          { supersededAt: { not: null } },
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
   * promoted, which a coin dispute needs — a host who paid for a placement had the
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
