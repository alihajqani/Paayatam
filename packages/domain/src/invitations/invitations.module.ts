import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelModule } from '../channel/channel.module';
import { EconomyModule } from '../economy/economy.module';
import { InvitationService } from './invitation.service';

/**
 * The paid top-20 invitation (M22 phase 11).
 *
 * Imported by the API, which prices and charges for it, and by the worker, which
 * records what became of each invitation as it is delivered. `AuditModule` is
 * `@Global`, so it needs no import.
 *
 * `ChannelModule` for `ChannelMembershipService`: inviting is a gated action
 * (`EVENT_INVITE`), and the gate is asserted in the service that owns the act
 * rather than in a controller, so it holds for every caller. Nest scopes
 * providers to the module that declares them, so importing it here is what makes
 * `InvitationService` constructible at all — `AppModule` importing both is not
 * enough, and the failure is at boot rather than at the first invitation.
 */
@Module({
  imports: [CatalogModule, ChannelModule, EconomyModule],
  providers: [InvitationService],
  exports: [InvitationService],
})
export class InvitationsModule {}
