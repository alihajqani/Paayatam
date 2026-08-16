import { Controller, Get, Param, Query } from '@nestjs/common';
import { DiscoveryService, UserService, type DiscoveryQuery } from '@payetam/domain';
import {
  discoveryQuery,
  type DiscoveredEventView,
  type DiscoveryQueryRequest,
  type DiscoveryResponse,
  type RankExplanationResponse,
} from '@payetam/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.guard';
import { toDiscoveredEventView } from './discovered-event.view';

@Controller('api/v1')
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly users: UserService,
  ) {}

  /**
   * Browse and search published events.
   *
   * Keyset-paginated: the response carries an opaque `nextCursor`, and passing
   * it back returns the next page with no duplicates and no gaps even while
   * other people are creating events mid-scan.
   *
   * The filters that depend on *who is asking* — `ageFits`, interest-match — are
   * resolved from the server's copy of the profile, never from the query string.
   */
  @Get('events')
  async list(
    @Query(new ZodValidationPipe(discoveryQuery)) query: DiscoveryQueryRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<DiscoveryResponse> {
    const viewerId = await this.users.resolveInternalId(current.publicId);
    const page = await this.discovery.search(viewerId, toDiscoveryQuery(query));

    return {
      events: page.events.map(toDiscoveredEventView),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  }

  /**
   * One published event.
   *
   * A `PENDING_MODERATION`, `HIDDEN` or `REJECTED` event is a 404 here even to
   * someone holding its id — the host sees those through `GET /me/events`, which
   * is scoped to them. Same-shaped 404 for "not published" and "does not exist",
   * so the endpoint is not an existence oracle (T3.3).
   */
  @Get('events/:publicId')
  async detail(@Param('publicId') publicId: string): Promise<DiscoveredEventView> {
    const event = await this.discovery.findPublished(publicId);
    return toDiscoveredEventView(event);
  }

  /**
   * Why this event ranks where it does, for this viewer.
   *
   * Plan §6 lists it alongside discovery, and §12 is the reason it exists: trust
   * feeding into ranking is only defensible if the weighting is inspectable
   * rather than asserted.
   */
  @Get('events/:publicId/explain-rank')
  async explainRank(
    @Param('publicId') publicId: string,
    @Query(new ZodValidationPipe(discoveryQuery)) query: DiscoveryQueryRequest,
    @CurrentUser() current: AuthenticatedUser,
  ): Promise<RankExplanationResponse> {
    const viewerId = await this.users.resolveInternalId(current.publicId);
    return this.discovery.explainRank(viewerId, publicId, toDiscoveryQuery(query));
  }
}

/**
 * Query string → domain query.
 *
 * Dates arrive as ISO strings and the domain works in `Date`; everything else
 * passes through. Absent stays absent rather than becoming `undefined`, because
 * `exactOptionalPropertyTypes` distinguishes the two.
 */
function toDiscoveryQuery(query: DiscoveryQueryRequest): DiscoveryQuery {
  return {
    ...(query.q !== undefined ? { q: query.q } : {}),
    ...(query.cityId !== undefined ? { cityId: query.cityId } : {}),
    ...(query.districtId !== undefined ? { districtId: query.districtId } : {}),
    ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
    ...(query.dateFrom !== undefined ? { dateFrom: new Date(query.dateFrom) } : {}),
    ...(query.dateTo !== undefined ? { dateTo: new Date(query.dateTo) } : {}),
    ...(query.timeOfDay !== undefined ? { timeOfDay: query.timeOfDay } : {}),
    ...(query.hasCapacity !== undefined ? { hasCapacity: query.hasCapacity } : {}),
    ...(query.costType !== undefined ? { costType: query.costType } : {}),
    ...(query.costMax !== undefined ? { costMax: query.costMax } : {}),
    ...(query.genderPreference !== undefined ? { genderPreference: query.genderPreference } : {}),
    ...(query.ageFits !== undefined ? { ageFits: query.ageFits } : {}),
    ...(query.sort !== undefined ? { sort: query.sort } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
  };
}
