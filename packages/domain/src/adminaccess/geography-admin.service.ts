import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { normalize } from '../moderation/persian-normalizer';
import { isUniqueViolation } from '../identity/user.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

export interface ProvinceSummary {
  id: string;
  slug: string;
  nameFa: string;
  isActive: boolean;
  sortOrder: number;
  cityCount: number;
  activeCityCount: number;
}

export interface CitySummary {
  id: string;
  slug: string;
  nameFa: string;
  isActive: boolean;
  /** Whether the product runs here yet (v0.10.0). */
  isLaunched: boolean;
  sortOrder: number;
  provinceId: string | null;
  provinceNameFa: string | null;
  districtCount: number;
  profileCount: number;
  eventCount: number;
}

/**
 * Provinces and cities, as something an operator edits (M22 phase 9).
 *
 * M21 generated 31 provinces and 1,252 cities and `CatalogAdminService` said, in
 * as many words, that cities stay seed-managed: *"a screen for hand-editing 1,252
 * generated rows would invite exactly the drift the generator exists to prevent."*
 * That was right about editing and wrong about **activating** — `city.is_active`
 * defaults to `false`, so on a fresh deployment the product serves nowhere, and
 * the only way to open a city was `psql`. Turning a city on is a business
 * decision somebody makes weekly; it is not drift.
 *
 * So the shape of this service is that distinction:
 *
 *  - **Activation, ordering and province assignment are freely editable.** They
 *    are operational state, not generated data.
 *  - **The slug is immutable**, exactly as an activity tag's is. It is what seeds,
 *    fixtures and documentation refer to.
 *  - **The Persian name is editable**, and every write recomputes
 *    `name_normalized` through the ADR-0012 pipeline — so the Mini App's search
 *    keeps finding a renamed city without a backfill.
 *  - **Nothing is deleted while anything references it.** A city with profiles,
 *    events or districts can only be deactivated, and deactivating one that has
 *    references needs a second, explicit confirmation carrying the counts.
 *
 * Every mutating method begins with `assertPermission` and ends with an audit row,
 * in that order (ADR-0010 rule 2).
 */
