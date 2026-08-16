import type { ChatStatus } from '@payetam/db';
import { assertTransition, type TransitionTable } from '../state-machine';

/**
 * The chat lifecycle, exactly as plan §7 draws it.
 *
 * ```
 *  ANONYMOUS ─► OPEN ─► CLOSED        (OPEN when the host accepts)
 *      └──────────────► CLOSED        (reject / cancel / either party closes)
 *  any ─► BLOCKED                     (moderation)
 * ```
 *
 * A chat starts at ANONYMOUS the moment somebody *asks* to join, not when they
 * are accepted (plan §2.5). Two strangers talking before either has committed to
 * anything is the product's differentiator, and it is why there is no state
 * before ANONYMOUS to transition out of.
 *
 * CLOSED and BLOCKED are both terminal and both start the 90-day retention clock
 * (ADR-0009). They are kept distinct because the reason matters to moderation: a
 * conversation that ended is not a conversation that was stopped.
 *
 * There is deliberately no edge back from CLOSED. A host who rejects somebody and
 * changes their mind does not reopen the old conversation — the participant asks
 * again, which creates a new request and with it a new chat and a new alias. A
 * reopened chat would be a conversation whose alias outlived the reason it was
 * assigned.
 */
export const CHAT_TRANSITIONS: TransitionTable<ChatStatus> = {
  ANONYMOUS: ['OPEN', 'CLOSED', 'BLOCKED'],
  OPEN: ['CLOSED', 'BLOCKED'],
  CLOSED: [],
  BLOCKED: [],
};

export function assertChatTransition(from: ChatStatus, to: ChatStatus, chatId?: string): void {
  assertTransition(CHAT_TRANSITIONS, from, to, {
    entity: 'anonymous_chat',
    ...(chatId !== undefined ? { id: chatId } : {}),
  });
}

/**
 * Can anything still be said in this chat?
 *
 * Both live states accept messages, which is the point of creating the chat at
 * request time: an ANONYMOUS chat is a conversation between people who have not
 * agreed to meet yet.
 */
export const LIVE_CHAT_STATUSES: readonly ChatStatus[] = ['ANONYMOUS', 'OPEN'];

export function isLiveChat(status: ChatStatus): boolean {
  return LIVE_CHAT_STATUSES.includes(status);
}
