import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChatModule } from '../chat/chat.module';
import { EconomyModule } from '../economy/economy.module';
import { ParticipationService } from './participation.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

// Participation depends on chat and never the other way round: a request drives
// its conversation's lifecycle, and the conversation knows nothing about seats.
// `EconomyModule` for the cancellation penalty (M10), which is charged inside the
// same transaction that records the cancellation.
@Module({
  imports: [CatalogModule, ChatModule, EconomyModule],
  providers: [ParticipationService],
  exports: [ParticipationService],
})
export class ParticipationModule {}
