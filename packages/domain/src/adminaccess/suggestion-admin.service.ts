import { Inject, Injectable } from '@nestjs/common';
import { DEFAULT_BOT_USERNAME, type Env } from '@payetam/config';
import { PrismaService } from '@payetam/db';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import type {
  CreateEventSuggestionRequest,
  EventSuggestionsResponse,
  EventSuggestionView,
} from '@payetam/shared';
import { encodeStartPayload } from '@payetam/telegram';
import { AuditService } from '../audit/audit.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** The panel shows the recent ones; older suggestions are history, not work. */
const LIST_LIMIT = 100;

const SELECT = {
  id: true,
  publicId: true,
  cityId: true,
  categoryId: true,
  title: true,
  description: true,
  venueLabel: true,
  startsAt: true,
  durationHours: true,
  capacity: true,
  costType: true,
  costAmount: true,
  externalLink: true,
  createdAt: true,
  closedAt: true,
  city: { select: { nameFa: true } },
  category: { select: { nameFa: true } },
  _count: { select: { events: true } },
} as const;

/**
 * Event suggestions, the operator's side (migration 0064).
 *
 * A suggestion is a real outside programme — a screening, a play, a group hike —
 * offered in the channel as «میزبانش می‌شوم». The post itself is written by
 * hand, with a poster; what this service hands back is what its `?start=host_`
 * link is built from — the payload and the bot's username — the one thing in
 * the post a person cannot type correctly. The panel joins them into a `t.me`
 * URL: no API response carries one (the response-leak scan).
 *
 * Everything a suggestion holds becomes the event wizard's answers, so it is
 * refused here for anything the wizard or `EventService.create` would refuse:
 * a city that is not open, a category not offered there, a start already past.
 * A link that opens on a refusal is a post nobody can act on, found by a reader
 * rather than by the operator.
 *
 * Every method begins with `assertPermission` and every write ends with an
 * audit row (ADR-0010 rule 2), as in every other `*AdminService`.
 */
@Injectable()
export class SuggestionAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(session: AdminSession): Promise<EventSuggestionsResponse> {
    this.access.assertPermission(session, PERMISSIONS.SUGGESTION_MANAGE);

    const [rows, cities, categories] = await Promise.all([
      this.prisma.eventSuggestion.findMany({
        orderBy: { startsAt: 'desc' },
        take: LIST_LIMIT,
        select: SELECT,
      }),
      // The pickers offer what `create` accepts, so the form cannot offer a
      // choice the service then refuses. Per-city category restrictions are
      // still checked on create; there are few, and a refusal names them.
      this.prisma.city.findMany({
        where: { isActive: true, isLaunched: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, nameFa: true },
      }),
      this.prisma.category.findMany({
        where: { isActive: true, allowsCustomLabel: false },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, nameFa: true },
      }),
    ]);
    return {
      suggestions: rows.map((row) => this.toView(row)),
      botUsername: this.env.TELEGRAM_BOT_USERNAME ?? DEFAULT_BOT_USERNAME,
      cities,
      categories,
    };
  }

  async create(
    session: AdminSession,
    input: CreateEventSuggestionRequest,
  ): Promise<EventSuggestionView> {
    this.access.assertPermission(session, PERMISSIONS.SUGGESTION_MANAGE);

    const now = this.clock.now();
    const startsAt = new Date(input.startsAt);
    if (startsAt <= now) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const city = await this.prisma.city.findUnique({
      where: { id: input.cityId },
      select: { isActive: true, isLaunched: true },
    });
    if (city === null || !city.isActive || !city.isLaunched) {
      throw new AppError(ErrorCode.VALIDATION_FAILED);
    }

    // What `EventService.resolveCategory` accepts: active, not the «سایر»
    // escape hatch (the wizard no longer asks for a custom label), and offered
    // in this city — a category with no `city_category` rows is offered
    // everywhere (migration 0020).
    const category = await this.prisma.category.findFirst({
      where: {
        id: input.categoryId,
        isActive: true,
        allowsCustomLabel: false,
        OR: [{ cities: { none: {} } }, { cities: { some: { cityId: input.cityId } } }],
      },
      select: { id: true },
    });
    if (category === null) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.eventSuggestion.create({
        data: {
          cityId: input.cityId,
          categoryId: input.categoryId,
          title: input.title,
          description: input.description,
          venueLabel: input.venueLabel,
          startsAt,
          durationHours: input.durationHours,
          capacity: input.capacity,
          costType: input.costType,
          costAmount: input.costAmount ?? null,
          externalLink: input.externalLink ?? null,
          createdByAdminId: session.adminUserId,
          createdAt: now,
        },
        select: SELECT,
      });
      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'suggestion.created',
          targetType: 'event_suggestion',
          targetId: created.id,
          after: {
            publicId: created.publicId,
            cityId: created.cityId,
            title: created.title,
            startsAt: created.startsAt.toISOString(),
          },
        },
        tx,
      );
      return created;
    });

    return this.toView(row);
  }

  /**
   * Stop the link from opening the wizard. Events already made from it stay
   * exactly as they are — closing an offer is not cancelling anybody's plan.
   *
   * Closing twice is a no-op with no second audit row: the panel's button can
   * be pressed again from a stale list, and nothing changed the second time.
   */
  async close(session: AdminSession, publicId: string): Promise<EventSuggestionView> {
    this.access.assertPermission(session, PERMISSIONS.SUGGESTION_MANAGE);

    const existing = await this.prisma.eventSuggestion.findUnique({
      where: { publicId },
      select: SELECT,
    });
    if (existing === null) throw new AppError(ErrorCode.NOT_FOUND);
    if (existing.closedAt !== null) return this.toView(existing);

    const now = this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      const closed = await tx.eventSuggestion.update({
        where: { id: existing.id },
        data: { closedAt: now },
        select: SELECT,
      });
      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'suggestion.closed',
          targetType: 'event_suggestion',
          targetId: existing.id,
          after: { publicId, closedAt: now.toISOString() },
        },
        tx,
      );
      return closed;
    });
    return this.toView(row);
  }

  private toView(row: {
    publicId: string;
    cityId: string;
    categoryId: string;
    title: string;
    description: string;
    venueLabel: string;
    startsAt: Date;
    durationHours: number;
    capacity: number;
    costType: EventSuggestionView['costType'];
    costAmount: number | null;
    externalLink: string | null;
    createdAt: Date;
    closedAt: Date | null;
    city: { nameFa: string };
    category: { nameFa: string };
    _count: { events: number };
  }): EventSuggestionView {
    return {
      publicId: row.publicId,
      cityId: row.cityId,
      cityNameFa: row.city.nameFa,
      categoryId: row.categoryId,
      categoryNameFa: row.category.nameFa,
      title: row.title,
      description: row.description,
      venueLabel: row.venueLabel,
      startsAt: row.startsAt.toISOString(),
      durationHours: row.durationHours,
      capacity: row.capacity,
      costType: row.costType,
      costAmount: row.costAmount,
      externalLink: row.externalLink,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      isOpen: row.closedAt === null && row.startsAt > this.clock.now(),
      eventCount: row._count.events,
      startPayload: encodeStartPayload('host', row.publicId),
    };
  }
}
