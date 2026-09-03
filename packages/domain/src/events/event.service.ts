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
import { CoinService } from '../economy/coin.service';
import { PenaltyService, bucketForLateness, type PenaltyPrice } from '../economy/penalty.service';
import { ChannelService } from '../channel/channel.service';
import { ChannelMembershipService } from '../channel/membership.service';
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
  /**
   * What the host called their activity, for a category that `allowsCustomLabel`
   * («سایر»). Required for those and refused for every other — see
   * `resolveCategory`.
   */
  customCategoryLabel?: string;
  cityId: string;
  districtId?: string;
  /**
   * A neighbourhood the host typed, when the catalogue has no row for one.
   *
   * Mutually exclusive with `districtId`, enforced by a CHECK and by
   * `resolveNeighbourhood` — an event cannot say two different things about
   * where it is. See the column's own note for why free text exists beside a
   * foreign key rather than instead of it.
   */
  districtLabel?: string | null;
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

/**
 * A host's standing against both creation quotas, at one instant.
 *
 * Two counts and two limits rather than one boolean, because the two quotas are
 * cleared by different actions and a surface that only knows "no" cannot say
 * which. `blockedBy` is the summary; the numbers behind it are what lets a
 * message name the limit an operator actually set rather than one compiled in.
 */
export interface HostQuotaStatus {
  /** Events created since midnight in `APP_TIMEZONE`, cancelled ones included. */
  createdToday: number;
  maxPerDay: number;
  /** Undeleted, not-yet-started events in an active status. */
  activeCount: number;
  maxConcurrentActive: number;
  blockedBy: 'per_day' | 'concurrent_active' | null;
}

/**
 * The three M22 sinks (phase 5).
 *
 * Stable strings, because the admin ledger renders them and a rename would make
 * every historical row read as something else (ADR-0007).
 */
export const EVENT_CREATE_REASON = 'event.created';
export const EVENT_CHANNEL_POST_REASON = 'event.channel_post';
export const EVENT_TOP_INVITE_REASON = 'event.invite_top';

/**
 * The creation charge's exactly-once key.
 *
 * Derived from the event, which is allocated inside the same transaction as the
 * charge — so the two commit together or neither does, and a retry that produces
 * a *different* event is a different event and pays for itself. What protects a
 * retry of the *same* intention is plan §6's `Idempotency-Key` header, which the
 * Mini App sends on this endpoint.
 */
export function eventCreateSpendKey(eventId: string): string {
  return `event-create:${eventId}`;
}

/**
 * The paid channel publication's key.
 *
 * The event plus the renewal sequence. It used to be the event alone, on the
 * grounds that *"an event reaches the channel by purchase at most once, ever"* —
 * which stopped being true when renewals arrived. The sequence is what keeps a
 * double-tapped renewal free while letting a deliberate second renewal pay: two
 * taps resolve to the same sequence and collide on
 * `coin_ledger.idempotency_key`; a genuine renewal a week later resolves to the
 * next one.
 *
 * Sequence 0 renders as the original string, so every ledger row written before
 * 0036 keeps the key it was written with.
 */
