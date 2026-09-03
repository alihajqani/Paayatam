import { Module } from '@nestjs/common';
import { CryptoModule } from '../crypto/crypto.module';
import { ConversationService } from './conversation.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

/**
 * The conversation store (ADR-0017).
 *
 * `ChatModule` is imported for `MessageCipher` and for nothing else. It is
 * provided there rather than globally on purpose — a key that every module can
 * reach is a key every module can leak — and a draft is encrypted with the same
 * key and the same three columns as a chat message, so there is one story about
 * encrypted columns rather than two that drift.
 *
 * **Importing this module is not optional for anything that injects
 * `ConversationService`.** Nest scopes providers to the declaring module, so a
 * service wired into a module that does not import this one resolves to
 * `undefined` at boot — the failure that would have stopped both processes in
 * M22, now pinned by `apps/{api,worker}/src/app.module.test.ts`.
 */
@Module({
  imports: [CryptoModule],
  providers: [ConversationService],
  exports: [ConversationService],
})
export class ConversationModule {}
