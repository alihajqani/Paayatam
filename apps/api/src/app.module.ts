import { Module } from '@nestjs/common';
import { PrismaModule } from '@payetam/db';
import { ConfigModule, RedisModule } from '@payetam/platform';
import { HealthModule } from './health/health.module';

/**
 * Root module.
 *
 * Domain modules (identity, events, participation, chat, economy, ...) are added
 * from M2 onward. They live in `packages/domain` and are imported here as thin
 * adapters, so the same services back both this app and the worker (ADR-0001).
 */
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, HealthModule],
})
export class AppModule {}
