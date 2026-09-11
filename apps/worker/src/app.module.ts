import { Module } from '@nestjs/common';
import { PrismaModule } from '@payetam/db';
import {
  AdminAccessModule,
  AuditModule,
  CatalogModule,
  ChannelModule,
  ConversationModule,
  EconomyModule,
  EventsModule,
  IdentityModule,
  InvitationsModule,
  MessagingModule,
  NotificationsModule,
  OutboxModule,
  ParticipationModule,
  PrivacyModule,
  ReviewsModule,
} from '@payetam/domain';
import {
  ClockModule,
  ConfigModule,
  MetricsModule,
  PiiHashModule,
  QueueModule,
  RedisModule,
} from '@payetam/platform';
import { TelegramLoggerService } from './monitoring/telegram-logger.service';
import { Processors } from './queues/processors.service';
import { WorkerFactory } from './queues/worker.factory';
import { TelegramClient } from './telegram/telegram.client';

/**
 * Worker root module (ADR-0005).
 *
 * It imports the **same domain services the API does**, which is the point of
 * `packages/domain` existing at all: the sweeps this process runs are the same
 * methods M6, M10 and M11 wrote and left unscheduled, not a second implementation
 * of them. A job that promoted a waitlist differently from the request path would
 * be a second source of truth for the product's hardest invariant.
 *
 * Every outbound Telegram call happens here rather than in a request handler, so
 * Telegram's ~30/s shapes queue throughput instead of API latency (invariant 11).
 */
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    PrismaModule,
    RedisModule,
    QueueModule,
    MetricsModule,
    PiiHashModule,
    AuditModule,
    OutboxModule,
    // For `AdminTelegramService.isLinked` alone: whether the bottom keyboard a
    // notification draws carries the moderation button (ADR-0018). The worker
    // draws every keyboard this product sends, so it is the only process that
    // can answer it at the moment it is asked.
    AdminAccessModule,
    CatalogModule,
    ChannelModule,
    ConversationModule,
    EconomyModule,
    EventsModule,
    InvitationsModule,
    MessagingModule,
    ParticipationModule,
    ReviewsModule,
    NotificationsModule,
    IdentityModule,
    PrivacyModule,
  ],
  providers: [WorkerFactory, TelegramClient, TelegramLoggerService, Processors],
})
export class AppModule {}
