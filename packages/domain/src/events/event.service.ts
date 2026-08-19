import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type {
  CancellationBucket,
  CostType,
  EventModerationStatus,
  EventStatus,
  GenderPreference,
  Prisma,
} from '@payetam/db';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode, type ChannelPublicationStatus } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { CatalogService, type NamedRef } from '../catalog/catalog.service';
import { SettingsService } from '../catalog/settings.service';
import { ChatService } from '../chat/chat.service';
import { CoinService } from '../economy/coin.service';
import { PenaltyService, bucketForLateness, type PenaltyPrice } from '../economy/penalty.service';
import { ModerationService, type ContentScan } from '../moderation/moderation.service';
import { OutboxService } from '../outbox/outbox.service';
import { assertParticipantTransition } from '../participation/state-machine';
import { startOfDayIn } from '../time';
import { lockEventByPublicIdForUpdate } from './event-lock';
import { ACTIVE_EVENT_STATUSES, assertEventTransition } from './state-machine';

export interface CreateEventInput {
  title: string;
  description: string;
  categoryId: string;
  cityId: string;
  districtId?: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  costType: CostType;
  costAmount?: number;
  costNote?: string;
  rules?: string;
  genderPreference?: GenderPreference;
  minAge?: number;
  maxAge?: number;
  externalLink?: string;
}

/** Every field is optional; absent means "leave it as it is". */
export type UpdateEventInput = Partial<CreateEventInput>;

/** The two coin sinks (plan §2.9, §11): a 24-hour window, or a placement flag. */
export type BoostKind = 'BOOST' | 'VIP';

export const EVENT_BOOST_REASON = 'event.boost';
export const EVENT_VIP_REASON = 'event.vip';

/**
 * The boost spend's exactly-once key, derived from the window it buys.
 *
 * Deterministic, so a request replayed *before* the first one committed collides
 * — the event lock makes that the only interleaving where two calls compute the
 * same window. A replay that arrives afterwards computes a later window and is
 * treated as a second purchase, which is what plan §6's `Idempotency-Key` header
 * exists to disambiguate and why its absence is recorded as a gap.
 */
export function boostSpendKey(eventId: string, boostedUntil: Date): string {
  return `boost:${eventId}:${boostedUntil.toISOString()}`;
}

/** VIP is a flag, so its key is just the event: buying it twice is impossible. */
export function vipSpendKey(eventId: string): string {
  return `vip:${eventId}`;
}

/**
 * Where a boost window ends after this purchase.
 *
 * Extends from the current expiry when one is still running, so buying a second
 * window while the first is live adds a full 24 hours rather than overwriting
 * four of them — a host who pays twice gets twice.
 */
export function extendedBoost(current: Date | null, now: Date, hours: number): Date {
  const from = current !== null && current > now ? current : now;
  return new Date(from.getTime() + hours * 3_600_000);
}

/**
 * Who was told, and whether they had a seat. Public ids only (ADR-0009).
 *
 * A `type` rather than an `interface` on purpose: this goes straight into
 * `outbox_event.payload`, and TypeScript gives an implicit index signature to an
 * object type alias but never to an interface — so as an interface it is not
 * assignable to Prisma's JSON input at all.
 */
export type CancelledParticipant = {
  participantPublicId: string;
  userPublicId: string;
  hadSeat: boolean;
};

/** The outcome of a host cancellation, including what it cost (ADR-0011, D9). */
export interface EventCancellation {
  event: EventDetail;
  /** Requests retired, seats or not. */
  cancelled: number;
  /** How many of those actually held a seat — what the penalty is priced against. */
  hadSeats: number;
  coinsCharged: number;
  /** What the policy asked for, which may exceed what the host had. */
  coinsRequested: number;
  /** Negative or zero: what the score moved by, after the 0–100 clamp. */
  trustApplied: number;
  /** D9a: zero today, because joining costs a participant nothing. */
  coinsRefunded: number;
  bucket: CancellationBucket;
}

/** What `?dryRun=true` answers with for a host. */
export interface HostCancellationPreview {
  bucket: CancellationBucket;
  affected: number;
  price: PenaltyPrice;
}

