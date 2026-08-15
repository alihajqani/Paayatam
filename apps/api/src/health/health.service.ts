import { Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { RedisService } from '@payetam/platform';

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Both dependencies are checked in parallel — a readiness probe that takes the
   * sum of its checks starts failing its own timeout as dependencies are added.
   */
  async checkDependencies(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([this.prisma.ping(), this.redis.ping()]);

    return {
      ready: database && redis,
      checks: {
        database: database ? 'up' : 'down',
        redis: redis ? 'up' : 'down',
      },
    };
  }
}
