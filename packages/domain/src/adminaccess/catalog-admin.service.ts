import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { isUniqueViolation } from '../identity/user.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/**
 * The «تفریحات» catalogue, as something an operator edits (M21).
 *
 * `catalog.manage` has been in the permission catalogue since M12 with nothing
 * behind it — `docs/admin-panel.md` listed it under "not built". This is the
 * missing half. Until now, adding an activity meant editing `tools/seed-catalog.ts`,
 * getting a review, and shipping a release; that is the wrong shape for a list
 * whose whole job is to grow every time the product enters a city it has not
 * served before.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 *
 * Categories only, not the whole catalog. Cities, districts and interests stay
 * seed-managed. Cities in particular are now generated data with a provenance
 * (`tools/data/build-iran-geography.mjs`) — a screen for hand-editing 1,252
 * generated rows would invite exactly the drift the generator exists to prevent.
 *
 * ── Rules the panel cannot talk this service out of ──────────────────────────
 *
 * **A slug is immutable.** It is the identifier seeds, integration tests and
 * documentation refer to. `updateTag` has no slug field at all, rather than one
 * it validates and refuses: an endpoint that can be *asked* to rename is one
 * somebody eventually wires a text input to.
 *
 * **A tag with events is deactivated, never deleted.** `is_active` exists so a
 * retired row keeps the events pointing at it intact (migration 0003), and the
 * FK is `RESTRICT` — so the alternative to refusing here is a 500 from Postgres
 * with no useful message. The refusal names the count.
 *
 * Every mutating method begins with `assertPermission` and ends with an audit
 * row, in that order, like every other service in this directory (ADR-0010 rule 2).
 */
