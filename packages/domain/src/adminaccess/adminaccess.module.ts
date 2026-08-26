import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChatModule } from '../chat/chat.module';
import { EconomyModule } from '../economy/economy.module';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { AdminAccessService } from './admin-access.service';
import { AdminCredentials } from './admin-credentials';
import { AdminInsightService } from './admin-insight.service';
import { AdminOperationsService } from './admin-operations.service';
import { CatalogAdminService } from './catalog-admin.service';
import { ChatUnsealService } from './chat-unseal.service';
import { GeographyAdminService } from './geography-admin.service';
import { GiftCodeAdminService } from './gift-code-admin.service';
import { PolicyAdminService } from './policy-admin.service';
import { ReferralAdminService } from './referral-admin.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

/**
 * Staff identity, authorisation and the admin operations they authorise
 * (ADR-0010).
 *
 * `ProfileModule` is imported so that an admin editing somebody's profile goes
 * through **the same** `ProfileService.update` a user does (M22 phase 2). A second
 * implementation for staff would be a second set of validation rules, and the one
 * that drifts is always the one fewer people read.
 *
 * `ChatModule` is imported for `MessageCipher` alone, and the fact that it has to
 * be imported at all is the point: the key that decrypts private conversations
 * lives in one module, and the only other place in the product that reaches for it
 * is the break-glass path — which is guarded by a permission, a case, a reason and
 * a fifteen-minute clock.
 */
@Module({
  imports: [CatalogModule, ChatModule, EconomyModule, IdentityModule, ProfileModule],
  providers: [
    AdminCredentials,
    AdminAccessService,
    ChatUnsealService,
    AdminOperationsService,
    AdminInsightService,
    GiftCodeAdminService,
    ReferralAdminService,
    CatalogAdminService,
    GeographyAdminService,
    PolicyAdminService,
  ],
  exports: [
    AdminCredentials,
    AdminAccessService,
    ChatUnsealService,
    AdminOperationsService,
    AdminInsightService,
    GiftCodeAdminService,
    ReferralAdminService,
    CatalogAdminService,
    GeographyAdminService,
    PolicyAdminService,
  ],
})
export class AdminAccessModule {}
