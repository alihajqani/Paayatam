import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelService } from './channel.service';

/**
 * Channel publishing (plan §3.3).
 *
 * `CatalogModule` for `SettingsService`: whether the channel is on at all, and
 * how many requests make an event "trending", are policy numbers — so turning the
 * channel off in an incident is a config change rather than a deploy.
 */
@Module({
  imports: [CatalogModule],
  providers: [ChannelService],
  exports: [ChannelService],
})
export class ChannelModule {}
