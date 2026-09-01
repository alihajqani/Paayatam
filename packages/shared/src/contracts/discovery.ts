import { z } from 'zod';
import { costType, genderPreference } from './events';

/**
 * Discovery contracts (M5).
 *
 * These come off a query string, so every field arrives as text and is coerced
 * here. `z.coerce.boolean()` is deliberately *not* used: it treats `"false"` as
 * true, which for `hasCapacity=false` would silently mean the opposite of what
 * was asked.
 */

export const timeOfDay = z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT']);
export type TimeOfDay = z.infer<typeof timeOfDay>;

export const discoverySort = z.enum(['RELEVANCE', 'SOONEST', 'NEWEST']);
export type DiscoverySort = z.infer<typeof discoverySort>;

const queryFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const discoveryQuery = z.object({
  /** Free text. Normalized server-side through the ADR-0012 pipeline. */
  q: z.string().trim().min(1).max(120).optional(),
  cityId: z.uuid().optional(),
  districtId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  dateFrom: z.iso.datetime().optional(),
  dateTo: z.iso.datetime().optional(),
  timeOfDay: timeOfDay.optional(),
  hasCapacity: queryFlag.optional(),
  costType: costType.optional(),
  costMax: z.coerce.number().int().min(0).max(100_000_000).optional(),
  genderPreference: genderPreference.optional(),
  /**
   * "Only events I fit." A flag, never an age — the server uses its own copy of
   * the viewer's birth year, so a client cannot claim to be older than it is
   * to reach an age-restricted event.
   */
  ageFits: queryFlag.optional(),
  sort: discoverySort.optional(),
  /** Plan §6 caps a page at 50. Anything larger is clamped server-side. */
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(500).optional(),
});
export type DiscoveryQueryRequest = z.infer<typeof discoveryQuery>;

const namedRef = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameFa: z.string(),
});

/**
 * A discovered event, as a stranger sees it.
 *
 * Narrower than the host's own `eventView`: no `moderationStatus`, no `version`,
 * no `rules` until someone joins. The host appears as a public id and a display
 * name — never a Telegram identifier, which is what the CI leak scan asserts
 * across this and every other endpoint (§3.6 layer 5, T2.4).
 */
export const discoveredEventView = z.object({
  publicId: z.uuid(),
  title: z.string(),
  description: z.string(),
  category: namedRef,
  /** The host's own words, when the category invites them («سایر»). Null otherwise. */
  customCategoryLabel: z.string().nullable(),
  city: namedRef,
  district: namedRef.nullable(),
  /** The neighbourhood the host typed, when no catalogue district was chosen. */
  districtLabel: z.string().nullable(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  capacity: z.number().int(),
  acceptedCount: z.number().int(),
  /** Precomputed so a client never has to subtract and get it wrong. */
  remainingCapacity: z.number().int(),
  costType,
  costAmount: z.number().int().nullable(),
  costNote: z.string().nullable(),
  genderPreference: genderPreference.nullable(),
  minAge: z.number().int().nullable(),
  maxAge: z.number().int().nullable(),
  externalLink: z.string().nullable(),
  isVip: z.boolean(),
  /** Whether a boost is live *now*, rather than the raw timestamp. */
  isBoosted: z.boolean(),
  publishedAt: z.iso.datetime().nullable(),
  host: z.object({
    publicId: z.uuid(),
    displayName: z.string(),
    /**
     * The host's Trust Score, 0–100, or **null when they have never been judged**
     * (M18).
     *
     * Nullable rather than defaulted, and the difference matters: `trust_score` is
     * written lazily by the first movement, so a brand-new host genuinely has no
     * row, and 0 would be the worst possible reputation shown to somebody who has
     * done nothing wrong. Ranking resolves the same absence to
     * `trust.initial_score` because it has to produce a number; a screen does not,
     * and says «تازه‌وارد» instead.
     */
    trustScore: z.number().int().min(0).max(100).nullable(),
  }),
});
export type DiscoveredEventView = z.infer<typeof discoveredEventView>;

export const discoveryResponse = z.object({
  events: z.array(discoveredEventView),
  /** Absent on the last page. Opaque — clients pass it back, never parse it. */
  nextCursor: z.string().optional(),
});
export type DiscoveryResponse = z.infer<typeof discoveryResponse>;

export const rankExplanationResponse = z.object({
  score: z.number(),
  components: z.object({
    timeProximity: z.number(),
    popularity: z.number(),
    recency: z.number(),
    boost: z.number(),
    trust: z.number(),
    interestMatch: z.number(),
    textRelevance: z.number().nullable(),
  }),
  weights: z.object({
    timeProximity: z.number(),
    popularity: z.number(),
    recency: z.number(),
    boost: z.number(),
    trust: z.number(),
    interestMatch: z.number(),
  }),
});
export type RankExplanationResponse = z.infer<typeof rankExplanationResponse>;
