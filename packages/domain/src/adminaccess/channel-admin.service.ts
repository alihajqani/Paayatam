import { Injectable } from '@nestjs/common';
import {
  ChannelConfigService,
  type ChannelConfigStatus,
  type GatedAction,
} from '../channel/channel-config.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/**
 * Configuring the event channel, from the panel (M22 phase 6).
 *
 * A thin permission layer over `ChannelConfigService`, exactly as
 * `MessagingAdminService` is over `MessagingService`: the rules about what a valid
 * link is belong to the domain, and who may change it belongs here (ADR-0010
 * rule 2).
 *
 * `channel.manage` is its own key rather than part of `settings.manage`, and the
 * reason is the blast radius: everything behind `settings.manage` retunes a number,
 * and this one switch can lock every user out of the product at once.
 */
@Injectable()
export class ChannelAdminService {
  constructor(
    private readonly access: AdminAccessService,
    private readonly config: ChannelConfigService,
  ) {}

  async get(session: AdminSession): Promise<ChannelConfigStatus> {
    this.access.assertPermission(session, PERMISSIONS.CHANNEL_MANAGE);
    return this.config.status();
  }

  async update(
    session: AdminSession,
    input: {
      chatIdentifier?: string | null | undefined;
      publicUsername?: string | null | undefined;
      inviteUrl?: string | null | undefined;
      membershipRequired?: boolean | undefined;
      requiredActions?: GatedAction[] | undefined;
      verifyViaTelegram?: boolean | undefined;
    },
  ): Promise<ChannelConfigStatus> {
    this.access.assertPermission(session, PERMISSIONS.CHANNEL_MANAGE);
    // The audit row is written by the domain service, which is the only code that
    // has seen both sides of the change inside one call.
    return this.config.update(session.adminUserId, input);
  }
}