export function channelPostSpendKey(eventId: string, republishSeq = 0): string {
  return republishSeq === 0
    ? `channel-post:${eventId}`
    : `channel-post:${eventId}:${String(republishSeq)}`;
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
  /** The host's own words, when the category invites them («سایر»). Null otherwise. */
  customCategoryLabel: string | null;
  city: NamedRef;
  district: NamedRef | null;
  /**
   * The neighbourhood the host typed, when there is no catalogue row for it.
   *
   * Never set at the same time as `district` — see `resolveNeighbourhood`. A
   * renderer wanting "where is this?" reads `district?.nameFa ?? districtLabel`.
   */
  districtLabel: string | null;
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
   * How far the channel publication has got.
   *
   * Derived rather than stored: `NONE` when there is no live claim, `PUBLISHED`
   * once a `channel_post` row carries a Telegram message id, and `QUEUED` in
   * between.
   */
  channelStatus: ChannelPublicationStatus;
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
/**
 * Fields whose change re-opens the moderation question.
 *
 * `customCategoryLabel` joined them in M21 for the obvious reason: it is free
 * text a host types, so it is exactly the kind of field the blacklist exists to
 * read. A «سایر» label that never re-triggers a scan would be the one place in
 * the product where a host can write anything and nothing looks at it.
 *
 * `districtLabel` joins them in v0.6.5 on identical terms — it is the *second*
 * such field, and the argument above is about the shape of the field rather than
 * about which one it is.
 */
const SENSITIVE_FIELDS = ['title', 'description', 'customCategoryLabel', 'districtLabel'] as const;

const EVENT_INCLUDE = {
  category: { select: { id: true, slug: true, nameFa: true } },
  city: { select: { id: true, slug: true, nameFa: true } },
  district: { select: { id: true, slug: true, nameFa: true } },
  /**
   * Only what says whether a post exists and whether Telegram confirmed it.
   *
   * Live rows only: a taken-down post is not a current publication, and counting
   * one would tell a host a superseded post is still in the channel.
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
    private readonly channel: ChannelService,
    /**
     * The channel-membership gate (M22 phase 6).
     *
     * Here rather than in a route guard, which is the requirement's own
     * instruction: a guard protects the routes somebody remembered to decorate,
     * and this protects the operation — including from the bot handler and from
     * whatever calls it next.
     */
    private readonly membership: ChannelMembershipService,
    private readonly coins: CoinService,
    private readonly penalties: PenaltyService,
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
   *
   * ── What it costs, and when (M22 phase 5) ──────────────────────────────────
   *
   * `economy.event_create_coins`, charged **inside this transaction**. That is
   * the whole of the "never charge for something that did not happen"
   * requirement: a host who cannot afford it gets `INSUFFICIENT_COINS` and the
   * event row rolls back with the charge, so there is no state where one exists
   * without the other.
   *
   * It is charged for **every** verdict, including BLOCK. The event exists, it
   * consumed a slot of the daily quota, and it is queued for a human to read —
   * all three happened. A moderator who then rejects it can reverse the charge
   * through `coin.adjust`, which is a decision somebody signs for rather than an
   * automatic refund for content the blacklist objected to.
   *
   * Zero means free and writes no ledger row at all: `coin_ledger.amount` may not
   * be zero, and a row claiming somebody paid nothing is worse than no row.
   */
  async create(hostUserId: string, input: CreateEventInput): Promise<EventDetail> {
    const now = this.clock.now();
    this.assertScheduleSane(input.startsAt, input.endsAt, now);
    await this.assertHostCanAuthor(hostUserId);
    await this.membership.assertAllowed(hostUserId, 'EVENT_CREATE');

    // Read before the transaction: it is one indexed lookup, and taking a
    // connection for it while holding the outer one is what `SettingsService`
    // warns about (pool exhaustion under concurrency).
    const [createCost, channelCost] = await Promise.all([
      this.settings.getInt('economy.event_create_coins'),
      this.settings.getInt('economy.event_channel_publish_coins'),
    ]);

    const created = await this.prisma.$transaction(async (tx) => {
      await this.assertWithinQuota(tx, hostUserId, now);

      const location = await this.catalog.resolveLocation(input.cityId, input.districtId, tx);
      // After `resolveLocation`, because the city restriction is checked against
      // the city the catalog accepted rather than the one the client sent.
      const category = await this.resolveCategory(
        tx,
        input.categoryId,
        location.cityId,
        input.customCategoryLabel,
      );
      const neighbourhood = resolveNeighbourhood(location.districtId, input.districtLabel);
      const scan = await this.moderation.scanEventContent(
        {
          ...input,
          customCategoryLabel: category.customCategoryLabel,
          districtLabel: neighbourhood.districtLabel,
        },
        tx,
      );

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
          customCategoryLabel: category.customCategoryLabel,
          cityId: location.cityId,
          districtId: neighbourhood.districtId,
          districtLabel: neighbourhood.districtLabel,
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

      /**
       * The charge, last, and inside the same transaction (M22 phase 5).
       *
       * Last so that a validation refusal above costs nothing and takes no lock
       * on the coin account; inside so that `INSUFFICIENT_COINS` rolls the event
       * back rather than leaving one an unpaying host created.
       *
       * Lock ordering: nothing else is held here — `assertWithinQuota` and the
       * catalog reads take no row locks — so `CoinService`'s `FOR UPDATE` on the
       * account is the only one, which keeps this consistent with ADR-0006's
       * user-then-account rule.
       */
      const charge =
        createCost > 0
          ? await this.coins.apply(
              {
                userId: hostUserId,
                amount: -createCost,
                type: 'EVENT_CREATE_SPEND',
                reasonCode: EVENT_CREATE_REASON,
                idempotencyKey: eventCreateSpendKey(event.id),
                actorType: 'USER',
                actorId: hostUserId,
                refType: 'event',
                refId: event.id,
              },
              tx,
            )
          : null;

      /**
       * The channel publication every registration includes.
       *
       * Claimed and charged here rather than left to the host to buy afterwards:
       * registering is one act at one price, and «۱۵ سکه» is what the form says.
       * Two ledger rows rather than one, because the ledger's job is to say what
       * the coins bought — `EVENT_CREATE_SPEND` and `CHANNEL_POST_SPEND` are
       * different purchases and a merged row could answer neither "what did I pay
       * to register?" nor "what did the channel cost?".
       *
       * In the same transaction as everything above, so a host who can afford the
       * first half and not the second gets `INSUFFICIENT_COINS` and no event —
       * rather than an activity that was charged for a channel post it will never
       * receive.
       *
       * Only for an event that actually became publishable. A BLOCKed or
       * pending-moderation activity has nothing to put in the channel, and the
       * claim's own sweep would skip it anyway; charging for it would be selling
       * a placement that cannot exist.
       */
      const publishedToChannel =
        outcome.status === 'PUBLISHED'
          ? await this.channel.claimPaidPublication(tx, event.id)
          : false;

      if (publishedToChannel && channelCost > 0) {
        await this.coins.apply(
          {
            userId: hostUserId,
            amount: -channelCost,
            type: 'CHANNEL_POST_SPEND',
            reasonCode: EVENT_CHANNEL_POST_REASON,
            idempotencyKey: channelPostSpendKey(event.id),
            actorType: 'USER',
            actorId: hostUserId,
            refType: 'event',
            refId: event.id,
          },
          tx,
        );
      }

      await this.audit.record(
        {
          actorType: 'USER',
          actorId: hostUserId,
          action: 'event.created',
          targetType: 'event',
          targetId: event.id,
          after: {
            ...auditFacts(scan, outcome),
            coinsCharged: charge === null ? 0 : createCost,
            ...(charge !== null ? { balance: charge.balance } : {}),
          },
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
          // For the M21 edit path: a category change, a city change and a custom
          // label change are one question, and answering it needs the values the
          // row currently holds.
          categoryId: true,
          cityId: true,
          customCategoryLabel: true,
          // The typed neighbourhood (v0.6.5). Needed for the same reason the
          // three above are: an edit that touches only the city still has to
          // decide what the row's `where` field ends up saying, and it cannot
          // decide that without knowing what it currently says.
          districtLabel: true,
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

      // The city is settled first, because the category's availability is
      // checked against it — and an edit can move both at once.
      let effectiveCityId = existing.cityId;
      let neighbourhoodLabel: string | null = existing.districtLabel;
      if (
        input.cityId !== undefined ||
        input.districtId !== undefined ||
        input.districtLabel !== undefined
      ) {
        // Resolved as a pair: a district only means something inside its city, so
        // changing either one has to be re-checked against the other.
        const location = await this.catalog.resolveLocation(
          input.cityId ?? existing.cityId,
          input.districtId,
          tx,
        );
        /**
         * The catalogue row and the typed label are alternatives, and an edit is
         * where they are most likely to arrive together — a host who picked a
         * district last week and types a neighbourhood this week. Choosing
         * between them here is what keeps the CHECK from being the thing that
         * discovers the conflict, at which point the whole edit fails with a
         * constraint name in the log and nothing useful on the screen.
         */
        const neighbourhood = resolveNeighbourhood(
          location.districtId,
          input.districtLabel !== undefined ? input.districtLabel : existing.districtLabel,
        );
        effectiveCityId = location.cityId;
        neighbourhoodLabel = neighbourhood.districtLabel;
        data.city = { connect: { id: location.cityId } };
        data.district = neighbourhood.districtId
          ? { connect: { id: neighbourhood.districtId } }
          : { disconnect: true };
        data.districtLabel = neighbourhood.districtLabel;
      }

      // Re-resolved when the category, the label **or the city** moves. The city
      // is the one that is easy to miss: moving a «موزه» event to a city that
      // category is not offered in has to be refused, and an edit that only
      // changed `cityId` would otherwise sail past the check.
      const categoryTouched =
        input.categoryId !== undefined ||
        input.customCategoryLabel !== undefined ||
        effectiveCityId !== existing.cityId;

      if (categoryTouched) {
        const category = await this.resolveCategory(
          tx,
          input.categoryId ?? existing.categoryId,
          effectiveCityId,
          // `undefined` means "not sent", so an edit that touches only the city
          // keeps the label the row already has rather than clearing it.
          input.customCategoryLabel ?? existing.customCategoryLabel ?? undefined,
        );
        data.category = { connect: { id: category.id } };
        data.customCategoryLabel = category.customCategoryLabel;
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
            customCategoryLabel: input.customCategoryLabel ?? existing.customCategoryLabel,
            // What the row will actually hold once the location block above has
            // chosen between the catalogue id and the typed label — not what the
            // input carried, which may have carried both.
            districtLabel: neighbourhoodLabel,
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
   * Buy one publication in the channel (M22 phase 5).
   *
   * `UNIQUE (event_id, kind)` on `channel_post` is what makes a purchase
   * exactly-once, which is why a paid publication has a `channel_post_kind` of
   * its own rather than sharing one with the automatic kinds.
   *
   * Both writes are in one transaction under the event lock. The coins leave and
   * the claim row appears together, or neither does: a charge without a claim is a
   * host who paid for nothing, and a claim without a charge is a free post.
   *
   * **Nothing is sent here.** The row lands unposted and the five-minute channel
   * sweep is what talks to Telegram (ADR-0005, invariant 11). A failure there does
   * *not* release this claim — unlike the automatic kinds, it is the record that
   * somebody paid, and the next sweep retries it.
   */
  async publishToChannel(hostUserId: string, publicId: string): Promise<EventDetail> {
    const now = this.clock.now();
    await this.membership.assertAllowed(hostUserId, 'EVENT_CHANNEL_SEND');
    const cost = await this.settings.getInt('economy.event_channel_send_coins');

    const id = await this.prisma.$transaction(
      async (tx) => {
        const locked = await lockEventByPublicIdForUpdate(tx, publicId);
        // Not-yours and not-found answer identically (T3.3).
        if (!locked || locked.deletedAt !== null) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
        if (locked.hostUserId !== hostUserId) throw new AppError(ErrorCode.EVENT_NOT_FOUND);

        // Publishing something nobody can join, or that has already started,
        // spends coins on an advertisement for nothing.
        if (locked.status !== 'PUBLISHED') throw new AppError(ErrorCode.EVENT_NOT_BOOSTABLE);
        if (locked.startsAt <= now) throw new AppError(ErrorCode.EVENT_NOT_BOOSTABLE);

        /**
         * What is being renewed.
         *
         * A registration already bought the first publication, so this path is
         * now always a *re*-publication and the previous post is what tells us
         * which sequence to take. Its absence means the activity is not in the
         * channel at all — which after 0036 can only happen to an event created
         * before renewals existed, or one whose post a moderator took down. Both
         * are legitimately re-publishable, from sequence 0.
         */
        const current = await this.channel.currentPaidPublication(tx, locked.id);

        /**
         * A renewal renews something that is actually in the channel.
         *
         * The event lock serialises two taps rather than colliding them, so
         * without this a double-tapped «بله» is two sequences and two charges —
         * both legitimate as far as the unique index is concerned. Requiring the
         * previous post to have *reached* Telegram is what makes the second tap
         * refuse: the sweep runs every five minutes, so a host cannot accidentally
         * buy the same placement twice inside one, and a host who deliberately
         * renews an hour later still can.
         *
         * It also says something true. Renewing a post the channel has not shown
         * yet buys nothing: the pending claim would be posted and then immediately
         * superseded by the one that replaced it.
         */
        if (current !== null && current.postedAt === null) {
          throw new AppError(ErrorCode.EVENT_ALREADY_IN_CHANNEL);
        }

        const nextSeq = current === null ? 0 : current.republishSeq + 1;

        // Claimed **before** the charge, so a second purchase is refused rather
        // than charged and then refunded. The unique index is the guard.
        const claimed = await this.channel.claimPaidPublication(tx, locked.id, nextSeq);
        if (!claimed) throw new AppError(ErrorCode.EVENT_ALREADY_IN_CHANNEL);

        // The old message comes down once the new one is claimed, so the channel
        // never shows the same activity twice. Only when there was one, and only
        // when it actually reached Telegram — an unposted claim has no message to
        // remove and the sweep will simply skip it.
        if (current !== null && current.postedAt !== null) {
          await this.channel.supersedePaidPublication(tx, current.id);
        }

        if (cost > 0) {
          const movement = await this.coins.apply(
            {
              userId: hostUserId,
              amount: -cost,
              type: 'CHANNEL_POST_SPEND',
              reasonCode: EVENT_CHANNEL_POST_REASON,
              // The event and the renewal it is: a double tap collides here, a
              // renewal a week later does not.
              idempotencyKey: channelPostSpendKey(locked.id, nextSeq),
              actorType: 'USER',
              actorId: hostUserId,
              refType: 'event',
              refId: locked.id,
            },
            tx,
          );

          await this.audit.record(
            {
              actorType: 'USER',
              actorId: hostUserId,
              action: 'event.channel_post_purchased',
              targetType: 'event',
              targetId: locked.id,
              after: { coinsSpent: cost, balance: movement.balance, republishSeq: nextSeq },
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
        // types, and a state machine wants the enum.
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
    content: {
      title: string;
      description: string;
      customCategoryLabel?: string | null;
      districtLabel?: string | null;
    },
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
   * Where a host stands against both quotas, without attempting anything.
   *
   * ── Why this is public ──────────────────────────────────────────────────────
   *
   * So a surface can ask **before** it takes somebody through a form. The bot's
   * create-event wizard is fourteen questions, and until v0.6.5 the quota was
   * discovered by `create` at the end of them: a host filled in a title, a
   * description, a category, a place, a date, a capacity and a price, pressed
   * «ثبت فعالیت», and was told they had reached a limit that had been reached
   * before they started. The check has to be available where the flow *begins*,
   * and it has to be the same check, which is why `assertWithinQuota` is written
   * in terms of this rather than beside it.
   *
   * It is a **snapshot, not a reservation**: the create path re-checks under its
   * own transaction, because between this answer and the submission the host may
   * have created an event on another surface. A pre-flight that could be trusted
   * to still hold would have to hold a lock for the length of a conversation.
   */
  async quotaFor(hostUserId: string): Promise<HostQuotaStatus> {
    return this.readQuota(this.prisma, hostUserId, this.clock.now());
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
   *
   * ── Two quotas, two error codes ─────────────────────────────────────────────
   *
   * Both used to raise `EVENT_QUOTA_EXCEEDED`, whose Persian is «به سقف ساخت
   * فعالیت در روز رسیده‌اید» — *the daily limit*. So a host stopped by the
   * **concurrency** quota was told the wrong thing, and an operator who went to
   * the panel and raised `events.max_per_day` from 5 to 30 watched the product
   * carry on refusing and reasonably concluded the setting did not work. The
   * message named a number nobody had reached.
   *
   * Naming them apart is the fix, and it is not cosmetic: the two are cleared by
   * different actions. A daily limit is cleared by waiting until tomorrow; a
   * concurrency limit is cleared by finishing or cancelling an event you already
   * have, today.
   */
  private async assertWithinQuota(
    tx: Prisma.TransactionClient,
    hostUserId: string,
    now: Date,
  ): Promise<void> {
    // On `tx`: this runs inside the create transaction, and a settings read on
    // the base client would hold one pool connection while asking for a second.
    const quota = await this.readQuota(tx, hostUserId, now);

    if (quota.createdToday >= quota.maxPerDay) {
      throw new AppError(ErrorCode.EVENT_QUOTA_EXCEEDED, {
        limit: quota.maxPerDay,
        scope: 'per_day',
      });
    }
    if (quota.activeCount >= quota.maxConcurrentActive) {
      throw new AppError(ErrorCode.EVENT_ACTIVE_QUOTA_EXCEEDED, {
        limit: quota.maxConcurrentActive,
        scope: 'concurrent_active',
      });
    }
  }

  /** Both counts and both limits, read together. The one place either is counted. */
  private async readQuota(
    tx: Prisma.TransactionClient,
    hostUserId: string,
    now: Date,
  ): Promise<HostQuotaStatus> {
    const [maxPerDay, maxConcurrentActive] = await Promise.all([
      this.settings.getInt('events.max_per_day', tx),
      this.settings.getInt('events.max_concurrent_active', tx),
    ]);

    const since = startOfDayIn(now, this.env.APP_TIMEZONE);
    const [createdToday, activeCount] = await Promise.all([
      tx.event.count({ where: { hostUserId, createdAt: { gte: since } } }),
      tx.event.count({
        where: {
          hostUserId,
          deletedAt: null,
          status: { in: [...ACTIVE_EVENT_STATUSES] },
          startsAt: { gt: now },
        },
      }),
    ]);

    return {
      createdToday,
      maxPerDay,
      activeCount,
      maxConcurrentActive,
      blockedBy:
        createdToday >= maxPerDay
          ? 'per_day'
          : activeCount >= maxConcurrentActive
            ? 'concurrent_active'
            : null,
    };
  }

  /**
   * The category, the city it is offered in, and the custom label if it takes one.
   *
   * All three together rather than three checks at three call sites: a category
   * restricted to a set of cities and an event in a city outside that set is a
   * pairing, in the same way `resolveLocation` treats a city and a district as a
   * pairing. Checking them apart is how the two quietly disagree.
   */
  private async resolveCategory(
    tx: Prisma.TransactionClient,
    categoryId: string,
    cityId: string,
    customCategoryLabel: string | undefined,
  ): Promise<{ id: string; customCategoryLabel: string | null }> {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { id: true, isActive: true, allowsCustomLabel: true },
    });
    if (!category || !category.isActive) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'categoryId', message: 'is not a selectable category' }],
      });
    }

    // An empty `city_category` set means "offered everywhere" (migration 0020),
    // so the restriction only bites once at least one row exists. Counting first
    // keeps the common case to one indexed read that returns zero.
    const restrictions = await tx.cityCategory.count({ where: { categoryId: category.id } });
    if (restrictions > 0) {
      const offeredHere = await tx.cityCategory.findUnique({
        where: { cityId_categoryId: { cityId, categoryId: category.id } },
        select: { cityId: true },
      });
      if (offeredHere === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          fields: [{ path: 'categoryId', message: 'is not offered in this city' }],
        });
      }
    }

    const label = customCategoryLabel?.trim();
    const hasLabel = label !== undefined && label.length > 0;

    if (category.allowsCustomLabel && !hasLabel) {
      // Required, not optional. A «سایر» event with no label tells a reader
      // nothing at all — it is the one category whose whole meaning is the words
      // the host puts in this field.
      throw new AppError(ErrorCode.CUSTOM_LABEL_REQUIRED);
    }
    if (!category.allowsCustomLabel && hasLabel) {
      throw new AppError(ErrorCode.CUSTOM_LABEL_NOT_ALLOWED);
    }

    return { id: category.id, customCategoryLabel: hasLabel ? label : null };
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

function auditFacts(scan: ContentScan, outcome: Outcome): Record<string, Prisma.InputJsonValue> {
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
/**
 * Which of the two ways of saying "where" this event will actually hold.
 *
 * ── Why the catalogue wins ──────────────────────────────────────────────────
 *
 * A `district` row is an entity: it can be filtered on, ranked with, renamed
 * once for every event that points at it, and deactivated by an operator when a
 * neighbourhood stops being served. Typed text is a string. When both arrive —
 * which is what an edit does whenever a host who once picked a district now
 * types one — keeping the row and dropping the string loses nothing that the
 * string was carrying, and the reverse loses all of the above.
 *
 * ── Why this is a function and not a CHECK alone ────────────────────────────
 *
 * The CHECK exists and is the backstop, exactly as `accepted_count <= capacity`
 * is. But a constraint violation surfaces as a failed transaction with a
 * constraint name in it, and the user on the other end of that gets «خطایی رخ
 * داد» for an edit that was perfectly comprehensible. Deciding in code means the
 * ambiguous input has a defined, documented outcome; the constraint means a
 * future path that forgets to call this cannot write a row that contradicts
 * itself.
 *
 * Trimmed, and an empty string is a null: «   » is not a neighbourhood, and
 * storing it would make `district_label IS NOT NULL` stop meaning "this event
 * says where it is".
 */
function resolveNeighbourhood(
  districtId: string | null,
  districtLabel: string | null | undefined,
): { districtId: string | null; districtLabel: string | null } {
  if (districtId !== null) return { districtId, districtLabel: null };

  const trimmed = districtLabel?.trim() ?? '';
  return { districtId: null, districtLabel: trimmed === '' ? null : trimmed };
}

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

type EventRow = Prisma.EventGetPayload<{ include: typeof EVENT_INCLUDE }>;

/**
 * `NONE`, `QUEUED` or `PUBLISHED`, from the claim rows and what Telegram confirmed.
 *
 * It used to consult `is_vip` / `boosted_until` first, because a failed send
 * deletes its claim row and a status read from rows alone would flicker to
 * `NONE` between sweeps. Those two columns are retired with the promotion
 * feature (v0.7.0), and the claim a *paid publication* takes is never released
 * on failure — `publishToChannel` says so explicitly — so the rows are now the
 * whole answer.
 */
function channelStatusOf(event: EventRow, now: Date): ChannelPublicationStatus {
  void now;
  const posts = event.channelPosts ?? [];
  if (posts.length === 0) return 'NONE';
  return posts.some((post) => post.postedAt !== null) ? 'PUBLISHED' : 'QUEUED';
}

function toEventDetail(event: EventRow, now: Date): EventDetail {
  return {
    publicId: event.publicId,
    title: event.title,
    description: event.description,
    category: event.category,
    customCategoryLabel: event.customCategoryLabel,
    city: event.city,
    district: event.district,
    districtLabel: event.districtLabel,
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
    channelStatus: channelStatusOf(event, now),
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
