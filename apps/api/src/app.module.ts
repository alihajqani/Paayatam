import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '@payetam/db';
import {
  AuditModule,
  CatalogModule,
  EconomyModule,
  IdentityModule,
  ProfileModule,
} from '@payetam/domain';
import { ClockModule, ConfigModule, RedisModule } from '@payetam/platform';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { CatalogController } from './catalog/catalog.controller';
import { HealthModule } from './health/health.module';
import { OnboardingController } from './onboarding/onboarding.controller';
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
    IdentityModule,
    CatalogModule,
    EconomyModule,
    ProfileModule,
    HealthModule,
  ],
  controllers: [AuthController, OnboardingController, CatalogController, TelegramWebhookController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