export interface EventDetail {
  publicId: string;
  title: string;
  description: string;
  category: NamedRef;
  city: NamedRef;
  district: NamedRef | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  acceptedCount: number;
  costType: CostType;
  costAmount: number | null;
  costNote: string | null;
  rules: string | null;
  genderPreference: GenderPreference | null;
  minAge: number | null;
  maxAge: number | null;
  externalLink: string | null;
  status: EventStatus;
  moderationStatus: EventModerationStatus;
  publishedAt: Date | null;
  /**
   * What the host bought (M9), and only ever shown to the host.
   *
   * Discovery has its own mapper and reduces `boostedUntil` to a boolean
   * `isBoosted`, because a stranger has no business knowing when somebody's
   * promotion lapses. The owner does: this is the surface where they can see that
   * the forty coins bought a window and when it ends.
   */
  boostedUntil: Date | null;
  /**
   * How far the paid promotion has got toward the channel.
   *
   * Derived rather than stored: `NONE` when nothing was bought, `PUBLISHED` once a
   * `channel_post` row carries a Telegram message id, and `QUEUED` in between —
   * which includes the case where a send failed and released its claim, because
   * from the host's side "paid, not there yet" is the same answer either way.
   */
  channelStatus: ChannelPublicationStatus;
  isVip: boolean;
  version: number;
  createdAt: Date;
}

/**
 * Fields whose change re-opens the moderation question.
 *
 * Only the two the blacklist actually reads. Changing the capacity or the start
 * time is not a content decision, and sending such an edit back through
 * moderation would train hosts to avoid editing — which is worse for everyone
 * than a stale time on a listing.
 */
const SENSITIVE_FIELDS = ['title', 'description'] as const;

const EVENT_INCLUDE = {
  category: { select: { id: true, slug: true, nameFa: true } },
  city: { select: { id: true, slug: true, nameFa: true } },
  district: { select: { id: true, slug: true, nameFa: true } },
  /**
   * Only what says whether a post exists and whether Telegram confirmed it.
   *
   * Live rows only: a taken-down post is not a current publication, and counting
   * one would tell a host their expired boost is still in the channel.
   */
  channelPosts: {
    where: { deletedAt: null },
    select: { postedAt: true },
  },
} satisfies Prisma.EventInclude;

/**
 * Event authoring (plan §3.3).
 *
 * Owns the lifecycle up to publication: quota, validation, auto-moderation, and
 * the state transitions between them. Capacity and participation are M6 — this
 * service never touches `accepted_count`.
 */