@Injectable()
export class GeographyAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  // ── Provinces ──────────────────────────────────────────────────────────────

  /** All 31, active or not, in picker order. Small enough to never page. */
  async listProvinces(session: AdminSession): Promise<ProvinceSummary[]> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const rows = await this.prisma.province.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
      select: {
        id: true,
        slug: true,
        nameFa: true,
        isActive: true,
        sortOrder: true,
        _count: { select: { cities: true } },
        cities: { where: { isActive: true }, select: { id: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      nameFa: row.nameFa,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      cityCount: row._count.cities,
      // Counted from the included ids rather than a second aggregate: 31 rows
      // with ~40 active cities each is a few hundred ids, and a `_count` with a
      // filter would be a second query per row.
      activeCityCount: row.cities.length,
    }));
  }

  async createProvince(
    session: AdminSession,
    input: { slug: string; nameFa: string; sortOrder?: number | undefined },
  ): Promise<ProvinceSummary> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    let created;
    try {
      created = await this.prisma.province.create({
        data: {
          slug: input.slug,
          nameFa: input.nameFa,
          sortOrder: input.sortOrder ?? (await this.nextProvinceOrder()),
        },
        select: { id: true, slug: true, nameFa: true, isActive: true, sortOrder: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(ErrorCode.CATALOG_SLUG_TAKEN);
      throw error;
    }

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.province.created',
      targetType: 'province',
      targetId: created.id,
      after: { slug: created.slug, nameFa: created.nameFa, sortOrder: created.sortOrder },
    });

    return { ...created, cityCount: 0, activeCityCount: 0 };
  }

  /**
   * Rename, reorder or hide a province.
   *
   * Deactivating a province is **presentational**: it hides the grouping from the
   * picker and does not touch the cities filed under it, which keep their own
   * `is_active`. That asymmetry is migration 0020's — a province is a heading, a
   * city is a place the product does or does not serve — and it is the reason
   * there is no reference check here.
   */
  async updateProvince(
    session: AdminSession,
    id: string,
    input: {
      nameFa?: string | undefined;
      isActive?: boolean | undefined;
      sortOrder?: number | undefined;
    },
  ): Promise<ProvinceSummary> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const before = await this.prisma.province.findUnique({
      where: { id },
      select: { slug: true, nameFa: true, isActive: true, sortOrder: true },
    });
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);

    const data: Prisma.ProvinceUpdateInput = {};
    if (input.nameFa !== undefined) data.nameFa = input.nameFa;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    await this.prisma.province.update({ where: { id }, data });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.province.updated',
      targetType: 'province',
      targetId: id,
      before: { ...before },
      after: { ...before, ...input },
    });

    const [updated] = await this.listProvinces(session).then((rows) =>
      rows.filter((row) => row.id === id),
    );
    if (updated === undefined) throw new AppError(ErrorCode.INTERNAL_ERROR);
    return updated;
  }

  // ── Cities ─────────────────────────────────────────────────────────────────

  /**
   * A page of cities, searched on the server.
   *
   * The search runs over `name_normalized`, which migration 0021 backfilled and
   * every write here maintains — so «قايم» finds «قائم‌شهر» for the same reason it
   * does in the Mini App's picker, and against the same folding. A `gin_trgm_ops`
   * index answers the `contains`.
   *
   * A `publicId` is not matched because a city has none: it is catalog data, not a
   * person, and its uuid is the identifier every screen already uses.
   */
  async listCities(
    session: AdminSession,
    filters: {
      query?: string | undefined;
      provinceId?: string | undefined;
      isActive?: boolean | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ rows: CitySummary[]; total: number }> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const query = filters.query?.trim();
    const where: Prisma.CityWhereInput = {
      ...(filters.provinceId !== undefined ? { provinceId: filters.provinceId } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      ...(query !== undefined && query !== ''
        ? {
            OR: [
              // Normalized first — it is the one with the index and the one that
              // folds ی/ي. The raw column is the fallback for any row written
              // before 0021's backfill, which should be none.
              { nameNormalized: { contains: normalize(query) } },
              { nameFa: { contains: query } },
              { slug: { contains: query.toLowerCase() } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.city.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        take: Math.min(Math.max(filters.limit ?? 50, 1), 200),
        skip: Math.max(filters.offset ?? 0, 0),
        select: CITY_SELECT,
      }),
      this.prisma.city.count({ where }),
    ]);

    return { rows: rows.map(toCitySummary), total };
  }

  /**
   * Add a city the generator did not produce.
   *
   * Inactive by default, matching the column: a city an operator has just typed is
   * not yet a place the product serves, and defaulting to active would put it in
   * every picker before anybody decided that. This is the opposite default from
   * `CatalogAdminService.createTag`, and deliberately — a tag is offered
   * everywhere the moment it exists, a city is a market.
   */
  async createCity(
    session: AdminSession,
    input: {
      slug: string;
      nameFa: string;
      provinceId?: string | undefined;
      isActive?: boolean | undefined;
      sortOrder?: number | undefined;
    },
  ): Promise<CitySummary> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    if (input.provinceId !== undefined) await this.assertProvinceExists(input.provinceId);

    let created;
    try {
      created = await this.prisma.city.create({
        data: {
          slug: input.slug,
          nameFa: input.nameFa,
          nameNormalized: normalize(input.nameFa),
          isActive: input.isActive ?? false,
          sortOrder: input.sortOrder ?? (await this.nextCityOrder(input.provinceId)),
          provinceId: input.provinceId ?? null,
        },
        select: CITY_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(ErrorCode.CATALOG_SLUG_TAKEN);
      throw error;
    }

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.city.created',
      targetType: 'city',
      targetId: created.id,
      after: cityAuditShape(created),
    });

    return toCitySummary(created);
  }

  /**
   * Rename, re-file, reorder, activate or deactivate a city.
   *
   * **Deactivating one that anything points at needs `confirmReferences`.** The
   * refusal carries the counts, which is the whole point: an operator turning off
   * a city with 234 profiles in it should find that out before it happens, not
   * from the support queue. Activation never needs confirmation — it widens.
   *
   * Nothing here can delete. Deactivation is what `is_active` exists for
   * (migration 0003), and the foreign keys are `RESTRICT`, so the alternative to
   * refusing is a constraint violation with no useful message.
   */
  async updateCity(
    session: AdminSession,
    id: string,
    input: {
      nameFa?: string | undefined;
      provinceId?: string | null | undefined;
      isActive?: boolean | undefined;
      /**
       * Open or close the city (v0.10.0).
       *
       * No `confirmReferences` guard, unlike `isActive`: closing a city does not
       * orphan anything. Profiles keep naming it — that is the queue — and the
       * events already published there keep running; it only stops new ones
       * being created and turns discovery into the waitlist screen.
       */
      isLaunched?: boolean | undefined;
      sortOrder?: number | undefined;
      confirmReferences?: boolean | undefined;
    },
  ): Promise<CitySummary> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const before = await this.prisma.city.findUnique({ where: { id }, select: CITY_SELECT });
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);

    if (input.provinceId !== undefined && input.provinceId !== null) {
      await this.assertProvinceExists(input.provinceId);
    }

    const deactivating = input.isActive === false && before.isActive;
    const references = before._count.profiles + before._count.events;
    if (deactivating && references > 0 && input.confirmReferences !== true) {
      throw new AppError(ErrorCode.CITY_HAS_REFERENCES, {
        profileCount: before._count.profiles,
        eventCount: before._count.events,
        districtCount: before._count.districts,
      });
    }

    const data: Prisma.CityUpdateInput = {};
    if (input.nameFa !== undefined) {
      data.nameFa = input.nameFa;
      // Recomputed on every rename, so the Mini App's search and the admin list
      // keep agreeing without a backfill.
      data.nameNormalized = normalize(input.nameFa);
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.isLaunched !== undefined) data.isLaunched = input.isLaunched;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.provinceId !== undefined) {
      data.province =
        input.provinceId === null ? { disconnect: true } : { connect: { id: input.provinceId } };
    }

    await this.prisma.city.update({ where: { id }, data });

    const after = await this.prisma.city.findUniqueOrThrow({ where: { id }, select: CITY_SELECT });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.city.updated',
      targetType: 'city',
      targetId: id,
      before: cityAuditShape(before),
      after: {
        ...cityAuditShape(after),
        // Recorded when it applied, so "who turned off a city 234 people live in"
        // is answerable from the trail alone.
        ...(deactivating ? { deactivatedWithReferences: references } : {}),
      },
    });

    return toCitySummary(after);
  }

  /**
   * Rewrite the ordering of a block of cities in one transaction.
   *
   * One call rather than one PATCH per row, for the reason `reorderTags` gives: a
   * drag that lands as five requests can half-fail and leave an order nobody
   * chose, with no way to tell which half won.
   *
   * Numbered in tens so a later insertion can slot between two without renumbering
   * the list — the same convention the geography seed uses.
   */
  async reorderCities(session: AdminSession, order: string[]): Promise<void> {
    this.access.assertPermission(session, PERMISSIONS.CATALOG_MANAGE);

    const known = await this.prisma.city.findMany({
      where: { id: { in: order } },
      select: { id: true },
    });
    if (known.length !== new Set(order).size) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'order', message: 'contains an id that is not a city' }],
      });
    }

    await this.prisma.$transaction(
      order.map((id, index) =>
        this.prisma.city.update({ where: { id }, data: { sortOrder: index * 10 } }),
      ),
    );

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'catalog.city.reordered',
      targetType: 'city',
      after: { count: order.length },
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async assertProvinceExists(provinceId: string): Promise<void> {
    const province = await this.prisma.province.findUnique({
      where: { id: provinceId },
      select: { id: true },
    });
    // The FK would catch this too, as a 500 with a constraint name in it.
    // Checking here turns the same mistake into a 422 the panel can act on.
    if (province === null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'provinceId', message: 'no such province' }],
      });
    }
  }

  private async nextProvinceOrder(): Promise<number> {
    const last = await this.prisma.province.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? 0) + 10;
  }

  /** Ten past the last one **in the same province**, so a new city lands locally. */
  private async nextCityOrder(provinceId: string | undefined): Promise<number> {
    const last = await this.prisma.city.findFirst({
      where: provinceId !== undefined ? { provinceId } : {},
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    return (last?.sortOrder ?? 0) + 10;
  }
}

const CITY_SELECT = {
  id: true,
  slug: true,
  nameFa: true,
  isActive: true,
  isLaunched: true,
  sortOrder: true,
  provinceId: true,
  province: { select: { nameFa: true } },
  _count: { select: { districts: true, profiles: true, events: true } },
} as const;

type CityRow = Prisma.CityGetPayload<{ select: typeof CITY_SELECT }>;

function toCitySummary(row: CityRow): CitySummary {
  return {
    id: row.id,
    slug: row.slug,
    nameFa: row.nameFa,
    isActive: row.isActive,
    isLaunched: row.isLaunched,
    sortOrder: row.sortOrder,
    provinceId: row.provinceId,
    provinceNameFa: row.province?.nameFa ?? null,
    districtCount: row._count.districts,
    profileCount: row._count.profiles,
    eventCount: row._count.events,
  };
}

/** An allowlist, never a spread — `before`/`after` are a read surface staff export. */
function cityAuditShape(row: CityRow): Record<string, Prisma.InputJsonValue> {
  return {
    slug: row.slug,
    nameFa: row.nameFa,
    isActive: row.isActive,
    // Opening a city is the decision this trail most needs to hold: it changes
    // where the product runs, and «چه کسی مشهد را باز کرد و کِی» has to be
    // answerable (invariant 12).
    isLaunched: row.isLaunched,
    sortOrder: row.sortOrder,
    provinceId: row.provinceId ?? '',
  };
}
