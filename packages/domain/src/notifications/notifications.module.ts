import { Module } from '@nestjs/common';
import { OutboxRelayService } from '../outbox/relay.service';
import { NotificationService } from './notification.service';

/**
 * Notifications and the outbox relay (plan §3.3, ADR-0005).
 *
 * The relay lives here rather than in `outbox` because what it does is fan out
 * *notifications* — `OutboxService` owns writing the row, which is a different
 * concern with a different consumer set. M14's channel publisher will read the
 * same rows without going through this module.
 */
@Module({
  providers: [NotificationService, OutboxRelayService],
  exports: [NotificationService, OutboxRelayService],
})
export class NotificationsModule {}