@Injectable()
export class EventService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly catalog: CatalogService,
    private readonly settings: SettingsService,
    private readonly moderation: ModerationService,
    private readonly coins: CoinService,
    private readonly penalties: PenaltyService,
    private readonly chat: ChatService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates an event and runs it through auto-moderation, in one transaction.
   *
   * The verdict decides the initial status:
   *   - CLEAN → PUBLISHED, moderation APPROVED
   *   - FLAG  → PUBLISHED, moderation FLAGGED, case opened (ADR-0012)
   *   - BLOCK → PENDING_MODERATION, case opened, never visible
   *
   * The scan and the row commit together. Publishing first and scanning after
   * would mean a crash in between leaves banned content live with nothing
   * recording that it was ever judged.
   */
  async create(hostUserId: string, input: CreateEventInput): Promise<EventDetail> {
    const now = this.clock.now();
    this.assertScheduleSane(input.startsAt, input.endsAt, now);
    await this.assertHostCanAuthor(hostUserId);

    const created = await this.prisma.$transaction(async (tx) => {
      await this.assertWithinQuota(tx, hostUserId, now);

      const category = await this.resolveCategory(tx, input.categoryId);
      const location = await this.catalog.resolveLocation(input.cityId, input.districtId, tx);
      const scan = await this.moderation.scanEventContent(input, tx);

      const outcome = outcomeFor(scan.decision);

      // Created as DRAFT and then transitioned, rather than inserted directly in
      // its final state. It costs one UPDATE and buys the property invariant 10
      // asks for: the status this event holds was reached through
      // `assertEventTransition`, not assigned by whichever code path made it.
      const event = await tx.event.create({
        data: {
          // Written from the injected clock rather than left to the column's
          // `default(now())`. The daily quota above filters `createdAt` against a
          // window derived from `Clock`; if the row carried the database's clock
          // instead, the filter and the rows it filters would come from two
          // different sources of time (ADR-0008).
          createdAt: now,
          hostUserId,
          title: input.title,
          description: input.description,
          titleNormalized: scan.normalized.title,
          descriptionNormalized: scan.normalized.description,
          categoryId: category.id,
          cityId: location.cityId,
          districtId: location.districtId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          capacity: input.capacity,
          costType: input.costType,
          costAmount: input.costAmount ?? null,
          costNote: input.costNote ?? null,
          rules: input.rules ?? null,
          genderPreference: input.genderPreference ?? null,
          minAge: input.minAge ?? null,
          maxAge: input.maxAge ?? null,
          externalLink: input.externalLink ?? null,
          status: 'DRAFT',
          moderationStatus: 'PENDING',
        },
        select: { id: true, publicId: true },
      });

      assertEventTransition('DRAFT', 'PENDING_MODERATION', event.id);
      // A BLOCK verdict leaves the event where the first transition put it. That
      // is one transition, not two — asserting PENDING_MODERATION → itself would
      // demand a self-loop in the table, and a table with self-loops stops being
      // able to say that a state is terminal.
      if (outcome.status !== 'PENDING_MODERATION') {
        assertEventTransition('PENDING_MODERATION', outcome.status, event.id);
      }

      await tx.event.update({
        where: { id: event.id },
        data: {
          status: outcome.status,
          moderationStatus: outcome.moderationStatus,
          publishedAt: outcome.status === 'PUBLISHED' ? now : null,
        },
      });

      if (scan.decision !== 'CLEAN') {
        await this.moderation.openCase(tx, {
          subjectType: 'EVENT',
          subjectId: event.id,
          scan,
        });
      }

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: hostUserId,
          action: 'event.created',
          targetType: 'event',
          targetId: event.id,
          after: auditFacts(scan, outcome),
        },
        tx,
      );

      return event.publicId;
    });

    return this.findOwned(hostUserId, created);
  }

  /**
   * Applies a host's edit.
   *
   * A change to the title or description re-runs moderation and takes the event
   * back through `PENDING_MODERATION` (plan §7) — usually straight out again in
   * the same transaction, because the scanner answers immediately. Both hops are
   * audited, so the trail shows the text was re-judged rather than quietly
   * replaced.
   *
   * `expectedVersion` is optimistic concurrency for two host sessions editing at
   * once. Capacity is not protected by it — a counter needs the row lock, which
   * is M6's job.
   */
  async update(
    hostUserId: string,
    publicId: string,
    input: UpdateEventInput,
    expectedVersion?: number,
  ): Promise<EventDetail> {
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      // An edit that changes `capacity` changes the bound `accepted_count` is
      // checked against, so it contends with every join for the same invariant
      // and takes the same lock first (ADR-0006). Without it, lowering capacity
      // while a join is in flight can commit `accepted_count > capacity` — the
      // CHECK then turns a race into a 500 rather than into overbooking, which
      // is better but still wrong. Conditional because an edit that leaves
      // capacity alone cannot move either side of the comparison, and locking
      // unconditionally would put every title fix in the queue behind joiners.
      if (input.capacity !== undefined) {
        await lockEventByPublicIdForUpdate(tx, publicId);
      }

      const existing = await tx.event.findUnique({
        where: { publicId },
        select: {
          id: true,
          hostUserId: true,
          status: true,
          title: true,
          description: true,
          startsAt: true,
          endsAt: true,
          capacity: true,
          acceptedCount: true,
          publishedAt: true,
          version: true,
          deletedAt: true,
        },
      });

      // Ownership is asserted in the service, not the controller (T3.2). The bot
      // will reach this same method in a later milestone.
      if (!existing || existing.deletedAt !== null || existing.hostUserId !== hostUserId) {
        throw new AppError(ErrorCode.EVENT_NOT_FOUND);
      }
      if (expectedVersion !== undefined && expectedVersion !== existing.version) {
        throw new AppError(ErrorCode.CONFLICT_STALE_VERSION, {
          expected: expectedVersion,
          actual: existing.version,
        });
      }
      if (!isEditable(existing.status)) {
        throw new AppError(ErrorCode.INVALID_STATE_TRANSITION, {
          entity: 'event',
          from: existing.status,
          to: 'edited',
        });
      }

      const startsAt = input.startsAt ?? existing.startsAt;
      const endsAt = input.endsAt ?? existing.endsAt;
      this.assertScheduleSane(startsAt, endsAt, now);

      if (input.capacity !== undefined && input.capacity < existing.acceptedCount) {
        throw new AppError(ErrorCode.CAPACITY_BELOW_ACCEPTED, {
          capacity: input.capacity,
          acceptedCount: existing.acceptedCount,
        });
      }

      const data: Prisma.EventUpdateInput = {
        ...pickScalarEdits(input),
        version: { increment: 1 },
      };

      if (input.categoryId !== undefined) {
        const category = await this.resolveCategory(tx, input.categoryId);
        data.category = { connect: { id: category.id } };
      }
      if (input.cityId !== undefined || input.districtId !== undefined) {
        // Resolved as a pair: a district only means something inside its city, so
        // changing either one has to be re-checked against the other.
        const location = await this.catalog.resolveLocation(
          input.cityId ?? (await currentCityId(tx, existing.id)),
          input.districtId,
          tx,
        );
        data.city = { connect: { id: location.cityId } };
        data.district = location.districtId
          ? { connect: { id: location.districtId } }
          : { disconnect: true };
      }

      const contentChanged = SENSITIVE_FIELDS.some(
        (field) => input[field] !== undefined && input[field] !== existing[field],
      );

      let scan: ContentScan | null = null;
      let nextStatus = existing.status;
      let nextModerationStatus: EventModerationStatus | undefined;

      if (contentChanged) {
        scan = await this.rescan(
          tx,
          {
            title: input.title ?? existing.title,
            description: input.description ?? existing.description,
          },
          data,
        );

        const outcome = outcomeFor(scan.decision);

        if (existing.status === 'PUBLISHED') {
          assertEventTransition('PUBLISHED', 'PENDING_MODERATION', existing.id);
        }
        // As in `create`: staying in PENDING_MODERATION is not a transition.
        if (outcome.status !== 'PENDING_MODERATION') {
          assertEventTransition('PENDING_MODERATION', outcome.status, existing.id);
        }

        nextStatus = outcome.status;
        nextModerationStatus = outcome.moderationStatus;
        data.status = outcome.status;
        data.moderationStatus = outcome.moderationStatus;

        // Written once and never moved: `published_at` is when this event first
        // became visible. An edit that sends it back through moderation and out
        // again must not restamp it, or "how long has this been live?" quietly
        // becomes "how long since the host last fixed a typo?".
        if (outcome.status === 'PUBLISHED' && existing.publishedAt === null) {
          data.publishedAt = now;
        }
      }

      await tx.event.update({ where: { id: existing.id }, data });

      if (scan && scan.decision !== 'CLEAN') {
        await this.moderation.openCase(tx, {
          subjectType: 'EVENT',
          subjectId: existing.id,
          scan,
        });
      }

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: hostUserId,
          action: 'event.updated',
          targetType: 'event',
          targetId: existing.id,
          before: { status: existing.status, version: existing.version },
          after: {
            status: nextStatus,
            ...(nextModerationStatus ? { moderationStatus: nextModerationStatus } : {}),
            // Field *names*, never the new values: `audit_log` records that the
            // description changed, not a copy of it (ADR-0009).
            changedFields: Object.keys(input).sort(),
            rescanned: contentChanged,
            ...(scan ? { blacklistVersion: scan.blacklistVersion } : {}),
          },
        },
        tx,
      );
    });

    return this.findOwned(hostUserId, publicId);
  }

  /**
   * Spend coins to promote an event — the only two coin sinks in MVP (plan §2.9).
   *
   * `BOOST` buys a window near the top of discovery; `VIP` is a one-off placement
   * flag. Both go through `CoinService`, so the spend is a ledger row with a
   * reason and a subject, and a host who asks "where did my forty coins go?" gets
   * an answer rather than a shrug.
   *
   * **Lock ordering.** This takes the event lock first and the coin-account lock
   * second, inside `CoinService`. ADR-0006 keeps the event row as the single lock
   * of every *capacity* path, and boost is not one — it never touches
   * `accepted_count`. But it is the first operation in the product to hold both,
   * so it sets the order the rest must follow: **event → user → coin account**,
   * which is already what profile completion does for the last two. M10's host
   * cancellation needs exactly this pair to refund participants, and getting the
   * order wrong there is a deadlock against this method.
   *
   * **On idempotency, honestly.** `VIP` is naturally exactly-once: its key is the
   * event, and a flag can only be set. `BOOST` is not, and cannot be made so
   * here — a second boost is a second purchase of a second window, which is a
   * thing a host may legitimately want. Plan §6's `Idempotency-Key` header is what
   * separates "the user asked twice" from "the request arrived twice", and it is
   * not built yet. Until it is, double-charge protection for boost is the Mini
   * App's in-flight disable and confirmation dialog (§3.7). This is a real gap,
   * and boost is the first endpoint where it is visible to a user's wallet.
   */
  async boost(hostUserId: string, publicId: string, kind: BoostKind): Promise<EventDetail> {
    const now = this.clock.now();

    const [boostCoins, boostHours, vipCoins] = await Promise.all([
      this.settings.getInt('economy.boost_coins'),
      this.settings.getInt('economy.boost_duration_hours'),
      this.settings.getInt('economy.vip_coins'),
    ]);

    const id = await this.prisma.$transaction(
      async (tx) => {
        const locked = await lockEventByPublicIdForUpdate(tx, publicId);
        // Not-yours and not-found answer identically: a stranger must not be able
        // to ask this endpoint whether an event exists (T3.3).
        if (!locked || locked.deletedAt !== null) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
        if (locked.hostUserId !== hostUserId) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

        // Promoting something nobody can join spends coins on nothing. A
        // different code from "not found", because this one the host can act on.
        if (locked.status !== 'PUBLISHED') throw new AppError(ErrorCode.EVENT_NOT_BOOSTABLE);
        if (locked.startsAt <= now) throw new AppError(ErrorCode.EVENT_NOT_BOOSTABLE);

        // Read after the lock rather than widening `LOCKED_COLUMNS`: that
        // projection is narrow on purpose, and every capacity path pays for a
        // column added there.
        const current = await tx.event.findUniqueOrThrow({
          where: { id: locked.id },
          select: { boostedUntil: true, isVip: true },
        });

        const spend =
          kind === 'VIP'
            ? { amount: vipCoins, type: 'VIP_SPEND' as const, key: vipSpendKey(locked.id) }
            : {
                amount: boostCoins,
                type: 'BOOST_SPEND' as const,
                // Derived from the window this purchase produces, so it is
                // deterministic — see the note above on what it does and does not
                // protect against.
                key: boostSpendKey(locked.id, extendedBoost(current.boostedUntil, now, boostHours)),
              };

        const movement = await this.coins.apply(
          {
            userId: hostUserId,
            amount: -spend.amount,
            type: spend.type,
            reasonCode: kind === 'VIP' ? EVENT_VIP_REASON : EVENT_BOOST_REASON,
            idempotencyKey: spend.key,
            actorType: 'USER',
            actorId: hostUserId,
            refType: 'event',
            refId: locked.id,
          },
          tx,
        );

        // A replayed key means the placement was already bought and applied.
        // Charging nothing and changing nothing is the correct pair.
        if (movement.applied) {
          await tx.event.update({
            where: { id: locked.id },
            data:
              kind === 'VIP'
                ? { isVip: true }
                : { boostedUntil: extendedBoost(current.boostedUntil, now, boostHours) },
          });

          await this.audit.record(
            {
              actorType: 'USER',
              actorId: hostUserId,
              action: kind === 'VIP' ? 'event.vip_purchased' : 'event.boosted',
              targetType: 'event',
              targetId: locked.id,
              before: { isVip: current.isVip, boostedUntil: current.boostedUntil?.toISOString() },
              after: { coinsSpent: spend.amount, balance: movement.balance },
            },
            tx,
          );
        }

        return locked.id;
      },
      { isolationLevel: 'ReadCommitted' },
    );

    const event = await this.prisma.event.findUniqueOrThrow({
      where: { id },
      include: EVENT_INCLUDE,
    });
    return toEventDetail(event, this.clock.now());
  }

  /**
   * The host calls the whole thing off (ADR-0011, D9).
   *
   * One transaction under the event lock, doing five things that must all be true
   * together or none of them: the event retires, everybody holding a seat is
   * cancelled and refunded, every conversation closes, the host pays, and one
   * domain event goes out naming everyone who needs telling. A crash that
   * committed some of these would leave strangers messaging each other about a
   * meeting that is not happening, which is the specific failure M8 asked M10 not
   * to ship.
   *
   * **Who gets what.** An ACCEPTED participant had a seat, so they are
   * `CANCELLED_BY_HOST` and refunded whatever taking part cost them. Somebody
   * still PENDING or WAITLISTED was never given anything to take away, so their
   * request `EXPIRED` — which is what the participation state machine has said
   * since M6 and the reason `WAITLISTED → CANCELLED_BY_HOST` is not a legal edge.
   *
   * **The host's price is measured against `starts_at`, not against how many
   * people are affected** — except that with nobody accepted it is free. ADR-0011
   * prices "a host cancelling a published event with accepted participants", and
   * charging for calling off something nobody joined would teach hosts to leave
   * dead events standing, which is worse for everyone reading discovery.
   */
  async cancelByHost(
    hostUserId: string,
    publicId: string,
    reason?: string,
  ): Promise<EventCancellation> {
    const now = this.clock.now();

    const result = await this.prisma.$transaction(
      async (tx) => {
        const locked = await lockEventByPublicIdForUpdate(tx, publicId);
        // Not-yours and not-found answer identically (T3.3).
        if (!locked || locked.deletedAt !== null) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
        if (locked.hostUserId !== hostUserId) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

        // Read after the lock rather than widening `LOCKED_COLUMNS`: the lock
        // helper casts the enum to text so the raw query needs no generated
        // types, and a state machine wants the enum. Same trade boost makes.
        const current = await tx.event.findUniqueOrThrow({
          where: { id: locked.id },
          select: { status: true },
        });
        assertEventTransition(current.status, 'CANCELLED_BY_HOST', locked.id);

        // Cancelling something that already happened is not a cancellation. The
        // lifecycle sweep is what retires a finished event, and letting a host
        // "cancel" it afterwards would rewrite an attendance record.
        if (locked.startsAt <= now) throw new AppError(ErrorCode.EVENT_ALREADY_STARTED);

        const participants = await tx.eventParticipant.findMany({
          where: { eventId: locked.id, status: { in: ['ACCEPTED', 'PENDING', 'WAITLISTED'] } },
          select: { id: true, publicId: true, userId: true, status: true },
          orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        });

        const accepted = participants.filter((row) => row.status === 'ACCEPTED');
        const notified: CancelledParticipant[] = [];
        let refunded = 0;

        // Every coin account this transaction will touch, taken in one fixed
        // order before any of the work starts. Two host cancellations sharing a
        // participant would otherwise be able to deadlock against each other —
        // see `lockAccounts` for why that is latent today and why it is here
        // anyway.
        await this.penalties.lockAccounts(tx, [hostUserId, ...accepted.map((row) => row.userId)]);

        for (const participant of participants) {
          const wasAccepted = participant.status === 'ACCEPTED';
          const to = wasAccepted ? 'CANCELLED_BY_HOST' : 'EXPIRED';
          assertParticipantTransition(participant.status, to, participant.id);

          if (wasAccepted) {
            // D9/D9a. Generic by design: reverse whatever taking part cost this
            // person, which today is nothing because joining is free.
            refunded += await this.penalties.refundParticipant(tx, participant.id, hostUserId);
          }

          await tx.eventParticipant.update({
            where: { id: participant.id },
            data: {
              status: to,
              // The CHECK requires a cancelled row to carry a timestamp, and an
              // expired one must not claim to have been cancelled.
              ...(wasAccepted ? { cancelledAt: now, cancellationReason: reason ?? null } : {}),
              version: { increment: 1 },
            },
          });

          // M8's note to M10, discharged: a chat left open after its event was
          // cancelled is two strangers arranging a meeting that will not happen.
          // Inside this transaction and under the event lock it already holds, so
          // the lock ordering stays event → chat (ADR-0006 rule 2).
          await this.chat.closeForParticipant(
            tx,
            participant.id,
            { reason: 'event_cancelled', actorUserId: hostUserId, action: 'CLOSE' },
            now,
          );

          notified.push({
            participantPublicId: participant.publicId,
            userPublicId: await publicIdOf(tx, participant.userId),
            hadSeat: wasAccepted,
          });
        }

        const bucket = bucketForLateness(locked.startsAt, now);
        const penalty = await this.penalties.chargeHost(tx, {
          eventId: locked.id,
          hostUserId,
          bucket,
          affected: accepted.length,
        });

        await tx.event.update({
          where: { id: locked.id },
          data: {
            status: 'CANCELLED_BY_HOST',
            // Every seat is gone with the event. Set rather than decremented,
            // because there is no partial state to preserve.
            acceptedCount: 0,
            version: { increment: 1 },
          },
        });

        await this.audit.record(
          {
            actorType: 'USER',
            actorId: hostUserId,
            action: 'event.cancelled_by_host',
            targetType: 'event',
            targetId: locked.id,
            before: { status: current.status, acceptedCount: locked.acceptedCount },
            after: {
              status: 'CANCELLED_BY_HOST',
              bucket,
              cancelled: notified.length,
              hadSeats: accepted.length,
              coinsCharged: penalty.coinsCharged,
              trustApplied: penalty.trustApplied,
              coinsRefunded: refunded,
            },
          },
          tx,
        );

        /**
         * One domain event naming everybody, not one per person.
         *
         * The same reasoning M7 used for promotion: a single row emitted inside
         * this transaction makes "a crash cannot tell some of them and lose the
         * rest" true by construction, and M13's relay fans it out into one
         * notification each, made exactly-once by `notification.dedupe_key`.
         *
         * Public ids only — this payload becomes the text of a Telegram message
         * (ADR-0009).
         */
        await this.outbox.emit(
          {
            aggregateType: 'event',
            aggregateId: locked.id,
            eventType: 'event.cancelled_by_host',
            payload: {
              eventPublicId: locked.publicId,
              eventTitle: locked.title,
              startsAt: locked.startsAt.toISOString(),
              participants: notified,
            },
          },
          tx,
        );

        return {
          id: locked.id,
          cancelled: notified.length,
          hadSeats: accepted.length,
          coinsCharged: penalty.coinsCharged,
          coinsRequested: penalty.price.coins,
          trustApplied: penalty.trustApplied,
          coinsRefunded: refunded,
          bucket,
        };
      },
      { isolationLevel: 'ReadCommitted' },
    );

    const event = await this.prisma.event.findUniqueOrThrow({
      where: { id: result.id },
      include: EVENT_INCLUDE,
    });

    return {
      event: toEventDetail(event, this.clock.now()),
      cancelled: result.cancelled,
      hadSeats: result.hadSeats,
      coinsCharged: result.coinsCharged,
      coinsRequested: result.coinsRequested,
      trustApplied: result.trustApplied,
      coinsRefunded: result.coinsRefunded,
      bucket: result.bucket,
    };
  }

  /**
   * What cancelling this event would cost the host right now, charging nothing.
   *
   * The same `bucketForLateness` and `hostPriceFor` the charge uses, against the
   * same server clock — a confirmation dialog that quotes a different number from
   * the one it will take is worse than no dialog.
   */
  async previewHostCancellation(
    hostUserId: string,
    publicId: string,
  ): Promise<HostCancellationPreview> {
    const now = this.clock.now();

    const event = await this.prisma.event.findUnique({
      where: { publicId },
      select: {
        hostUserId: true,
        status: true,
        startsAt: true,
        deletedAt: true,
        participants: { where: { status: 'ACCEPTED' }, select: { id: true } },
      },
    });
    if (!event || event.deletedAt !== null || event.hostUserId !== hostUserId) {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    }

    assertEventTransition(event.status, 'CANCELLED_BY_HOST');
    if (event.startsAt <= now) throw new AppError(ErrorCode.EVENT_ALREADY_STARTED);

    const affected = event.participants.length;
    const bucket = bucketForLateness(event.startsAt, now);

    return {
      bucket,
      affected,
      price: affected > 0 ? await this.penalties.hostPriceFor(bucket) : { coins: 0, trust: 0 },
    };
  }

  /** The host's own events, including ones discovery will never show them. */
  async listOwned(hostUserId: string): Promise<EventDetail[]> {
    const events = await this.prisma.event.findMany({
      where: { hostUserId, deletedAt: null },
      include: EVENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const now = this.clock.now();
    return events.map((event) => toEventDetail(event, now));
  }

  async findOwned(hostUserId: string, publicId: string): Promise<EventDetail> {
    const event = await this.prisma.event.findUnique({
      where: { publicId },
      include: EVENT_INCLUDE,
    });
    // Same error for "does not exist" and "is not yours": a distinguishable
    // response is an existence oracle over every public id (T3.1, T3.3).
    if (!event || event.deletedAt !== null || event.hostUserId !== hostUserId) {
      throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    }
    return toEventDetail(event, this.clock.now());
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async rescan(
    tx: Prisma.TransactionClient,
    content: { title: string; description: string },
    data: Prisma.EventUpdateInput,
  ): Promise<ContentScan> {
    const scan = await this.moderation.scanEventContent(content, tx);
    data.titleNormalized = scan.normalized.title;
    data.descriptionNormalized = scan.normalized.description;
    return scan;
  }

  /** A host must have finished onboarding: an event carries their display name. */
  private async assertHostCanAuthor(hostUserId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: hostUserId },
      select: { onboardingState: true },
    });
    if (!user) throw new AppError(ErrorCode.UNAUTHENTICATED);
    if (user.onboardingState !== 'PROFILE_COMPLETE') {
      throw new AppError(ErrorCode.PROFILE_INCOMPLETE);
    }
  }

  private assertScheduleSane(startsAt: Date, endsAt: Date, now: Date): void {
    if (endsAt <= startsAt) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'endsAt', message: 'must be after startsAt' }],
      });
    }
    if (startsAt <= now) {
      // Against the server clock, never a client-supplied one (invariant 9).
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'startsAt', message: 'must be in the future' }],
      });
    }
  }

  /**
   * The two quotas from plan §11: five per day, three concurrent.
   *
   * The day is a **Tehran** day, not a rolling 24 hours and not a UTC one — "five
   * a day" is a sentence about the user's calendar. Both numbers come from
   * `app_setting`, so tightening them during an abuse wave is a config change.
   *
   * Concurrency counts only events that are still ahead of the host. Without the
   * `startsAt` filter, three events from last month would lock a host out
   * permanently — the lifecycle sweep that retires them is M13.
   */
  private async assertWithinQuota(
    tx: Prisma.TransactionClient,
    hostUserId: string,
    now: Date,
  ): Promise<void> {
    // On `tx`: this runs inside the create transaction, and a settings read on
    // the base client would hold one pool connection while asking for a second.
    const [maxPerDay, maxConcurrent] = await Promise.all([
      this.settings.getInt('events.max_per_day', tx),
      this.settings.getInt('events.max_concurrent_active', tx),
    ]);

    const since = startOfDayIn(now, this.env.APP_TIMEZONE);
    const createdToday = await tx.event.count({
      where: { hostUserId, createdAt: { gte: since } },
    });
    if (createdToday >= maxPerDay) {
      throw new AppError(ErrorCode.EVENT_QUOTA_EXCEEDED, { limit: maxPerDay, scope: 'per_day' });
    }

    const active = await tx.event.count({
      where: {
        hostUserId,
        deletedAt: null,
        status: { in: [...ACTIVE_EVENT_STATUSES] },
        startsAt: { gt: now },
      },
    });
    if (active >= maxConcurrent) {
      throw new AppError(ErrorCode.EVENT_QUOTA_EXCEEDED, {
        limit: maxConcurrent,
        scope: 'concurrent_active',
      });
    }
  }

  private async resolveCategory(
    tx: Prisma.TransactionClient,
    categoryId: string,
  ): Promise<{ id: string }> {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true },
    });
    if (!category || !category.isActive) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'categoryId', message: 'is not a selectable category' }],
      });
    }
    return { id: category.id };
  }
}

