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
 * It is **exported**, and there is exactly one other consumer: M12's break-glass
 * path, which decrypts a conversation for a moderator. That is a deliberate,
 * narrow widening rather than an accident — and the reason the import shows up in
 * `AdminAccessModule` at all is so that "who can decrypt a private message?" is
 * answerable by reading two module files. The path itself is guarded by a
 * permission, an open case, a written reason and a fifteen-minute clock (T14).
 */
@Module({
  providers: [MessageCipher, ChatService],
  exports: [ChatService, MessageCipher],
})
export class ChatModule {}
