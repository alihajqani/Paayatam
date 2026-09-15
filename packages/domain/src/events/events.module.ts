import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelModule } from '../channel/channel.module';
import { EconomyModule } from '../economy/economy.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ReviewsModule } from '../reviews/reviews.module';
import { EventService } from './event.service';
import { HostRewardService } from './host-reward.service';
import { EventLifecycleService } from './lifecycle.service';
import { NoShowClaimService } from './no-show-claim.service';

// `EconomyModule` for the two coin sinks (M9) and the cancellation penalty (M10).
// `ReviewsModule` because attendance settlement is what opens a review window
// (M11).
// `HostRewardService` sits here rather than in `EconomyModule` for the reason
// `EventLifecycleService` does: it is a sweep over events that happens to move
// coins, and putting it the other way round would point `EconomyModule` at
// `EventService` — the wrong direction for a package whose whole job is to be
// depended upon.
// `ChannelModule` for the M22 membership gate on `EVENT_CREATE`. Nest scopes
// providers to the module that declares them, so this import is what makes
// `EventService` constructible — `AppModule` importing both is not enough.
// `NoShowClaimService` (plan 08) for the same reason as `HostRewardService`: it
// is about evenings and moves coins. It checks `report.review` on the session it
// is handed rather than importing the admin module.
@Module({
  imports: [CatalogModule, ChannelModule, EconomyModule, ModerationModule, ReviewsModule],
  providers: [EventService, EventLifecycleService, HostRewardService, NoShowClaimService],
  exports: [EventService, EventLifecycleService, HostRewardService, NoShowClaimService],
})
export class EventsModule {}
