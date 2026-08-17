import { Module } from '@nestjs/common';
import { PrismaModule } from '@payetam/db';
import {
  AuditModule,
  CatalogModule,
  ChannelModule,
  ChatModule,
  EconomyModule,
  EventsModule,
  NotificationsModule,
  OutboxModule,
  ParticipationModule,
  PrivacyModule,
  ReviewsModule,
} from '@payetam/domain';
import {
  ClockModule,
  ConfigModule,
  PiiHashModule,
  QueueModule,
  RedisModule,
} from '@payetam/platform';
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
    PiiHashModule,
    AuditModule,
    OutboxModule,
    CatalogModule,
    ChannelModule,
    ChatModule,
    EconomyModule,
    EventsModule,
    ParticipationModule,
    ReviewsModule,
    NotificationsModule,
    PrivacyModule,
  ],
  providers: [WorkerFactory, TelegramClient, Processors],
})
export class AppModule {}
