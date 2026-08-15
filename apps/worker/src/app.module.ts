import { Module } from '@nestjs/common';
import { PrismaModule } from '@payetam/db';
import { ConfigModule, RedisModule } from '@payetam/platform';

/**
 * Worker root module.
 *
 * Imports the same infrastructure as the API and, from M13, the same domain
 * services. Every outbound Telegram call happens in this process rather than in a
 * request handler, so Telegram's rate limits shape queue throughput instead of API
 * latency (ADR-0005).
 *
 * Queues and processors arrive with their milestones:
 *   - `domain-events` / outbox relay  → M13
 *   - `telegram-send`                 → M13
 *   - `scheduled` repeatable jobs     → M13
 *   - `moderation` re-scan            → M12
 */
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule],
})
export class AppModule {}
