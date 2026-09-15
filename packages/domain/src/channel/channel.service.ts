import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ChannelPostKind, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { isUnlimitedCapacity } from '@payetam/shared';
import { SettingsService } from '../catalog/settings.service';
import { isUniqueViolation } from '../identity/user.service';
import { SLOT_HOLDING_STATUSES } from '../participation/state-machine';

/** What the publisher needs to render and post one event. */
export interface PublishablePost {
  postId: string;
  eventPublicId: string;
  /** `event.number`, for the post's «#رویداد_…» hashtag. */
  eventNumber: number;
  kind: ChannelPostKind;
  title: string;
  categoryName: string;
  cityName: string;
  districtName: string | null;
  startsAt: Date;
  capacity: number;
  acceptedCount: number;
  /**
   * Seats the channel shows as taken: accepted guests plus requests awaiting the
   * host (v0.16.0). A request closes a seat in the post the moment it is made; an
   * acceptance keeps it closed, a rejection or an expiry opens it. What
   * `markPosted` and `markCapacityRendered` record, so the sweep can tell when the
   * text in the channel has fallen behind.
   */
  takenCount: number;
  costType: string;
  costAmount: number | null;
  /** Whether `takenCount` renders as «ظرفیت تکمیل». Recorded as `rendered_full`. */
  full: boolean;
}

/**
 * How many live posts one capacity pass looks at. Far more than the channel
 * carries at once — they are the posts for activities that have not started.
 */
const LIVE_POST_SCAN = 200;

/** A live post whose capacity line no longer matches the activity. */
export interface StaleCapacityPost extends PublishablePost {
  telegramMessageId: number;
}

/**
 * «ظرفیت تکمیل», by the rule `seatsLine` renders: nothing left, and a limit to
 * have run out of. Unlimited is never full, however many have joined.
 */
function showsFull(capacity: number, takenCount: number): boolean {
  return !isUnlimitedCapacity(capacity) && takenCount >= capacity;
}

/** The event columns every post is rendered from. One list, three reads. */
const POST_EVENT_SELECT = {
  id: true,
  publicId: true,
  number: true,
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
} satisfies Prisma.EventSelect;

type PostEventRow = Prisma.EventGetPayload<{ select: typeof POST_EVENT_SELECT }>;

