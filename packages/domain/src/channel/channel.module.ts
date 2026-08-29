import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { ChannelConfigService } from './channel-config.service';
import { ChannelMembershipService } from './membership.service';
import { ChannelService } from './channel.service';

/**
 * Channel publishing (plan §3.3).
 *
 * `CatalogModule` for `SettingsService`: whether the channel is on at all, and
 * how many requests make an event "trending", are policy numbers — so turning the
 * channel off in an incident is a config change rather than a deploy.
 *
 * M22 adds the other half: the channel's **public** face (`ChannelConfigService`)
 * and whether users must join it before they can act (`ChannelMembershipService`).
 * The membership probe is an optional injected token, so this module resolves in
 * the worker and in a test with no Telegram anywhere — and fails open when it is
 * absent, which is the same answer it gives when Telegram is down.
 */
@Module({
  imports: [CatalogModule],
  providers: [ChannelService, ChannelConfigService, ChannelMembershipService],
  exports: [ChannelService, ChannelConfigService, ChannelMembershipService],
})
export class ChannelModule {}
