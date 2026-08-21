import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChatModule } from '../chat/chat.module';
import { EconomyModule } from '../economy/economy.module';
import { AdminAccessService } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { AdminOperationsService } from './admin-operations.service';
import { ChatUnsealService } from './chat-unseal.service';
import { GiftCodeAdminService } from './gift-code-admin.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

/**
 * Staff identity, authorisation and the admin operations they authorise
 * (ADR-0010).
 *
 * `ChatModule` is imported for `MessageCipher` alone, and the fact that it has to
 * be imported at all is the point: the key that decrypts private conversations
 * lives in one module, and the only other place in the product that reaches for it
 * is the break-glass path — which is guarded by a permission, a case, a reason and
 * a fifteen-minute clock.
 */
@Module({
  imports: [CatalogModule, ChatModule, EconomyModule],
  providers: [
    AdminCredentials,
    AdminAccessService,
    ChatUnsealService,
    AdminOperationsService,
    GiftCodeAdminService,
  ],
  exports: [
    AdminCredentials,
    AdminAccessService,
    ChatUnsealService,
    AdminOperationsService,
    GiftCodeAdminService,
  ],
})
export class AdminAccessModule {}
