import { z } from 'zod';

/**
 * Anonymous chat contracts (M8).
 *
 * Read the *absences* here first, because they are the design. There is no
 * sender id, no user public id and no avatar anywhere in this file, and a
 * **message** is attributed to an alias and nothing else. The wire shape is where
 * layer 2 of §3.6 becomes checkable: a field that does not exist in the schema
 * cannot be filled in by a mapper somebody writes in a hurry.
 *
 * `counterpartName` on the chat summary is the one deliberate exception, added in
 * M18 and reasoned about in ADR-0014. It names the person a conversation is
 * *with* — which both sides already learn from the participant list and the event
 * page — so that a conversation can be titled by who and what it is about. It
 * does not appear on `chatMessageView`, and nothing here can reach
 * `telegram_account`.
 *
 * `seq` is the message identifier. It is chat-scoped and ordinal, so it tells a
 * caller nothing they do not already have by being in the chat — which is exactly
 * what an identifier in a private conversation should tell them.
 */

export const chatStatus = z.enum(['ANONYMOUS', 'OPEN', 'CLOSED', 'BLOCKED']);
export type ChatStatus = z.infer<typeof chatStatus>;

export const chatRole = z.enum(['HOST', 'GUEST']);
export type ChatRole = z.infer<typeof chatRole>;

export const chatMessageKind = z.enum(['TEXT', 'SYSTEM']);
export type ChatMessageKind = z.infer<typeof chatMessageKind>;

export const redactionKind = z.enum(['PHONE', 'USERNAME', 'TELEGRAM_LINK', 'EMAIL', 'ENTITY']);
export type RedactionKind = z.infer<typeof redactionKind>;

/**
 * Sending a message.
 *
 * Text only in MVP (ADR-0009). The cap is generous but finite: Telegram's own
 * limit is 4096 characters, and a relay that accepts more than it can deliver
 * fails at the last step, after the message is already stored.
 */
export const sendChatMessageRequest = z.object({
  text: z.string().trim().min(1).max(4000),
});
export type SendChatMessageRequest = z.infer<typeof sendChatMessageRequest>;

export const closeChatRequest = z.object({
  reason: z.string().trim().min(1).max(280).optional(),
});
export type CloseChatRequest = z.infer<typeof closeChatRequest>;

export const chatMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** Keyset backwards through the conversation: everything older than this seq. */
  beforeSeq: z.coerce.number().int().positive().optional(),
});
export type ChatMessagesQuery = z.infer<typeof chatMessagesQuery>;

export const chatMessageView = z.object({
  seq: z.number().int().positive(),
  kind: chatMessageKind,
  /** Null for a system message. Never a name, never an id. */
  senderAlias: z.string().nullable(),
  mine: z.boolean(),
  text: z.string(),
  /** Which masking rules fired — so a sender can see their number was removed. */
  redactionKinds: z.array(redactionKind),
  editedAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ChatMessageView = z.infer<typeof chatMessageView>;

export const chatSummaryView = z.object({
  publicId: z.string(),
  eventPublicId: z.string(),
  eventTitle: z.string(),
  status: chatStatus,
  role: chatRole,
  /** What the other side sees you called. */
  alias: z.string(),
  /** What you see them called. */
  counterpartAlias: z.string(),
  /**
   * The other person's profile display name, falling back to their alias (M18,
   * ADR-0014).
   *
   * Rendered with `eventTitle` by every surface that titles a conversation —
   * «علی رضایی — سفر شمال» — so a host with four running events can tell which
   * conversation is which, which «میهمان ۱» alone never told them.
   *
   * It is an addition to the absences this file opens with rather than a
   * contradiction of them: there is still no sender id, no user public id and no
   * avatar here, and nothing that can reach `telegram_account`. ADR-0014 records
   * why a display name is not the thing ADR-0009 was protecting — the host
   * already reads it in the participant list, and the guest already reads the
   * host's on the event page.
   */
  counterpartName: z.string(),
  contactShared: z.boolean(),
  counterpartContactShared: z.boolean(),
  lastMessageAt: z.iso.datetime().nullable(),
  unreadCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export type ChatSummaryView = z.infer<typeof chatSummaryView>;

export const myChatsResponse = z.object({ chats: z.array(chatSummaryView) });
export type MyChatsResponse = z.infer<typeof myChatsResponse>;

export const chatMessagesResponse = z.object({
  chat: chatSummaryView,
  /** Oldest first, so a client appends rather than reverses. */
  messages: z.array(chatMessageView),
  /** Pass as `beforeSeq` for the older page; null at the start of the chat. */
  nextBeforeSeq: z.number().int().positive().nullable(),
});
export type ChatMessagesResponse = z.infer<typeof chatMessagesResponse>;
