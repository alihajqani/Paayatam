import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EnvValidationError, loadEnv } from '@payetam/config';
import { AppModule } from './app.module';

/**
 * The worker is a Nest application *context*, not an HTTP server — it serves no
 * routes. It exists to run BullMQ processors (from M13).
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

  // Deliberately NOT `bufferLogs: true`. In an application *context* there is no
  // `listen()` to flush the buffer, so buffered logs are simply never emitted and
  // the worker starts up completely silently.
  const app = await NestFactory.createApplicationContext(AppModule);

  // Shutdown hooks matter more here than in the API: on SIGTERM the worker must
  // finish the job it is holding rather than abandoning it mid-way. An abandoned
  // job is recoverable (the outbox will redeliver) but redelivery is a retry, and
  // retries are only free because every job is idempotent (ADR-0005).
  app.enableShutdownHooks();

  const logger = new Logger('Bootstrap');
  logger.log(
    `Worker started (env=${env.NODE_ENV}, tz=${env.APP_TIMEZONE}, queuePrefix=${env.QUEUE_PREFIX})`,
  );
  logger.log('No queues registered yet — processors are added in M12/M13.');
}

void bootstrap();
