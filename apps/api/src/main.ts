import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EnvValidationError, loadEnv } from '@payetam/config';
import { AppLogger, MetricsRegistry } from '@payetam/platform';
import { registerCookies } from './admin/cookie.setup';
import { registerObservability } from './common/observability';
import { registerSecurityHeaders } from './common/security-headers';
import { resolveTrustProxy } from './common/trust-proxy';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Validate the environment before Nest constructs anything. A misconfigured
  // process should fail here with a complete list of problems, not halfway through
  // wiring modules with a partial error (packages/config).
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Deliberately console, not Logger: the logger is not configured yet, and
      // this must be readable in a container's startup output.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  /**
   * The logger is constructed *before* Nest, and handed in — so Nest's own startup
   * lines go through the redactor too (M15). A logger installed after
   * `NestFactory.create` misses exactly the messages that name every module and
   * route the process has, which is the part worth having structured.
   */
  const logger = new AppLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

  /**
   * `trustProxy` is what makes `request.ip` the *caller's* address rather than
   * nginx's (M20). Three things read that value and all three are wrong without
   * it behind a proxy: the IP rate-limit buckets (one shared bucket for the whole
   * internet), the `ip_hash` column in `audit_log` (one hash for everybody), and
   * `/metrics`, which allows private addresses and would see one on every request.
   *
   * Configured rather than hardcoded, and defaulting to off, because the same
   * image runs behind nginx in production and directly under `pnpm dev` locally —
   * and a process reached directly must trust nothing, or a client picks its own
   * apparent address by sending the header.
   */
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: resolveTrustProxy(env.TRUST_PROXY) }),
    { logger, bufferLogs: true },
  );

  // The admin panel authenticates with a cookie (ADR-0010), and a Fastify plugin
  // has to be registered before the instance boots — which is why this one thing
  // cannot live in AppModule the way the guard and the filter do.
  await registerCookies(app);
  registerSecurityHeaders(app, env.NODE_ENV === 'production');

  // Request ids and HTTP metrics, as Fastify hooks rather than a Nest interceptor —
  // a hook sees the 404s and the guard rejections an interceptor never reaches (M16).
  registerObservability(app, app.get(MetricsRegistry));

  // The exception filter is registered inside AppModule via APP_FILTER, not
  // here: it belongs to the application rather than to this entry point, and
  // registering it here meant anything else that composed AppModule got Nest's
  // generic 500 instead of the error catalogue.
  //
  // Request validation is a zod pipe over the shared schemas in
  // @payetam/shared, applied per route. Deliberately not Nest's class-validator
  // ValidationPipe: the frontends already validate with those zod schemas
  // (ADR-0003), and a second validation system would be a second set of rules
  // to keep in sync.
  /**
   * SIGTERM stops accepting connections and finishes what is in flight.
   *
   * `enableShutdownHooks` is what makes `onModuleDestroy` run at all — without it
   * Nest exits without closing the Prisma pool, the Redis connection or the BullMQ
   * queues, and Postgres is left reaping connections on a timeout. Fastify's own
   * close waits for in-flight requests, so a rolling deploy does not cut a response
   * in half.
   */
  app.enableShutdownHooks();

  // 0.0.0.0 so the process is reachable from outside its container. Exposure is
  // controlled by nginx and the firewall, not by binding to localhost.
  await app.listen(env.API_PORT, '0.0.0.0');

  logger.event('info', 'API listening', {
    port: env.API_PORT,
    env: env.NODE_ENV,
    tz: env.APP_TIMEZONE,
    // Logged because "the rate limiter is counting every user as one caller" has
    // no other visible symptom until it starts refusing people.
    trustProxy: env.TRUST_PROXY ?? 'none',
  });
}

void bootstrap();
