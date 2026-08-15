import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';
import { PrismaClient } from './generated/prisma/client';

/**
 * The Prisma client, managed by Nest's lifecycle.
 *
 * Lives in `packages/db` rather than in either app because both `apps/api` and
 * `apps/worker` need the same client against the same schema (ADR-0001). Duplicating
 * it would eventually mean two connection pools configured two different ways.
 *
 * Prisma 7 requires an explicit driver adapter — the bundled Rust query engine is
 * gone — so the connection is established through `pg` via {@link PrismaPg}.
 *
 * Transaction guidance for everything built on top of this:
 *
 *   - Capacity work takes `SELECT ... FOR UPDATE` on the event row *first* and holds
 *     no other lock (ADR-0006). `lockEventForUpdate` arrives with M6.
 *   - **No network calls inside a transaction** — no Telegram API, no HTTP, no file
 *     I/O. Notifications go through the outbox, which is a local insert (ADR-0005).
 *   - Prisma's interactive transactions time out after 5s by default. Raise it
 *     explicitly per call site when justified rather than globally.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(ENV) env: Env) {
    super({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Cheap liveness probe for the readiness endpoint. Deliberately `SELECT 1` rather
   * than a table read: readiness should answer "can I reach the database", not
   * "is the schema what I expect".
   */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(
        `Database ping failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return false;
    }
  }
}
