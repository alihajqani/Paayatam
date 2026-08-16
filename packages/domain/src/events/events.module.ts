import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EconomyModule } from '../economy/economy.module';
import { ModerationModule } from '../moderation/moderation.module';
import { EventService } from './event.service';

// `EconomyModule` for the two coin sinks (M9): boost and VIP placement.
@Module({
  imports: [CatalogModule, EconomyModule, ModerationModule],
  providers: [EventService],
  exports: [EventService],
})
export class EventsModule {}
