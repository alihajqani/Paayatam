import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EnvValidationError, loadEnv } from '@payetam/config';
import { AppModule } from './app.module';
import { AppExceptionFilter } from './common/app-exception.filter';

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

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  // Request validation arrives in M2 as a zod pipe over the shared schemas in
  // @payetam/shared. Deliberately not Nest's class-validator ValidationPipe: the
  // frontends already validate with those zod schemas (ADR-0003), and a second
  // validation system would be a second set of rules to keep in sync.
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableShutdownHooks();

  // 0.0.0.0 so the process is reachable from outside its container. Exposure is
  // controlled by nginx and the firewall, not by binding to localhost (M16).
  await app.listen(env.API_PORT, '0.0.0.0');

  new Logger('Bootstrap').log(
    `API listening on port ${env.API_PORT} (env=${env.NODE_ENV}, tz=${env.APP_TIMEZONE})`,
  );
}

void bootstrap();
