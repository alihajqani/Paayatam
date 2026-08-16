import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';

export interface NamedRef {
  id: string;
  slug: string;
  nameFa: string;
}

export interface CatalogSnapshot {
  cities: (NamedRef & { districts: NamedRef[] })[];
  categories: (NamedRef & { icon: string | null })[];
  interests: (NamedRef & { categoryId: string | null })[];
}

/** The place a user says they are, once it has been checked against the catalog. */
export interface ResolvedLocation {
  cityId: string;
  districtId: string | null;
}

/**
 * Owns every list a user is allowed to pick from (plan §3.3).
 *
 * The invariant this module defends is "all user-selectable lists are
 * admin-managed". In practice that means two things, and both live here rather
 * than being restated by each caller: nothing inactive is ever offered, and
 * nothing inactive is ever accepted.
 */
@Injectable()
export class CatalogService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Everything selectable, in one read.
   *
   * The onboarding wizard needs all three lists to render one form, and they are
   * small and change rarely — so three endpoints would cost three round trips
   * over a mobile connection for no benefit.
   */
  async snapshot(): Promise<CatalogSnapshot> {
    const [cities, categories, interests] = await Promise.all([
      this.prisma.city.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        include: {
          districts: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
            select: { id: true, slug: true, nameFa: true },
          },
        },
      }),
      this.prisma.category.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        select: { id: true, slug: true, nameFa: true, icon: true },
      }),
      this.prisma.interest.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        select: { id: true, slug: true, nameFa: true, categoryId: true },
      }),
    ]);

    return {
      cities: cities.map((city) => ({
        id: city.id,
        slug: city.slug,
        nameFa: city.nameFa,
        districts: city.districts,
      })),
      categories,
      interests,
    };
  }

  /**
   * Checks a city — and optionally a district — against the catalog.
   *
   * A district is rejected unless it is active *and* belongs to the city that was
   * submitted alongside it. Checking only that the district exists would let a
   * client pair Tehran with a district of another city, and every downstream
   * filter would then quietly disagree with itself.
   */
  async resolveLocation(
    cityId: string,
    districtId: string | undefined,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<ResolvedLocation> {
    const city = await tx.city.findUnique({
      where: { id: cityId },
      select: { id: true, isActive: true },
    });
    if (!city || !city.isActive) {
      throw new AppError(ErrorCode.CITY_NOT_AVAILABLE);
    }

    if (districtId === undefined) {
      return { cityId: city.id, districtId: null };
    }

    const district = await tx.district.findUnique({
      where: { id: districtId },
      select: { id: true, cityId: true, isActive: true },
    });
    if (!district || !district.isActive || district.cityId !== city.id) {
      throw new AppError(ErrorCode.INVALID_DISTRICT);
    }

    return { cityId: city.id, districtId: district.id };
  }

  /**
   * Checks that every submitted interest is a real, active catalog row.
   *
   * Counting is not enough — a duplicated id would make three submitted ids match
   * two real ones and still pass a length check. The comparison is therefore over
   * the distinct set, and the ids that failed are returned in the error so the
   * client can highlight them instead of clearing the whole form.
   */
  async assertInterestsSelectable(
    interestIds: string[],
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<string[]> {
    const requested = [...new Set(interestIds)];

    const found = await tx.interest.findMany({
      where: { id: { in: requested }, isActive: true },
      select: { id: true },
    });

    if (found.length !== requested.length) {
      const valid = new Set(found.map((interest) => interest.id));
      throw new AppError(ErrorCode.INVALID_INTEREST, {
        invalidInterestIds: requested.filter((id) => !valid.has(id)),
      });
    }

    return requested;
  }
}
