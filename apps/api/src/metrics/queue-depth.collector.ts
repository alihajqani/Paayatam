import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { METRICS, MetricsRegistry, QUEUES, QueueService, type Labels } from '@payetam/platform';

/**
 * Queue depth and outbox backlog, read at scrape time (plan §9 M16).
 *
 * Both are **questions for another system**, not numbers this process accumulates —
 * a counter the API incremented on every enqueue would drift the instant the worker
 * consumed anything, and the drift would be invisible. So they are gauges with
 * collectors, and the registry asks them when Prometheus asks it.
 *
 * The outbox backlog is not in the plan's list and is arguably the most important
 * number here. Queue depth going up means the worker is behind; **outbox backlog
 * going up means the relay has stopped**, and those have different fixes. ADR-0005
 * makes the outbox the thing that guarantees a notification is eventually delivered,
 * which means an outbox that stops draining is a promise quietly breaking, with the
 * queue looking perfectly healthy because nothing is being enqueued at all.
 */
@Injectable()
export class QueueDepthCollector implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsRegistry,
    private readonly queues: QueueService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.metrics.registerCollector(METRICS.QUEUE_DEPTH, 'Jobs in each queue by state', () =>
      this.collectQueueDepth(),
    );

    this.metrics.registerCollector(METRICS.OUTBOX_BACKLOG, 'Outbox rows not yet processed', () =>
      this.collectOutboxBacklog(),
    );
  }

  /**
   * Waiting, active, delayed and failed, per queue.
   *
   * All four, because they mean different things: `waiting` is throughput debt,
   * `delayed` is retries in flight, and `failed` is work that has given up. A single
   * "depth" number would report a queue with a thousand dead jobs as healthy the
   * moment nothing new arrived.
   */
  private async collectQueueDepth(): Promise<Array<[Labels, number]>> {
    const rows: Array<[Labels, number]> = [];

    for (const name of Object.values(QUEUES)) {
      const counts = await this.queues
        .queue(name)
        .getJobCounts('waiting', 'active', 'delayed', 'failed');

      for (const [state, count] of Object.entries(counts)) {
        rows.push([{ queue: name, state }, count]);
      }
    }
    return rows;
  }

  private async collectOutboxBacklog(): Promise<Array<[Labels, number]>> {
    const pending = await this.prisma.outboxEvent.count({ where: { processedAt: null } });
    return [[{}, pending]];
  }
}
