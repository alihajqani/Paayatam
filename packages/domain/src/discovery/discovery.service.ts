import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { Env } from '@payetam/config';
import { CLOCK, ENV, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { SettingsService } from '../catalog/settings.service';
import { normalize } from '../moderation/persian-normalizer';
import { ageFromBirthYear } from '../profile/age';
import { decodeCursor, encodeCursor, type DiscoverySort } from './cursor';
import {
  SEARCH_PROVIDER,
  type DiscoveredEvent,
  type DiscoveryFilters,
  type RankExplanation,
  type RankingWeights,
  type SearchProvider,
  type TimeOfDay,
} from './search-provider';

/** The filters as they arrive from a client, before the server resolves them. */
export interface DiscoveryQuery {
  q?: string;
  cityId?: string;
  districtId?: string;
  categoryId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  timeOfDay?: TimeOfDay;
  hasCapacity?: boolean;
  costType?: DiscoveryFilters['costType'];
  costMax?: number;
  genderPreference?: DiscoveryFilters['genderPreference'];
  /** "Only events my age fits." The age itself comes from the server's copy. */
  ageFits?: boolean;
  sort?: DiscoverySort;
  limit?: number;
  cursor?: string;
  /**
   * Skip this many rows instead of resuming from a cursor (v0.6.5).
   *
   * For the bot, whose page buttons are `callback_data` and cannot carry an
   * encoded cursor in sixty-four bytes. Ignored when `cursor` is given: a caller
   * that has a cursor has the better mechanism and should use it.
   *
   * The trade is stated rather than hidden. An offset page re-fixes the relevance
   * epoch, so an event published between one page and the next can shift a row
   * across the boundary — a duplicate or a gap of one. For a five-row list of
   * activities in a city that is a cosmetic imperfection; for the Mini App's
   * infinite scroll it would not be, which is why that still uses the cursor.
   */
  offset?: number;
}

export interface DiscoveryPage {
  events: DiscoveredEvent[];
  /** Absent when this was the last page. */
  nextCursor?: string;
}

/** Plan §6 caps a page at 50; a request for more is clamped, not rejected. */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const WEIGHT_KEYS = [
  'ranking.weight_time_proximity',
  'ranking.weight_popularity',
  'ranking.weight_recency',
  'ranking.weight_trust',
  'ranking.weight_interest_match',
  // Not a weight, but read with them: the score an unrated host ranks as.
  'trust.initial_score',
] as const;

/**
 * Discovery: what a given viewer may see, in what order.
 *
 * Everything viewer-specific is resolved here from the server's own copy of the
 * profile — the age used by `ageFits`, the interests behind the interest-match
 * term. None of it is accepted from the client, which is what stops a caller
 * claiming to be 19 to reach an event with `min_age = 19`, and keeps invariant 9
 * true for the one filter that looks like a policy decision.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
    @Inject(SEARCH_PROVIDER) private readonly provider: SearchProvider,
    private readonly settings: SettingsService,
  ) {}

  async search(viewerUserId: string, query: DiscoveryQuery): Promise<DiscoveryPage> {
    const sort = query.sort ?? 'RELEVANCE';
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, sort);
    // The first page fixes the clock; every later page reuses it, so relevance
    // cannot drift between pages and produce a duplicate or a gap.
    const epoch = cursor ? new Date(cursor.epoch) : this.clock.now();

    const [viewer, weights] = await Promise.all([
      this.viewerContext(viewerUserId, epoch),
      this.weights(),
    ]);

    if (query.ageFits === true && viewer.age === null) {
      // Filtering by a fit we cannot compute would silently return everything,
      // which is the opposite of what was asked for.
      throw new AppError(ErrorCode.PROFILE_INCOMPLETE);
    }

    const events = await this.provider.search({
      filters: this.toFilters(query, viewer.age),
      sort,
      // One extra row, so "is there a next page?" is answered without a count.
      limit: limit + 1,
      epoch,
      ...(cursor ? { after: { key: cursor.key, publicId: cursor.publicId } } : {}),
      // Only when there is no cursor — the two are alternatives, not a pair.
      ...(cursor === undefined && query.offset !== undefined && query.offset > 0
        ? { offset: query.offset }
        : {}),
      viewerCategoryIds: viewer.categoryIds,
      weights,
    });

    const page = events.slice(0, limit);
    const hasMore = events.length > limit;
    const last = page.at(-1);

    return {
      events: page,
      ...(hasMore && last
        ? {
            nextCursor: encodeCursor({
              sort,
              epoch: epoch.getTime(),
              key: last.sortKey,
              publicId: last.publicId,
            }),
          }
        : {}),
    };
  }

  async findPublished(publicId: string): Promise<DiscoveredEvent> {
    const event = await this.provider.findPublished(publicId);
    if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    return event;
  }

  /**
   * The same activity, named by the short code a `/event_…` command carries.
   *
   * `EVENT_NOT_FOUND` for a code that matches nothing and for one that names an
   * unpublished activity, identically — the same non-oracle `findPublished`
   * holds, and a shorter name must not be a weaker one.
   */
  async findPublishedByPrefix(prefix: string): Promise<DiscoveredEvent> {
    const event = await this.provider.findPublishedByPrefix(prefix);
    if (!event) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    return event;
  }

  /**
   * Why this event ranks where it does, for this viewer.
   *
   * Exists because a ranking nobody can inspect is one nobody can debug or
   * challenge — the same argument ADR-0007 makes for rendering the trust ledger
   * rather than the number.
   */
  async explainRank(
    viewerUserId: string,
    publicId: string,
    query: DiscoveryQuery = {},
  ): Promise<RankExplanation> {
    const epoch = this.clock.now();
    const [viewer, weights] = await Promise.all([
      this.viewerContext(viewerUserId, epoch),
      this.weights(),
    ]);

    const explanation = await this.provider.explain(publicId, {
      filters: this.toFilters(query, viewer.age),
      sort: query.sort ?? 'RELEVANCE',
      epoch,
      viewerCategoryIds: viewer.categoryIds,
      weights,
    });

    if (!explanation) throw new AppError(ErrorCode.EVENT_NOT_FOUND);
    return explanation;
  }

  private toFilters(query: DiscoveryQuery, viewerAge: number | null): DiscoveryFilters {
    return {
      // Normalized with the *same* function the indexed text went through
      // (ADR-0012). A query typed with an Arabic yeh has to land on the same
      // tokens as a title typed with a Persian one.
      ...(query.q !== undefined && normalize(query.q).length > 0
        ? { query: normalize(query.q) }
        : {}),
      ...(query.cityId !== undefined ? { cityId: query.cityId } : {}),
      ...(query.districtId !== undefined ? { districtId: query.districtId } : {}),
      ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
      ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
      ...(query.timeOfDay !== undefined ? { timeOfDay: query.timeOfDay } : {}),
      ...(query.hasCapacity !== undefined ? { hasCapacity: query.hasCapacity } : {}),
      ...(query.costType !== undefined ? { costType: query.costType } : {}),
      ...(query.costMax !== undefined ? { costMax: query.costMax } : {}),
      ...(query.genderPreference !== undefined ? { genderPreference: query.genderPreference } : {}),
      ...(query.ageFits === true && viewerAge !== null ? { ageFits: viewerAge } : {}),
    };
  }

  /**
   * The viewer's age and interest categories, read from the server's copy.
   *
   * One query. A viewer with no profile yet is not an error here — discovery is
   * browsable before onboarding finishes; they simply score zero on
   * interest-match and cannot use `ageFits`.
   */
  private async viewerContext(
    viewerUserId: string,
    at: Date,
  ): Promise<{ age: number | null; categoryIds: string[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: viewerUserId },
      select: {
        profile: { select: { birthYear: true } },
        interests: { select: { interest: { select: { categoryId: true } } } },
      },
    });

    const birthYear = user?.profile?.birthYear ?? null;
    const categoryIds = [
      ...new Set(
        (user?.interests ?? [])
          .map((row) => row.interest.categoryId)
          .filter((id): id is string => id !== null),
      ),
    ];

    return {
      age: birthYear === null ? null : ageFromBirthYear(birthYear, at, this.env.APP_TIMEZONE),
      categoryIds,
    };
  }

  private async weights(): Promise<RankingWeights> {
    const values = await this.settings.getNumbers(WEIGHT_KEYS);
    return {
      timeProximity: values['ranking.weight_time_proximity'],
      popularity: values['ranking.weight_popularity'],
      recency: values['ranking.weight_recency'],
      trust: values['ranking.weight_trust'],
      interestMatch: values['ranking.weight_interest_match'],
      neutralTrust: values['trust.initial_score'],
    };
  }
}
