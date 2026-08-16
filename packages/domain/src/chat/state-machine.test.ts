import { describe, expect, it } from 'vitest';
import type { ChatStatus } from '@payetam/db';
import { isAppError } from '@payetam/shared';
import { terminalStates } from '../state-machine';
import { CHAT_TRANSITIONS, assertChatTransition, isLiveChat } from './state-machine';

describe('the chat lifecycle', () => {
  it.each<[ChatStatus, ChatStatus]>([
    ['ANONYMOUS', 'OPEN'],
    ['ANONYMOUS', 'CLOSED'],
    ['ANONYMOUS', 'BLOCKED'],
    ['OPEN', 'CLOSED'],
    ['OPEN', 'BLOCKED'],
  ])('allows %s → %s', (from, to) => {
    expect(() => {
      assertChatTransition(from, to);
    }).not.toThrow();
  });

  it.each<[ChatStatus, ChatStatus]>([
    // A conversation does not come back. The participant asks again, which
    // creates a new request, a new chat and a new alias.
    ['CLOSED', 'OPEN'],
    ['CLOSED', 'ANONYMOUS'],
    ['BLOCKED', 'OPEN'],
    // Opening is what acceptance does. Nothing un-accepts.
    ['OPEN', 'ANONYMOUS'],
  ])('refuses %s → %s', (from, to) => {
    expect(() => {
      assertChatTransition(from, to);
    }).toThrow();
  });

  it('reports an illegal transition as a conflict, not a crash', () => {
    try {
      assertChatTransition('CLOSED', 'OPEN', 'chat-1');
      expect.unreachable('the transition should have been refused');
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      if (!isAppError(error)) return;
      expect(error.code).toBe('INVALID_STATE_TRANSITION');
      expect(error.httpStatus).toBe(409);
      expect(error.details).toMatchObject({ entity: 'anonymous_chat', id: 'chat-1' });
    }
  });

  /**
   * Both terminal states start the 90-day retention clock (ADR-0009). A third
   * terminal state added without that behaviour would be a conversation nothing
   * ever purges, which is why this is asserted as an exact set rather than a
   * membership check.
   */
  it('has exactly two terminal states', () => {
    expect(terminalStates(CHAT_TRANSITIONS).sort()).toEqual(['BLOCKED', 'CLOSED']);
  });
});

describe('which chats accept messages', () => {
  /**
   * ANONYMOUS accepting messages is the product (plan §2.5): strangers talk
   * *before* identity is exchanged. A chat that only worked after acceptance
   * would be an ordinary group DM with extra steps.
   */
  it.each<[ChatStatus, boolean]>([
    ['ANONYMOUS', true],
    ['OPEN', true],
    ['CLOSED', false],
    ['BLOCKED', false],
  ])('%s → %s', (status, live) => {
    expect(isLiveChat(status)).toBe(live);
  });
});
