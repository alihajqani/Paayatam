import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ModerationModule } from '../moderation/moderation.module';
import { EventService } from './event.service';

@Module({
  imports: [CatalogModule, ModerationModule],
  providers: [EventService],
  exports: [EventService],
})
export class EventsModule {}
