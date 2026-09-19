import type { Prisma } from '@payetam/db';

/**
 * What a city's floor counts: every event a visitor could still join or at least
 * see coming — published, not deleted, not yet started — **whoever hosts it**.
 *
 * This one definition is shared by the scheduler (which tops the city up to the
 * floor) and the admin screen (which shows the number the floor is compared
 * with), so the two cannot drift.
 *
 * The bug this replaced counted only seed events that were still *filling*
 * (`accepted_count < capacity`). A seed event fills within minutes, so it left
 * that set almost at once and the next pass — five minutes later — saw a deficit
 * again and made more, without end; real events were never counted at all. Full
 * events count here on purpose: an event that is full and still ahead of us is
 * exactly what the floor is meant to keep on display.
 */
export function upcomingEventsWhere(now: Date, cityId?: string): Prisma.EventWhereInput {
  return {
    ...(cityId !== undefined ? { cityId } : {}),
    status: 'PUBLISHED',
    deletedAt: null,
    startsAt: { gt: now },
  };
}
