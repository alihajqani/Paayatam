import type { EventStatus } from '@payetam/db';
import { assertTransition, type TransitionTable } from '../state-machine';

/**
 * The event lifecycle, exactly as plan §7 draws it.
 *
 * ```
 *  DRAFT ─► PENDING_MODERATION ─► PUBLISHED ─┬─► HIDDEN ─► PUBLISHED | REJECTED
 *               └─► REJECTED                 ├─► CANCELLED_BY_HOST
 *                                            ├─► ONGOING ─► COMPLETED
 *                                            └─► EXPIRED     (start passed, 0 accepted)
 *  any ─► DELETED (soft)
 * ```
 *
 * `PUBLISHED → PENDING_MODERATION` is here and not in the diagram: a sensitive
 * edit sends a live event back through moderation. With auto-moderation that
 * round trip usually completes inside the same transaction, but it is a real
 * transition and it is audited as one, so a moderator reading the trail sees
 * that the text was re-judged rather than silently changed underneath them.
 */
export const EVENT_TRANSITIONS: TransitionTable<EventStatus> = {
  DRAFT: ['PENDING_MODERATION', 'DELETED'],
  PENDING_MODERATION: ['PUBLISHED', 'REJECTED', 'DELETED'],
  PUBLISHED: ['PENDING_MODERATION', 'HIDDEN', 'CANCELLED_BY_HOST', 'ONGOING', 'EXPIRED', 'DELETED'],
  HIDDEN: ['PUBLISHED', 'REJECTED', 'DELETED'],
  REJECTED: ['DELETED'],
  CANCELLED_BY_HOST: ['DELETED'],
  ONGOING: ['COMPLETED', 'DELETED'],
  COMPLETED: ['DELETED'],
  EXPIRED: ['DELETED'],
  DELETED: [],
};

export function assertEventTransition(from: EventStatus, to: EventStatus, eventId?: string): void {
  assertTransition(EVENT_TRANSITIONS, from, to, {
    entity: 'event',
    ...(eventId !== undefined ? { id: eventId } : {}),
  });
}

/**
 * Statuses that occupy one of a host's concurrent-event slots.
 *
 * Not "everything non-terminal": a REJECTED event is non-terminal in the table
 * (it can still be deleted) but costs the host nothing. What counts is an event
 * that is live, about to be live, or being reviewed.
 */
export const ACTIVE_EVENT_STATUSES: readonly EventStatus[] = [
  'DRAFT',
  'PENDING_MODERATION',
  'PUBLISHED',
  'ONGOING',
];
