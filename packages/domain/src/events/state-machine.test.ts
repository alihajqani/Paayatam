import { describe, expect, it } from 'vitest';
import type { EventStatus } from '@payetam/db';
import { canTransition, terminalStates } from '../state-machine';
import { ACTIVE_EVENT_STATUSES, EVENT_TRANSITIONS, assertEventTransition } from './state-machine';

describe('the event transition table', () => {
  it.each([
    ['DRAFT', 'PENDING_MODERATION'],
    ['PENDING_MODERATION', 'PUBLISHED'],
    ['PENDING_MODERATION', 'REJECTED'],
    ['PUBLISHED', 'PENDING_MODERATION'],
    ['PUBLISHED', 'HIDDEN'],
    ['PUBLISHED', 'CANCELLED_BY_HOST'],
    ['PUBLISHED', 'ONGOING'],
    ['PUBLISHED', 'EXPIRED'],
    ['HIDDEN', 'PUBLISHED'],
    ['ONGOING', 'COMPLETED'],
  ] satisfies [EventStatus, EventStatus][])('allows %s → %s', (from, to) => {
    expect(canTransition(EVENT_TRANSITIONS, from, to)).toBe(true);
  });

  // The tuple is stated explicitly rather than inferred: `it.each` infers its
  // case type from the callback's parameters, and this callback ignores the third
  // element — it is there to name the case in the title, not to be asserted on.
  it.each<[EventStatus, EventStatus, string]>([
    ['DRAFT', 'PUBLISHED', 'publishing without being moderated'],
    ['REJECTED', 'PUBLISHED', 'un-rejecting without a moderator re-hiding it first'],
    ['COMPLETED', 'PUBLISHED', 'reviving a finished event'],
    ['CANCELLED_BY_HOST', 'PUBLISHED', 'un-cancelling'],
    ['EXPIRED', 'ONGOING', 'starting an expired event'],
    ['PUBLISHED', 'COMPLETED', 'completing without running'],
  ])('refuses %s → %s (%s)', (from, to) => {
    expect(canTransition(EVENT_TRANSITIONS, from, to)).toBe(false);
  });

  it('lets every state be soft-deleted', () => {
    for (const [state, targets] of Object.entries(EVENT_TRANSITIONS)) {
      if (state === 'DELETED') continue;
      expect(targets, `${state} must allow DELETED`).toContain('DELETED');
    }
  });

  it('has DELETED as its only terminal state', () => {
    // Everything else can still be soft-deleted, so nothing is stuck.
    expect(terminalStates(EVENT_TRANSITIONS)).toEqual(['DELETED']);
  });
});

describe('assertEventTransition', () => {
  it('is a 409, not a 500 — a stale caller is a conflict, not a bug', () => {
    try {
      assertEventTransition('COMPLETED', 'PUBLISHED', 'evt-1');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_STATE_TRANSITION',
        httpStatus: 409,
        details: { entity: 'event', id: 'evt-1', from: 'COMPLETED', to: 'PUBLISHED' },
      });
    }
  });

  it('passes a legal transition silently', () => {
    expect(() => {
      assertEventTransition('PENDING_MODERATION', 'PUBLISHED');
    }).not.toThrow();
  });
});

describe('ACTIVE_EVENT_STATUSES', () => {
  it('counts what occupies a host slot, and nothing that does not', () => {
    // A REJECTED or CANCELLED event costs the host nothing and must not use up
    // one of their three concurrent slots.
    expect(ACTIVE_EVENT_STATUSES).toEqual(['DRAFT', 'PENDING_MODERATION', 'PUBLISHED', 'ONGOING']);
    expect(ACTIVE_EVENT_STATUSES).not.toContain('REJECTED');
    expect(ACTIVE_EVENT_STATUSES).not.toContain('CANCELLED_BY_HOST');
  });

  it('names only states the table knows about', () => {
    for (const status of ACTIVE_EVENT_STATUSES) {
      expect(EVENT_TRANSITIONS).toHaveProperty(status);
    }
  });
});
