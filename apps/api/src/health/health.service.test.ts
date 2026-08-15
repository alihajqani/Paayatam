import { describe, expect, it, vi } from 'vitest';
import { HealthService } from './health.service';
import type { PrismaService } from '@payetam/db';
import type { RedisService } from '@payetam/platform';

const stubPrisma = (up: boolean) =>
  ({ ping: vi.fn().mockResolvedValue(up) }) as unknown as PrismaService;
const stubRedis = (up: boolean) =>
  ({ ping: vi.fn().mockResolvedValue(up) }) as unknown as RedisService;

describe('HealthService', () => {
  it('reports ready when both dependencies are up', async () => {
    const service = new HealthService(stubPrisma(true), stubRedis(true));
    await expect(service.checkDependencies()).resolves.toEqual({
      ready: true,
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('reports not ready when the database is down', async () => {
    const service = new HealthService(stubPrisma(false), stubRedis(true));
    const result = await service.checkDependencies();
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe('down');
  });

  it('reports not ready when redis is down', async () => {
    const service = new HealthService(stubPrisma(true), stubRedis(false));
    const result = await service.checkDependencies();
    expect(result.ready).toBe(false);
    expect(result.checks.redis).toBe('down');
  });

  it('checks dependencies in parallel rather than in sequence', async () => {
    // A readiness probe that takes the sum of its checks eventually exceeds its own
    // timeout as dependencies are added. Assert concurrency, not just the result.
    const order: string[] = [];
    const slow = (label: string, ms: number) =>
      ({
        ping: vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, ms));
          order.push(label);
          return true;
        }),
      }) as unknown as PrismaService & RedisService;

    const service = new HealthService(slow('db', 30), slow('redis', 5));
    const started = Date.now();
    await service.checkDependencies();
    const elapsed = Date.now() - started;

    // Sequential would be ~35ms; parallel is bounded by the slower check.
    expect(elapsed).toBeLessThan(30 + 25);
    expect(order[0]).toBe('redis');
  });
});