interface Outcome {
  status: EventStatus;
  moderationStatus: EventModerationStatus;
}

/**
 * The verdict-to-state mapping, and the place ADR-0012's tuning decision becomes
 * behaviour: FLAG publishes.
 */
function outcomeFor(decision: ContentScan['decision']): Outcome {
  switch (decision) {
    case 'CLEAN':
      return { status: 'PUBLISHED', moderationStatus: 'APPROVED' };
    case 'FLAG':
      return { status: 'PUBLISHED', moderationStatus: 'FLAGGED' };
    case 'BLOCK':
      return { status: 'PENDING_MODERATION', moderationStatus: 'PENDING' };
  }
}

function auditFacts(scan: ContentScan, outcome: Outcome): Prisma.InputJsonValue {
  return {
    status: outcome.status,
    moderationStatus: outcome.moderationStatus,
    decision: scan.decision,
    blacklistVersion: scan.blacklistVersion,
    matchedTermIds: scan.matches.map((match) => match.termId),
  };
}

/** A host may edit while the event is theirs to shape, not after it has run. */
function isEditable(status: EventStatus): boolean {
  return status === 'DRAFT' || status === 'PENDING_MODERATION' || status === 'PUBLISHED';
}

/**
 * The plain columns an edit may set.
 *
 * An allowlist, not a spread of `input`. A spread would let any future field on
 * the DTO reach the table, which is how `status` eventually becomes
 * client-settable by accident.
 */