@Injectable()
export class CatalogAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every activity tag, active or not, in the order the picker shows them.
   *
   * Inactive rows are included on purpose: this is the screen where somebody
   * turns one back on, and a list that hid them would make that impossible from
   * the panel that owns the list.
   */
  async listTags(session: AdminSession): Promise<ActivityTagSummary[]> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const rows = await this.prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
      select: {
        id: true,
        slug: true,
        nameFa: true,
        icon: true,
        isActive: true,
        sortOrder: true,
        allowsCustomLabel: true,
        cities: { select: { cityId: true } },
        // What makes a delete refusable *before* the operator clicks it.
        _count: { select: { events: true } },
      },
    });

    return rows.map((row) => toSummary(row));
  }

  /**
   * Provinces and cities, for the "which cities is this tag offered in" picker.
   *
   * Read-only, and the *whole* list — inactive cities included. An admin
   * restricting a tag to a city they are about to activate is a normal order of
   * operations, and a picker that hid the city until afterwards would force them
   * to do it in the other order for no reason.
   *
   * Not `GET /api/v1/catalog`: that one is public, cached and active-only, and
   * bending it to serve an admin picker is how a cached public response starts
   * carrying rows nobody meant to publish.
   */
  async listPlaces(session: AdminSession): Promise<AdminPlaces> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const [provinces, cities] = await Promise.all([
      this.prisma.province.findMany({
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        select: { id: true, slug: true, nameFa: true },
      }),
      this.prisma.city.findMany({
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        select: { id: true, slug: true, nameFa: true, provinceId: true, isActive: true },
      }),
    ]);

    return { provinces, cities };
  }

  async createTag(
    session: AdminSession,
    input: CreateActivityTagInput,
  ): Promise<ActivityTagSummary> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    if (input.cityIds) await this.assertCitiesExist(input.cityIds);

    let created;
    try {
      created = await this.prisma.category.create({
        data: {
          slug: input.slug,
          nameFa: input.nameFa,
          icon: input.icon ?? null,
          // Defaults to *active*, unlike the column's `false`. A tag an operator
          // deliberately created and then had to find and switch on is a papercut
          // with no upside; the column's default serves seeds, which want the
          // opposite.
          isActive: input.isActive ?? true,
          sortOrder: input.sortOrder ?? (await this.nextSortOrder()),
          allowsCustomLabel: input.allowsCustomLabel ?? false,
          ...(input.cityIds
            ? { cities: { create: input.cityIds.map((cityId) => ({ cityId })) } }
            : {}),
        },
        select: TAG_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(ErrorCode.CATALOG_SLUG_TAKEN);
      throw error;
    }

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.tag.created',
      targetType: 'category',
      targetId: created.id,
      after: auditShape(created),
    });

    return toSummary(created);
  }

  /**
   * Change what a tag says or where it is offered. Never what it *is*.
   *
   * An omitted field is left alone rather than cleared, so the panel can send one
   * toggle and two operators editing different fields do not overwrite each
   * other. `icon: null` and `cityIds: null` are therefore meaningful values —
   * "no icon", "everywhere" — and distinct from omitting them.
   */
  async updateTag(
    session: AdminSession,
    id: string,
    input: UpdateActivityTagInput,
  ): Promise<ActivityTagSummary> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const before = await this.prisma.category.findUnique({ where: { id }, select: TAG_SELECT });
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);

    if (input.cityIds) await this.assertCitiesExist(input.cityIds);

    const data: Prisma.CategoryUpdateInput = {};
    if (input.nameFa !== undefined) data.nameFa = input.nameFa;
    if (input.icon !== undefined) data.icon = input.icon;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.allowsCustomLabel !== undefined) data.allowsCustomLabel = input.allowsCustomLabel;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (input.cityIds !== undefined) {
        // Replace rather than diff. The set is small, the write is inside a
        // transaction, and a diff would be more code to get the empty cases
        // wrong in.
        await tx.cityCategory.deleteMany({ where: { categoryId: id } });
        if (input.cityIds !== null && input.cityIds.length > 0) {
          await tx.cityCategory.createMany({
            data: input.cityIds.map((cityId) => ({ cityId, categoryId: id })),
            skipDuplicates: true,
          });
        }
      }

      return tx.category.update({ where: { id }, data, select: TAG_SELECT });
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.tag.updated',
      targetType: 'category',
      targetId: id,
      before: auditShape(before),
      after: auditShape(updated),
    });

    return toSummary(updated);
  }

  /**
   * Delete a tag nothing has used yet.
   *
   * The `eventCount` check is the whole method. Everything that has ever been
   * filed under this tag would otherwise have to be re-filed or destroyed, and
   * neither is a thing a delete button should do quietly — so a tag in use is
   * refused with its count, and the panel offers deactivation instead.
   */
  async deleteTag(session: AdminSession, id: string): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const tag = await this.prisma.category.findUnique({ where: { id }, select: TAG_SELECT });
    if (tag === null) throw new AppError(ErrorCode.NOT_FOUND);

    if (tag._count.events > 0) {
      throw new AppError(ErrorCode.CATALOG_TAG_IN_USE, { eventCount: tag._count.events });
    }

    // `interest.category_id` is `SetNull` (schema), so interests filed under this
    // tag survive as uncategorised rather than vanishing with it. `city_category`
    // is `Cascade`, because a restriction on a tag that no longer exists is not
    // information anybody wants kept.
    await this.prisma.category.delete({ where: { id } });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.tag.deleted',
      targetType: 'category',
      targetId: id,
      before: auditShape(tag),
    });
  }

  /**
   * Rewrite the whole ordering in one transaction.
   *
   * One call rather than one PATCH per row: a drag that lands as five requests
   * can half-fail and leave the list in an order nobody chose, and the operator
   * has no way to tell which half won.
   *
   * Ids not named in `order` keep their `sortOrder` and therefore sort after the
   * reordered block — a partial reorder is a legitimate thing to send.
   */
  async reorderTags(session: AdminSession, order: string[]): Promise<ActivityTagSummary[]> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const known = await this.prisma.category.findMany({
      where: { id: { in: order } },
      select: { id: true },
    });
    if (known.length !== new Set(order).size) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'order', message: 'contains an id that is not an activity tag' }],
      });
    }

    await this.prisma.$transaction(
      // Tens apart, so an operator can later slot a row between two without
      // renumbering the list — the same reason the seed numbers by ten.
      order.map((id, index) =>
        this.prisma.category.update({ where: { id }, data: { sortOrder: index * 10 } }),
      ),
    );

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.tag.reordered',
      targetType: 'category',
      after: { order },
    });

    return this.listTags(session);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Every id in a restriction must be a real city.
   *
   * The FK would catch this too, as a 500 with a constraint name in it. Checking
   * here turns the same mistake into a 422 that names the ids, which is what the
   * panel needs to highlight the rows rather than clear the form.
   */
  private async assertCitiesExist(cityIds: string[]): Promise<void> {
    const requested = [...new Set(cityIds)];
    const found = await this.prisma.city.findMany({
      where: { id: { in: requested } },
      select: { id: true },
    });
    if (found.length !== requested.length) {
      const valid = new Set(found.map((city) => city.id));
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'cityIds', message: 'contains an unknown city' }],
        invalidCityIds: requested.filter((id) => !valid.has(id)),
      });
    }
  }

  /** Ten past the last one, so a new tag lands at the end instead of on top of one. */
  private async nextSortOrder(): Promise<number> {
    const last = await this.prisma.category.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? 0) + 10;
  }
}

