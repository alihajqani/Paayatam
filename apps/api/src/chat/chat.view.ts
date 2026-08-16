import type { ChatMessageDetail, ChatPage, ChatSummary } from '@payetam/domain';
import type { ChatMessagesResponse, ChatMessageView, ChatSummaryView } from '@payetam/shared';

/**
 * Maps a chat to the wire shape.
 *
 * Field by field, never a spread — and here that rule is load-bearing rather than
 * stylistic. `chat_participant` carries a `user_id`; `chat_message` carries the
 * sender's participant id and the sender's own Telegram message id. Spreading
 * either one would put an identifier into the hands of the one person in the
 * world this feature exists to keep it from: the stranger on the other side of
 * the conversation (§3.6 layer 2).
 *
 * The CI response-leak scan (§3.6 layer 5) reads what these functions produce.
 * That is the regression net; these are the design.
 */
export function toChatSummaryView(chat: ChatSummary): ChatSummaryView {
  return {
    publicId: chat.publicId,
    eventPublicId: chat.eventPublicId,
    eventTitle: chat.eventTitle,
    status: chat.status,
    role: chat.role,
    alias: chat.alias,
    counterpartAlias: chat.counterpartAlias,
    contactShared: chat.contactShared,
    counterpartContactShared: chat.counterpartContactShared,
    lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
    unreadCount: chat.unreadCount,
    createdAt: chat.createdAt.toISOString(),
  };
}

export function toChatMessageView(message: ChatMessageDetail): ChatMessageView {
  return {
    seq: message.seq,
    kind: message.kind,
    senderAlias: message.senderAlias,
    mine: message.mine,
    text: message.text,
    redactionKinds: message.redactionKinds,
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
  };
}

export function toChatMessagesResponse(page: ChatPage): ChatMessagesResponse {
  return {
    chat: toChatSummaryView(page.chat),
    messages: page.messages.map(toChatMessageView),
    nextBeforeSeq: page.nextBeforeSeq,
  };
}
