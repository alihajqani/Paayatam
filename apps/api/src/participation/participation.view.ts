import type { MyParticipation, ParticipantSummary, ParticipationDetail } from '@payetam/domain';
import type {
  MyParticipationView,
  ParticipantSummaryView,
  ParticipationView,
} from '@payetam/shared';

/**
 * Maps participation to the wire shape.
 *
 * Field by field, never a spread. `event_participant` carries the internal event
 * and user ids, the version token, and the penalty ledger row — none of which
 * belong in a response, and all of which a spread would hand over the moment
 * somebody added a column (§3.6 layer 2).
 */
export function toParticipationView(participation: ParticipationDetail): ParticipationView {
  return {
    publicId: participation.publicId,
    eventPublicId: participation.eventPublicId,
    status: participation.status,
    requestedAt: participation.requestedAt.toISOString(),
    hostDeadlineAt: participation.hostDeadlineAt?.toISOString() ?? null,
    graceExpiresAt: participation.graceExpiresAt?.toISOString() ?? null,
    acceptedAt: participation.acceptedAt?.toISOString() ?? null,
    cancelledAt: participation.cancelledAt?.toISOString() ?? null,
    cancellationBucket: participation.cancellationBucket,
    waitlistRank: participation.waitlistRank,
    chatPublicId: participation.chatPublicId,
  };
}

/**
 * The requester's own list entry: the same fields, plus the event they name.
 *
 * Field by field like its base, and for the same reason — `event` is narrowed to
 * three columns here rather than passed through, so adding a column to `event`
 * cannot widen this response.
 */
export function toMyParticipationView(participation: MyParticipation): MyParticipationView {
  return {
    ...toParticipationView(participation),
    event: {
      publicId: participation.event.publicId,
      title: participation.event.title,
      startsAt: participation.event.startsAt.toISOString(),
    },
  };
}

/**
 * The host's view of a request.
 *
 * A public id, a display name and a Trust Score. Hosting an event does not
 * entitle someone to a stranger's profile because that stranger asked to come —
 * and it certainly does not entitle them to anything from `telegram_account`,
 * which this row cannot reach.
 *
 * The score is here because the host has a **decision** to make, and "has this
 * person behaved" is the legitimate question at exactly that moment (M18). What
 * does not come with it is the ledger behind it: the number, never the specific
 * incidents that produced it.
 */
export function toParticipantSummaryView(summary: ParticipantSummary): ParticipantSummaryView {
  return {
    publicId: summary.publicId,
    userPublicId: summary.userPublicId,
    displayName: summary.displayName,
    trustScore: summary.trustScore,
    status: summary.status,
    requestedAt: summary.requestedAt.toISOString(),
    hostDeadlineAt: summary.hostDeadlineAt?.toISOString() ?? null,
    waitlistRank: summary.waitlistRank,
  };
}
