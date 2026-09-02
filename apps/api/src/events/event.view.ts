import type { EventDetail } from '@payetam/domain';
import type { EventView } from '@payetam/shared';

/**
 * Maps a domain event to the wire shape.
 *
 * An explicit mapper, per plan §3.6 layer 2. The event row carries
 * `host_user_id`, `title_normalized` and the internal `id`; a spread would put
 * all three on the wire, and the internal id is the one that turns a random
 * `public_id` into a guessable sequence (T3.3).
 *
 * Timestamps go out as ISO-8601 UTC. The Mini App renders Jalali (ADR-0008).
 */
export function toEventView(event: EventDetail): EventView {
  return {
    publicId: event.publicId,
    title: event.title,
    description: event.description,
    category: event.category,
    customCategoryLabel: event.customCategoryLabel,
    city: event.city,
    district: event.district,
    districtLabel: event.districtLabel,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    capacity: event.capacity,
    acceptedCount: event.acceptedCount,
    costType: event.costType,
    costAmount: event.costAmount,
    costNote: event.costNote,
    rules: event.rules,
    genderPreference: event.genderPreference,
    minAge: event.minAge,
    maxAge: event.maxAge,
    externalLink: event.externalLink,
    status: event.status,
    moderationStatus: event.moderationStatus,
    publishedAt: event.publishedAt?.toISOString() ?? null,
    channelStatus: event.channelStatus,
    version: event.version,
    createdAt: event.createdAt.toISOString(),
  };
}
