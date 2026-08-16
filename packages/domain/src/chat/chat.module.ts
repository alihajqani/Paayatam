import { Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { MessageCipher } from './message-cipher';
// AuditModule and OutboxModule are @Global, so they need no import here.

/**
 * The anonymous chat module (plan §3.3).
 *
 * `MessageCipher` is provided here rather than globally on purpose: the only
 * thing in the product that holds `CHAT_ENCRYPTION_KEY` is the module that owns
 * the messages, and a key available everywhere is a key that eventually encrypts
 * something nobody meant to encrypt with it.
 */
@Module({
  providers: [MessageCipher, ChatService],
  exports: [ChatService],
})
export class ChatModule {}
