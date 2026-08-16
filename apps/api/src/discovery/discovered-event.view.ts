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
    city: { id: event.cityId, slug: event.citySlug, nameFa: event.cityNameFa },
    district:
      event.districtId === null || event.districtSlug === null || event.districtNameFa === null
        ? null
        : { id: event.districtId, slug: event.districtSlug, nameFa: event.districtNameFa },
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
    host: { publicId: event.hostPublicId, displayName: event.hostDisplayName },
  };
}
