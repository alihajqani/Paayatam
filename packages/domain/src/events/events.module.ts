import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelModule } from '../channel/channel.module';
import { EconomyModule } from '../economy/economy.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { EventService } from './event.service';
import { EventLifecycleService } from './lifecycle.service';

// `EconomyModule` for the two coin sinks (M9) and the cancellation penalty (M10).
// `ReviewsModule` because attendance settlement is what opens a review window
// (M11).
// `ChannelModule` for the M22 membership gate on `EVENT_CREATE`. Nest scopes
// providers to the module that declares them, so this import is what makes
// `EventService` constructible — `AppModule` importing both is not enough.
@Module({
  imports: [CatalogModule, ChannelModule, EconomyModule, ModerationModule, ReviewsModule],
  providers: [EventService, EventLifecycleService],
  exports: [EventService, EventLifecycleService],
})
export class EventsModule {}
