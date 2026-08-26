import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EconomyModule } from '../economy/economy.module';
import { InvitationService } from './invitation.service';

/**
 * The paid top-20 invitation (M22 phase 11).
 *
 * Imported by the API, which prices and charges for it, and by the worker, which
 * records what became of each invitation as it is delivered. `AuditModule` is
 * `@Global`, so it needs no import.
 */
@Module({
  imports: [CatalogModule, EconomyModule],
  providers: [InvitationService],
  exports: [InvitationService],
})
export class InvitationsModule {}
