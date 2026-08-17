import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '@payetam/db';
import {
  AuditModule,
  CatalogModule,
  ChatModule,
  DiscoveryModule,
  AdminAccessModule,
  EconomyModule,
  EventsModule,
  ReviewsModule,
  IdentityModule,
  ModerationModule,
  NotificationsModule,
  OutboxModule,
  ParticipationModule,
  PrivacyModule,
  ProfileModule,
} from '@payetam/domain';
import {
  ClockModule,
  ConfigModule,
  MetricsModule,
  PiiHashModule,
  QueueModule,
  RateLimitModule,
  RedisModule,
} from '@payetam/platform';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { AppExceptionFilter } from './common/app-exception.filter';
import { CatalogController } from './catalog/catalog.controller';
import { ChatController } from './chat/chat.controller';
import { EconomyController } from './economy/economy.controller';
import { DiscoveryController } from './discovery/discovery.controller';
import { EventsController } from './events/events.controller';
import { HealthModule } from './health/health.module';
import { ApiMetricsModule } from './metrics/metrics.module';
import { ReviewsController } from './reviews/reviews.controller';
import { AdminController } from './admin/admin.controller';
import { AdminAuthGuard } from './admin/admin.guard';
import { RateLimitGuard } from './common/rate-limit.guard';
import { ReportsController } from './moderation/reports.controller';
import { OnboardingController } from './onboarding/onboarding.controller';
import { ParticipationController } from './participation/participation.controller';
import { BotService } from './telegram/bot.service';
import { TelegramWebhookController } from './telegram/webhook.controller';

/**
 * Root module.
 *
 * `AuthGuard` is registered globally via APP_GUARD, so authentication and the terms
 * gate are deny-by-default: a new endpoint is protected unless it opts out with
 * `@Public()`. The alternative — remembering to add a guard per controller — fails
 * silently and only in the direction that exposes things.
 */
@Module({
  imports: [
    ConfigModule,
    ClockModule,
    PrismaModule,
    RedisModule,
    AuditModule,
    OutboxModule,
    IdentityModule,
    CatalogModule,
    AdminAccessModule,
    EconomyModule,
    ReviewsModule,
    ProfileModule,
    ModerationModule,
    EventsModule,
    DiscoveryModule,
    ParticipationModule,
    ChatModule,
    // For `NotificationService` alone, and for one consumer: the bot's replies are
    // notification rows so they are deduped, rendered and rate-limited like every
    // other message. The relay it also provides is the worker's and is not driven
    // from here — the API enqueues and never processes (ADR-0005).
    NotificationsModule,
    PrivacyModule,
    HealthModule,
    // The registry itself is @Global(); this is the API's scrape endpoint and the
    // collectors that need Prisma and BullMQ to answer (M16).
    MetricsModule,
    PiiHashModule,
    // The rate limiter is consumed by an APP_GUARD, so it has to resolve in the
    // root injector (T12).
    RateLimitModule,
    // The API enqueues and never processes (ADR-0005). Imported here so the
    // queue-depth collector can ask Redis how deep each queue is.
    QueueModule,
    ApiMetricsModule,
  ],
  controllers: [
    AuthController,
    OnboardingController,
    CatalogController,
    EventsController,
    DiscoveryController,
    ParticipationController,
    ChatController,
    EconomyController,
    ReviewsController,
    ReportsController,
    AdminController,
    TelegramWebhookController,
  ],
  providers: [
    AuthService,
    // The bot's inbound handler. A provider rather than a module of its own: it is
    // an adapter over services every one of these modules already exports, and a
    // module wrapping one class would be indirection with nothing inside it.
    BotService,
    AdminAuthGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
    // Ordered after authentication, so the bucket is keyed on the user when there
    // is one and on the IP only when there is not (T12).
    { provide: APP_GUARD, useClass: RateLimitGuard },
    /**
     * `Idempotency-Key` (§6, criterion 21), global and opt-in.
     *
     * Global because §6 says *mutating endpoints accept* the header rather than
     * naming a list — a per-controller decorator would be a list, and the endpoint
     * somebody forgets to add it to is the one that spends coins. It does nothing at
     * all unless a request carries the header, so nothing that worked before this
     * behaves differently.
     *
     * After the guards, so `request.user` is populated: a key is scoped to a caller.
     */
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // Registered here rather than in `bootstrap()`, alongside the guard it
    // belongs with. Turning a domain `AppError` into its documented status and
    // Persian message is part of what this application *is*, not a step one
    // entry point happens to perform — and while it lived in main.ts, anything
    // that composed AppModule without going through bootstrap (the response-leak
    // scan) silently got Nest's generic 500 in place of the error catalogue.
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class AppModule {}
