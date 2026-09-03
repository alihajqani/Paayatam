import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelModule } from '../channel/channel.module';
import { EconomyModule } from '../economy/economy.module';
import { ParticipationService } from './participation.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

// `EconomyModule` for the cancellation penalty (M10), which is charged inside the
// same transaction that records the cancellation.
// `ChannelModule` for the M22 membership gate on `EVENT_JOIN`. Nest scopes
// providers to the module that declares them, so this import is what makes
// `ParticipationService` constructible — `AppModule` importing both is not enough.
@Module({
  imports: [CatalogModule, ChannelModule, EconomyModule],
  providers: [ParticipationService],
  exports: [ParticipationService],
})
export class ParticipationModule {}
