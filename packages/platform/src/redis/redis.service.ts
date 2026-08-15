import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import type { Env } from '@payetam/config';
import { ENV } from '../config/env.provider';

/**
 * Redis client for cache, sessions, rate limiting and (from M13) BullMQ.
 *
 * Redis is never a source of truth (ADR-0002). Losing it degrades performance and
 * pauses job delivery but loses no data — the transactional outbox lives in
 * Postgres (ADR-0005). That is why `maxRetriesPerRequest: null` is acceptable: we
 * would rather a command wait for a reconnect than fail a request outright.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(@Inject(ENV) env: Env) {
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      // Without a cap, a long outage produces an ever-growing reconnect delay.
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });

    this.client.on('error', (error: Error) => {
      // Warn, not error: transient reconnects are expected, and an error-level log
      // here would train the team to ignore the channel.
      this.logger.warn(`Redis connection issue: ${error.message}`);
    });
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch (error) {
      this.logger.error(
        `Redis ping failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // `quit` drains in-flight commands; `disconnect` would drop them.
    await this.client.quit();
    this.logger.log('Redis connection closed');
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
