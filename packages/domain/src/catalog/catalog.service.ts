import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Prisma } from '@payetam/db';
import { ENV } from '@payetam/platform';
import type { Env } from '@payetam/config';
import { AppError, ErrorCode } from '@payetam/shared';
import { SettingsService } from './settings.service';

export interface NamedRef {
  id: string;
  slug: string;
  nameFa: string;
}

/** What promoting an event currently costs, straight from `app_setting`. */
export interface PromotionPricingSnapshot {
  boostCoins: number;
  boostDurationHours: number;
  vipCoins: number;
  /** The M22 sinks (phase 5). Zero means free. */
  eventCreateCoins: number;
  /** The channel placement a registration includes, charged with the create. */
  eventChannelPublishCoins: number;
  /** `eventCreateCoins + eventChannelPublishCoins` — the only one a host is quoted. */
  eventRegisterCoins: number;
  /** Renewing that placement afterwards, which a host may do repeatedly. */
  eventChannelSendCoins: number;
  eventTopInviteCoins: number;
  topInviteMaxRecipients: number;
}

export interface CatalogSnapshot {
  provinces: NamedRef[];
  cities: (NamedRef & { provinceId: string | null; districts: NamedRef[] })[];
  categories: (NamedRef & {
    icon: string | null;
    allowsCustomLabel: boolean;
    /** The cities it is offered in, or `null` for everywhere. */
    cityIds: string[] | null;
  })[];
  interests: (NamedRef & { categoryId: string | null })[];
  promotion: PromotionPricingSnapshot;
  /**
   * The bot's @username, so the Mini App can send somebody into the conversation.
   *
   * Public by definition — it is already in every deep link the bot and the
   * channel emit — and not a token: `TELEGRAM_BOT_TOKEN` is a different
   * environment variable and nothing here reads it.
   *
   * Carried on the catalog rather than fetched separately for the reason
   * everything else here is: it is small, it changes at deploy time and not
   * otherwise, and the alternative is another round trip on a connection where
   * round trips are the expensive part (ADR-0003). Empty string when the
   * deployment has not configured one, which the client treats as "no link".
   */
  botUsername: string;
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    /** For `TELEGRAM_BOT_USERNAME` alone — never the token. */
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Everything selectable, in one read.
   *
   * The onboarding wizard needs all three lists to render one form, and they are
   * small and change rarely — so three endpoints would cost three round trips
   * over a mobile connection for no benefit.
   */
  async snapshot(): Promise<CatalogSnapshot> {
    const [provinces, cities, categories, interests, promotion] = await Promise.all([
      this.prisma.province.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        select: { id: true, slug: true, nameFa: true },
      }),
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
        select: {
          id: true,
          slug: true,
          nameFa: true,
          icon: true,
          allowsCustomLabel: true,
          // Almost always empty — `city_category` holds restrictions, and an
          // unrestricted category has no rows (migration 0020). So this include
          // costs one indexed read that returns nothing for every category
          // nobody has narrowed.
          cities: { select: { cityId: true } },
        },
      }),
      this.prisma.interest.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { nameFa: 'asc' }],
        select: { id: true, slug: true, nameFa: true, categoryId: true },
      }),
      /**
       * The same three settings `EventService.boost` charges against.
       *
       * Read through `SettingsService` rather than duplicated as constants, so the
       * price a host is shown and the price they are charged cannot disagree — and
       * so an admin changing `economy.boost_coins` changes both at once. The
       * service falls back to the documented default when a row is missing, which
       * is why this cannot render a blank price.
       */
      this.promotionPricing(),
    ]);

    return {
      provinces,
      cities: cities.map((city) => ({
        id: city.id,
        slug: city.slug,
        nameFa: city.nameFa,
        provinceId: city.provinceId,
        districts: city.districts,
      })),
      categories: categories.map(({ cities: restrictions, ...category }) => ({
        ...category,
        // No rows means unrestricted, which the wire spells `null` — see the
        // note on `categoryView.cityIds` for why not `[]`.
        cityIds: restrictions.length === 0 ? null : restrictions.map((row) => row.cityId),
      })),
      interests,
      promotion,
      botUsername: this.env.TELEGRAM_BOT_USERNAME ?? '',
    };
  }

  /**
   * Public because the price is not a secret — it is what the buyer is agreeing to.
   *
   * One `getNumbers` rather than seven `getInt`s: this is on the cold-open path
   * for every session, and seven round trips to `app_setting` to render one form
   * is six more than the data needs.
   */
  async promotionPricing(): Promise<PromotionPricingSnapshot> {
    const values = await this.settings.getNumbers([
      'economy.boost_coins',
      'economy.boost_duration_hours',
      'economy.vip_coins',
      'economy.event_create_coins',
      'economy.event_channel_publish_coins',
      'economy.event_channel_send_coins',
      'economy.event_top_invite_coins',
      'events.top_invite_max_recipients',
    ]);

    return {
      boostCoins: values['economy.boost_coins'],
      boostDurationHours: values['economy.boost_duration_hours'],
      vipCoins: values['economy.vip_coins'],
      eventCreateCoins: values['economy.event_create_coins'],
      eventChannelPublishCoins: values['economy.event_channel_publish_coins'],
      // What registering actually costs, summed here rather than in each of the
      // four surfaces that show it — the split is an implementation detail and a
      // client that adds it up itself is a client that can disagree.
      eventRegisterCoins:
        values['economy.event_create_coins'] + values['economy.event_channel_publish_coins'],
      eventChannelSendCoins: values['economy.event_channel_send_coins'],
      eventTopInviteCoins: values['economy.event_top_invite_coins'],
      topInviteMaxRecipients: values['events.top_invite_max_recipients'],
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
