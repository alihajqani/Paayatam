import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type {
  CostType,
  EventModerationStatus,
  EventStatus,
  GenderPreference,
  Prisma,
} from '@payetam/db';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { CatalogService, type NamedRef } from '../catalog/catalog.service';
import { SettingsService } from '../catalog/settings.service';
import { ModerationService, type ContentScan } from '../moderation/moderation.service';
import { startOfDayIn } from '../time';
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

  /** The host's own events, including ones discovery will never show them. */
  async listOwned(hostUserId: string): Promise<EventDetail[]> {
    const events = await this.prisma.event.findMany({
      where: { hostUserId, deletedAt: null },
      include: EVENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return events.map(toEventDetail);
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
    return toEventDetail(event);
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
    const [maxPerDay, maxConcurrent] = await Promise.all([
      this.settings.getInt('events.max_per_day'),
      this.settings.getInt('events.max_concurrent_active'),
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

function toEventDetail(event: EventRow): EventDetail {
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
    version: event.version,
    createdAt: event.createdAt,
  };
}
