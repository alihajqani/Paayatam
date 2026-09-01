import type { DiscoveredEvent } from '@payetam/domain';
import type { DiscoveredEventView } from '@payetam/shared';

/**
 * Maps a discovered event to the wire shape.
 *
 * The narrowest projection in the product, and deliberately so: this is what a
 * stranger sees. `moderationStatus`, `version`, `requestCount` and the
 * normalized text all exist on the row and none of them reach here.
 *
 * The host is a public id and a display name. That is not a Telegram identity —
 * `telegram_user_id`, the cached username and the internal id all live behind
 * the identity module (invariant 7) and cannot be reached from this row.
 */
export function toDiscoveredEventView(event: DiscoveredEvent): DiscoveredEventView {
  return {
    publicId: event.publicId,
    title: event.title,
    description: event.description,
    category: {
      id: event.categoryId,
      slug: event.categorySlug,
      nameFa: event.categoryNameFa,
    },
    customCategoryLabel: event.customCategoryLabel,
    city: { id: event.cityId, slug: event.citySlug, nameFa: event.cityNameFa },
    district:
      event.districtId === null || event.districtSlug === null || event.districtNameFa === null
        ? null
        : { id: event.districtId, slug: event.districtSlug, nameFa: event.districtNameFa },
    districtLabel: event.districtLabel,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    capacity: event.capacity,
    acceptedCount: event.acceptedCount,
    // Computed here rather than left to the client: every surface that shows a
    // listing needs it, and one of them would eventually get the subtraction
    // wrong or forget the floor.
    remainingCapacity: Math.max(event.capacity - event.acceptedCount, 0),
    costType: event.costType,
    costAmount: event.costAmount,
    costNote: event.costNote,
    genderPreference: event.genderPreference,
    minAge: event.minAge,
    maxAge: event.maxAge,
    externalLink: event.externalLink,
    isVip: event.isVip,
    // A boolean, not the timestamp. A client comparing an expiry against its own
    // clock is a client that disagrees with the server about what is boosted.
    isBoosted: event.boostedUntil !== null && event.boostedUntil.getTime() > Date.now(),
    publishedAt: event.publishedAt?.toISOString() ?? null,
    host: {
      publicId: event.hostPublicId,
      displayName: event.hostDisplayName,
      /**
       * The host's reputation, and **null when they have never been judged**
       * (M18). Not folded into a neutral 50 here: the ranking formula does that
       * because it must produce a number, and a screen must not, or somebody who
       * has done nothing at all is shown a score they never earned. The Mini App
       * renders «تازه‌وارد» for null.
       *
       * Visible to any authenticated viewer, which is the same audience that
       * already sees `displayName` — and the score is *already* a public fact
       * about a host in the sense that it moves their position in discovery.
       * Nothing from `trust_score_ledger` is here: how the score got where it is
       * remains the host's own business (`GET /me/trust`).
       */
      trustScore: event.hostTrustScore,
    },
  };
}
