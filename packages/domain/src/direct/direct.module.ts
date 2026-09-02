import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { DirectMessageService } from './direct-message.service';

/**
 * Direct messages about an activity (v0.7.0).
 *
 * `ChatModule` is imported for `MessageCipher` alone — the same reason
 * `AdminAccessModule` imports it. The bodies here are encrypted under the same
 * key with the same discipline, and a second cipher would be a second place to
 * get AES-GCM's nonce rule wrong.
 *
 * `AuditModule` and `OutboxModule` are `@Global`, so they need no import.
 */
@Module({
  imports: [ChatModule],
  providers: [DirectMessageService],
  exports: [DirectMessageService],
})
export class DirectModule {}