function pickScalarEdits(input: UpdateEventInput): Prisma.EventUpdateInput {
  const data: Prisma.EventUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.startsAt !== undefined) data.startsAt = input.startsAt;
  if (input.endsAt !== undefined) data.endsAt = input.endsAt;
  if (input.capacity !== undefined) data.capacity = input.capacity;
  if (input.costType !== undefined) data.costType = input.costType;
  if (input.costAmount !== undefined) data.costAmount = input.costAmount;
  if (input.costNote !== undefined) data.costNote = input.costNote;
  if (input.rules !== undefined) data.rules = input.rules;
  if (input.genderPreference !== undefined) data.genderPreference = input.genderPreference;
  if (input.minAge !== undefined) data.minAge = input.minAge;
  if (input.maxAge !== undefined) data.maxAge = input.maxAge;
  if (input.externalLink !== undefined) data.externalLink = input.externalLink;
  return data;
}

async function currentCityId(tx: Prisma.TransactionClient, eventId: string): Promise<string> {
  const row = await tx.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { cityId: true },
  });
  return row.cityId;
}

type EventRow = Prisma.EventGetPayload<{ include: typeof EVENT_INCLUDE }>;

/**
 * `NONE`, `QUEUED` or `PUBLISHED`, from what was bought and what Telegram confirmed.
 *
 * The `bought` test comes first deliberately. A failed send deletes its claim row,
 * so a status read from rows alone would drop to `NONE` between sweeps for an event
 * the host has already paid to promote.
 */