/** A publishable post from its row, its event and the event's pending requests. */
function toPublishable(
  postId: string,
  kind: ChannelPostKind,
  event: PostEventRow,
  pending: number,
): PublishablePost {
  // Clamped: `join` admits against `accepted + pending < capacity`, so the sum
  // cannot pass capacity through it — but a host lowering capacity under an open
  // queue could, and a post must not say «-۱ جای خالی».
  const takenCount = isUnlimitedCapacity(event.capacity)
    ? event.acceptedCount + pending
    : Math.min(event.acceptedCount + pending, event.capacity);
  return {
    postId,
    eventPublicId: event.publicId,
    eventNumber: event.number,
    kind,
    title: event.title,
    categoryName: event.category.nameFa,
    cityName: event.city.nameFa,
    districtName: event.district?.nameFa ?? event.districtLabel,
    startsAt: event.startsAt,
    capacity: event.capacity,
    acceptedCount: event.acceptedCount,
    takenCount,
    costType: event.costType,
    costAmount: event.costAmount,
    full: showsFull(event.capacity, takenCount),
  };
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
        // One activity, one post (review H4.1). Every registration claims a PAID
        // post, and its text does not show the kind — so a TRENDING claim on top
        // of it put two identical posts in the channel, and «انتشار دوباره»
        // replaced only one. Unposted counts: the paid post is on its way.
        channelPosts: { none: { kind: 'PAID', deletedAt: null } },
      },
      orderBy: { publishedAt: 'asc' },
      take: limit,
      select: POST_EVENT_SELECT,
    });

    const pending = await this.pendingCounts(candidates.map((event) => event.id));
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

        claimed.push(toPublishable(postId, kind, event, pending.get(event.id) ?? 0));
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
   * Put back a paid publication that moderation took down (v0.7.0).
   *
   * ── The gap this closes ─────────────────────────────────────────────────────
   *
   * Hiding an activity takes its channel post down — `findTakedowns` matches any
   * post whose event is no longer PUBLISHED, which is exactly right while the
   * activity is under review. Restoring it did **not** put the post back, and
   * could not: `markTakenDown` keeps the row, and `UNIQUE (event_id, kind,
   * republish_seq)` then refuses every future claim at that sequence.
   *
   * So a host whose activity was hidden by three reports and then cleared by a
   * moderator got the activity back and silently lost the channel placement they
   * had paid for. Nothing said so, and nothing could be done about it except
   * paying again.
   *
   * ── What this does, and does not, do ────────────────────────────────────────
   *
   * It claims the **next sequence** for the same kind, unposted, so the ordinary
   * five-minute sweep picks it up and posts it. **Free** — the coins were already
   * spent, and charging a second time for a report that was dismissed would be
   * the product billing somebody for having been wrongly accused.
   *
   * Only when there was a paid post that actually reached Telegram: an activity
   * that was never in the channel has nothing to reinstate, and one whose claim
   * is still unposted is already in the sweep's queue.
   *
   * Returns whether it claimed anything, so a caller can record that rather than
   * guess at it.
   */
  async reinstatePaidPublication(tx: Prisma.TransactionClient, eventId: string): Promise<boolean> {
    const previous = await tx.channelPost.findFirst({
      where: { eventId, kind: 'PAID', postedAt: { not: null } },
      orderBy: { republishSeq: 'desc' },
      select: { republishSeq: true, deletedAt: true },
    });
    // Never published by purchase, or its post is still up.
    if (!previous || previous.deletedAt === null) return false;

    return this.claimPaidPublication(tx, eventId, previous.republishSeq + 1);
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
    // The kill switch reaches paid posts too (review H4.2). It was read only by
    // `claimPending`, so switching the channel off stopped the free posts and let
    // every registration through. Nothing is released: the claims wait here and
    // post when the channel is switched back on.
    if ((await this.settings.getInt('channel.enabled')) !== 1) return [];

    const rows = await this.prisma.channelPost.findMany({
      where: { kind: 'PAID', postedAt: null, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, event: { select: POST_EVENT_SELECT } },
    });

    const pending = await this.pendingCounts(rows.map((row) => row.event.id));
    return rows.map((row) =>
      toPublishable(row.id, 'PAID', row.event, pending.get(row.event.id) ?? 0),
    );
  }

  /**
   * Telegram confirmed it. Now the row can be taken down later.
   *
   * `post` is what was sent: its `full` and `takenCount` are recorded so the
   * capacity sweep does not read a fresh post as stale and edit it into what it
   * already says.
   */
  async markPosted(
    postId: string,
    telegramMessageId: number,
    post: Pick<PublishablePost, 'full' | 'takenCount'>,
  ): Promise<void> {
    await this.prisma.channelPost.update({
      where: { id: postId },
      data: {
        telegramMessageId,
        postedAt: this.clock.now(),
        renderedFull: post.full,
        renderedTaken: post.takenCount,
      },
    });
  }

  /**
   * Live posts whose seats line no longer matches the activity (v0.16.0).
   *
   * Plan 14 edited a post only when it crossed «ظرفیت تکمیل», so a busy activity
   * was not an edit per acceptance. The channel now shows every change — a
   * request closes a seat, a rejection opens it — and what keeps that inside
   * Telegram's limits is not the boundary any more but the **budget**: `limit`
   * edits per pass, oldest post first, on a pass that runs once a minute. Five
   * requests to one activity inside that minute are one edit, because the sweep
   * compares the count now with the count the text carries and never replays the
   * changes in between.
   *
   * Stale means `rendered_taken` disagrees with accepted + pending, or is NULL —
   * a post from before 0058, edited once into the current format. An unlimited
   * activity's line never changes («بدون محدودیت»), so only that NULL edits it.
   *
   * Live means what `findTakedowns` does not want: posted, not taken down, not
   * superseded, for a published activity that has not started. Live posts are
   * the handful for upcoming activities, so they are read whole and compared
   * here — the count is an aggregate over another table, which a Prisma filter
   * cannot compare with a column.
   *
   * Nothing while `channel.enabled` is off: an edit is a write to the public
   * surface the switch exists to stop. The stored count stays stale, so the edit
   * lands once it is on.
   */
  async findStaleCapacity(limit = 8): Promise<StaleCapacityPost[]> {
    if ((await this.settings.getInt('channel.enabled')) !== 1) return [];
    const now = this.clock.now();

    const rows = await this.prisma.channelPost.findMany({
      where: {
        deletedAt: null,
        postedAt: { not: null },
        supersededAt: null,
        telegramMessageId: { not: null },
        event: { status: 'PUBLISHED', deletedAt: null, startsAt: { gt: now } },
      },
      orderBy: { postedAt: 'asc' },
      take: LIVE_POST_SCAN,
      select: {
        id: true,
        kind: true,
        telegramMessageId: true,
        renderedTaken: true,
        event: { select: POST_EVENT_SELECT },
      },
    });

    const pending = await this.pendingCounts(rows.map((row) => row.event.id));
    const stale: StaleCapacityPost[] = [];

    for (const row of rows) {
      if (stale.length >= limit) break;
      if (row.telegramMessageId === null) continue;

      const post = toPublishable(row.id, row.kind, row.event, pending.get(row.event.id) ?? 0);
      const changed =
        row.renderedTaken === null ||
        (!isUnlimitedCapacity(post.capacity) && row.renderedTaken !== post.takenCount);
      if (changed) stale.push({ ...post, telegramMessageId: row.telegramMessageId });
    }

    return stale;
  }

  /** The edit landed, or can never land: either way stop reconsidering this count. */
  async markCapacityRendered(
    postId: string,
    post: Pick<PublishablePost, 'full' | 'takenCount'>,
  ): Promise<void> {
    await this.prisma.channelPost.update({
      where: { id: postId },
      data: { renderedFull: post.full, renderedTaken: post.takenCount },
    });
  }

  /**
   * Requests awaiting a host, per event — the half of `takenCount` that is not
   * `accepted_count`. One grouped read for a whole pass.
   */
  private async pendingCounts(eventIds: readonly string[]): Promise<Map<string, number>> {
    if (eventIds.length === 0) return new Map();
    const groups = await this.prisma.eventParticipant.groupBy({
      by: ['eventId'],
      where: {
        eventId: { in: [...new Set(eventIds)] },
        status: { in: [...SLOT_HOLDING_STATUSES] },
      },
      _count: { _all: true },
    });
    return new Map(groups.map((group) => [group.eventId, group._count._all]));
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
