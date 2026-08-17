import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { EnvValidationError, loadEnv } from '@payetam/config';
import { AppLogger } from '@payetam/platform';
import { AppModule } from './app.module';

/**
 * The worker is a Nest application *context*, not an HTTP server — it serves no
 * routes. It runs the BullMQ processors: the outbox relay, the Telegram sender,
 * and the repeatable sweeps (ADR-0005).
 */
async function bootstrap(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  // `service: 'worker'` in every line, so the worker's output is separable from the
  // API's once both ship to the same place (M16).
  process.env['PAYETAM_SERVICE'] = 'worker';
  const logger = new AppLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

  // Deliberately NOT `bufferLogs: true`. In an application *context* there is no
  // `listen()` to flush the buffer, so buffered logs are simply never emitted and
  // the worker starts up completely silently.
  const app = await NestFactory.createApplicationContext(AppModule, { logger });

  // Shutdown hooks matter more here than in the API: on SIGTERM the worker must
  // finish the job it is holding rather than abandoning it mid-way. An abandoned
  // job is recoverable (the outbox will redeliver) but redelivery is a retry, and
  // retries are only free because every job is idempotent (ADR-0005).
  app.enableShutdownHooks();

  logger.event('info', 'Worker started', {
    env: env.NODE_ENV,
    tz: env.APP_TIMEZONE,
    queuePrefix: env.QUEUE_PREFIX,
  });
  // The processors register themselves in `onModuleInit`, which has already run
  // by this point — so by the time this line prints, the queues are live and the
  // repeatable sweeps are scheduled.
}

void bootstrap();
