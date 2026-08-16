import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChatModule } from '../chat/chat.module';
import { EconomyModule } from '../economy/economy.module';
import { ModerationModule } from '../moderation/moderation.module';
import { EventService } from './event.service';
import { EventLifecycleService } from './lifecycle.service';

// `EconomyModule` for the two coin sinks (M9) and the cancellation penalty (M10).
// `ChatModule` because a host cancelling an event has to close every conversation
// it opened — the note M8 left for M10. Events depend on chat and never the other
// way round, exactly as participation does.
@Module({
  imports: [CatalogModule, ChatModule, EconomyModule, ModerationModule],
  providers: [EventService, EventLifecycleService],
  exports: [EventService, EventLifecycleService],
})
export class EventsModule {}