function channelStatusOf(event: EventRow, now: Date): ChannelPublicationStatus {
  const bought = event.isVip || (event.boostedUntil !== null && event.boostedUntil > now);
  if (!bought) return 'NONE';
  const posts = event.channelPosts ?? [];
  return posts.some((post) => post.postedAt !== null) ? 'PUBLISHED' : 'QUEUED';
}

function toEventDetail(event: EventRow, now: Date): EventDetail {
  return {
    publicId: event.publicId,
    title: event.title,
    description: event.description,
    category: event.category,
    city: event.city,
    district: event.district,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    capacity: event.capacity,
    acceptedCount: event.acceptedCount,
    costType: event.costType,
    costAmount: event.costAmount,
    costNote: event.costNote,
    rules: event.rules,
    genderPreference: event.genderPreference,
    minAge: event.minAge,
    maxAge: event.maxAge,
    externalLink: event.externalLink,
    status: event.status,
    moderationStatus: event.moderationStatus,
    publishedAt: event.publishedAt,
    boostedUntil: event.boostedUntil,
    channelStatus: channelStatusOf(event, now),
    isVip: event.isVip,
    version: event.version,
    createdAt: event.createdAt,
  };
}

/**
 * A user's external identifier, for a payload that will become a Telegram
 * message.
 *
 * Internal ids never leave the backend (invariant 7), and the outbox payload is
 * plain jsonb read by the relay — so this translation happens at the point the
 * row is written rather than being left to whoever reads it.
 */
async function publicIdOf(tx: Prisma.TransactionClient, userId: string): Promise<string> {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { publicId: true },
  });
  return user.publicId;
}
