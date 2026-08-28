import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { MessageCipher } from './message-cipher';
// AuditModule and OutboxModule are @Global, so they need no import here.

/**
 * The anonymous chat module (plan §3.3).
 *
 * `MessageCipher` is provided here rather than globally on purpose: a key
 * available everywhere is a key that eventually encrypts something nobody meant
 * to encrypt with it.
 *
 * It is **exported**, and there are exactly two other consumers. Each is a
 * deliberate, narrow widening rather than an accident, and they are listed here
 * so that "who can decrypt with this key?" stays answerable by reading module
 * files rather than by grepping:
 *
 * 1. **M12's break-glass path**, which decrypts a conversation for a moderator.
 *    Guarded by a permission, an open case, a written reason and a
 *    fifteen-minute clock (T14) — which is why the import shows up in
 *    `AdminAccessModule`.
 * 2. **`ConversationModule`** (ADR-0017), which encrypts half-filled bot forms
 *    with the same key and the same three columns. It decrypts only the draft
 *    belonging to the user whose update is being handled, and never a
 *    `chat_message`.
 *
 * A third consumer should be argued for in an ADR, not added to this list.
 */
@Module({
  providers: [MessageCipher, ChatService],
  exports: [ChatService, MessageCipher],
})
export class ChatModule {}
