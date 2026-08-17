import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { QueueDepthCollector } from './queue-depth.collector';

/**
 * `MetricsModule` from `@payetam/platform` is `@Global()` and provides the registry
 * itself; this module is the API's *surface* over it — the scrape endpoint and the
 * collectors that need Prisma and BullMQ to answer.
 */
@Module({
  controllers: [MetricsController],
  providers: [QueueDepthCollector],
})
export class ApiMetricsModule {}
