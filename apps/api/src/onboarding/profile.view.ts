import type { ProfileDetail } from '@payetam/domain';
import type { ProfileView } from '@payetam/shared';

/**
 * Maps the domain profile to the wire shape.
 *
 * An explicit mapper rather than a spread, per plan §3.6 layer 2: a spread turns
 * "someone added a column" into "the API started returning it", which is exactly
 * how a Telegram identifier eventually reaches a client. Every field a response
 * carries is named here on purpose.
 *
 * Dates go out as ISO-8601 UTC. Jalali rendering is the Mini App's job
 * (ADR-0008) — the API never speaks it.
 */
export function toProfileView(profile: ProfileDetail): ProfileView {
  return {
    displayName: profile.displayName,
    gender: profile.gender,
    birthYear: profile.birthYear,
    city: profile.city,
    district: profile.district,
    bio: profile.bio,
    interests: profile.interests,
    inviteOptOut: profile.inviteOptOut,
    completedAt: profile.completedAt?.toISOString() ?? null,
  };
}
