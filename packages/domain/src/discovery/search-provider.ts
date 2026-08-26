import type { CostType, GenderPreference } from '@payetam/db';
import type { DiscoverySort } from './cursor';

/**
 * The search seam (ADR-0012).
 *
 * The ADR keeps a Meilisearch swap cheap by putting an interface here rather
 * than calling Postgres directly from the service. What that buys concretely:
 * `DiscoveryService` decides *what* a viewer may see and how their eligibility
 * is computed, and knows nothing about tsvectors, trigrams or keyset SQL. A
 * second provider has to satisfy this contract and nothing else.
 */

export type TimeOfDay = 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT';

export interface DiscoveryFilters {
  /** Free text, already normalized by the caller through the ADR-0012 pipeline. */
  query?: string;
  cityId?: string;
  districtId?: string;
  categoryId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  timeOfDay?: TimeOfDay;
  /** Only events with a seat left. */
  hasCapacity?: boolean;
  costType?: CostType;
  /** Maximum Toman. FREE events always satisfy it. */
  costMax?: number;
  genderPreference?: GenderPreference;
  /** The viewer's age, when they asked to see only events they fit. */
  ageFits?: number;
}

export interface SearchRequest {
  filters: DiscoveryFilters;
  sort: DiscoverySort;
  limit: number;
  /** Frozen at the first page so relevance does not drift between pages. */
  epoch: Date;
  after?: { key: number | string; publicId: string };
  /**
   * Categories the viewer has declared an interest in, for the interest-match
   * term. Empty for a viewer with no interests, which scores zero rather than
   * excluding anything.
   */
  viewerCategoryIds: string[];
  weights: RankingWeights;
}

export interface RankingWeights {
  timeProximity: number;
  popularity: number;
  recency: number;
  boost: number;
  trust: number;
  interestMatch: number;
  /**
   * The score a host with no trust row ranks as — the "neutral bucket" plan §11
   * requires so a new host is never buried for having done nothing yet.
   *
   * Carried alongside the weights rather than hardcoded in the SQL because it is
   * the same `trust.initial_score` the ledger seeds with, and two copies of that
   * number would eventually disagree: a host would rank as though they had 50
   * while their profile showed something else.
   */
  neutralTrust: number;
}

/** The row shape discovery returns. Deliberately narrower than the host's view. */
export interface DiscoveredEvent {
  publicId: string;
  title: string;
  description: string;
  categoryId: string;
  categorySlug: string;
  categoryNameFa: string;
  /** The host's own words, when the category invites them («سایر», M21). */
  customCategoryLabel: string | null;
  cityId: string;
  citySlug: string;
  cityNameFa: string;
  districtId: string | null;
  districtSlug: string | null;
  districtNameFa: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  acceptedCount: number;
  costType: CostType;
  costAmount: number | null;
  costNote: string | null;
  genderPreference: GenderPreference | null;
  minAge: number | null;
  maxAge: number | null;
  externalLink: string | null;
  isVip: boolean;
  boostedUntil: Date | null;
  publishedAt: Date | null;
  hostPublicId: string;
  hostDisplayName: string;
  /**
   * The host's Trust Score, 0–100, or null when they have never been judged (M18).
   *
   * **Null is not zero and the distinction is the whole point.** `trust_score` is
   * written lazily by the first movement, so a host who has just completed a
   * profile may legitimately have no row — and rendering that as 0 would show the
   * worst possible reputation to somebody who has done nothing wrong. The ranking
   * formula resolves the same absence to `trust.initial_score` for exactly this
   * reason (see `trustSql`); the *display* declines to invent a number at all and
   * lets the client say «تازه‌وارد» instead.
   */
  hostTrustScore: number | null;
  /** The value the cursor keys on for this sort. */
  sortKey: number | string;
}

/** The component breakdown behind one event's score, for `explain-rank`. */
export interface RankExplanation {
  score: number;
  components: {
    timeProximity: number;
    popularity: number;
    recency: number;
    boost: number;
    trust: number;
    interestMatch: number;
    textRelevance: number | null;
  };
  weights: RankingWeights;
}

export interface SearchProvider {
  search(request: SearchRequest): Promise<DiscoveredEvent[]>;
  findPublished(publicId: string): Promise<DiscoveredEvent | null>;
  explain(
    publicId: string,
    request: Omit<SearchRequest, 'limit' | 'after'>,
  ): Promise<RankExplanation | null>;
}

export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');