const TAG_SELECT = {
  id: true,
  slug: true,
  nameFa: true,
  icon: true,
  isActive: true,
  sortOrder: true,
  allowsCustomLabel: true,
  cities: { select: { cityId: true } },
  _count: { select: { events: true } },
} as const;

type TagRow = Prisma.CategoryGetPayload<{ select: typeof TAG_SELECT }>;

export interface AdminPlaces {
  provinces: { id: string; slug: string; nameFa: string }[];
  cities: {
    id: string;
    slug: string;
    nameFa: string;
    provinceId: string | null;
    isActive: boolean;
  }[];
}

export interface ActivityTagSummary {
  id: string;
  slug: string;
  nameFa: string;
  icon: string | null;
  isActive: boolean;
  sortOrder: number;
  allowsCustomLabel: boolean;
  /** The cities it is offered in, or `null` for everywhere. */
  cityIds: string[] | null;
  eventCount: number;
}

/**
 * `| undefined` is spelled out on every optional field because the workspace runs
 * `exactOptionalPropertyTypes`. Under that flag `icon?: string | null` accepts an
 * *absent* key but not an explicit `icon: undefined`, and a Zod-parsed body hands
 * over exactly the latter.
 */
export interface CreateActivityTagInput {
  slug: string;
  nameFa: string;
  icon?: string | null | undefined;
  isActive?: boolean | undefined;
  sortOrder?: number | undefined;
  allowsCustomLabel?: boolean | undefined;
  cityIds?: string[] | null | undefined;
}

/**
 * Everything except the slug. Written out rather than `Partial<…>` for the same
 * reason as above: `Partial` produces `nameFa?: string`, which under
 * `exactOptionalPropertyTypes` rejects the explicit `undefined` a parsed body has.
 */
export interface UpdateActivityTagInput {
  nameFa?: string | undefined;
  icon?: string | null | undefined;
  isActive?: boolean | undefined;
  sortOrder?: number | undefined;
  allowsCustomLabel?: boolean | undefined;
  cityIds?: string[] | null | undefined;
}

function toSummary(row: TagRow): ActivityTagSummary {
  return {
    id: row.id,
    slug: row.slug,
    nameFa: row.nameFa,
    icon: row.icon,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    allowsCustomLabel: row.allowsCustomLabel,
    // No rows means unrestricted — see `categoryView.cityIds` for why the wire
    // spells that `null` rather than `[]`.
    cityIds: row.cities.length === 0 ? null : row.cities.map((city) => city.cityId),
    eventCount: row._count.events,
  };
}

/**
 * What goes in the audit row.
 *
 * An allowlist rather than a spread, like every other service here. Nothing in a
 * category is sensitive today — but `before`/`after` are a read surface staff
 * export, and "it happened to be safe when I wrote it" is not a property that
 * survives someone adding a column.
 *
 * `cityIds` is recorded as a count. A restriction over 400 cities would otherwise
 * put 400 uuids in a row somebody has to read in an incident.
 */
function auditShape(row: TagRow): Prisma.InputJsonValue {
  return {
    slug: row.slug,
    nameFa: row.nameFa,
    icon: row.icon,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    allowsCustomLabel: row.allowsCustomLabel,
    cityCount: row.cities.length,
  };
}
