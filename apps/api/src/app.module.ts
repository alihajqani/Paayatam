import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '@payetam/db';
import {
  AuditModule,
  CatalogModule,
  ChatModule,
  DiscoveryModule,
  EconomyModule,
  EventsModule,
  IdentityModule,
  ModerationModule,
  OutboxModule,
  ParticipationModule,
  ProfileModule,
} from '@payetam/domain';
import { ClockModule, ConfigModule, RedisModule } from '@payetam/platform';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { AppExceptionFilter } from './common/app-exception.filter';
import { CatalogController } from './catalog/catalog.controller';
import { ChatController } from './chat/chat.controller';
import { EconomyController } from './economy/economy.controller';
import { DiscoveryController } from './discovery/discovery.controller';
import { EventsController } from './events/events.controller';
import { HealthModule } from './health/health.module';
import { OnboardingController } from './onboarding/onboarding.controller';
import { ParticipationController } from './participation/participation.controller';
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
    EconomyModule,
    ProfileModule,
    ModerationModule,
    EventsModule,
    DiscoveryModule,
    ParticipationModule,
    ChatModule,
    HealthModule,
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
    TelegramWebhookController,
  ],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
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
