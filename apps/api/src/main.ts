import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { EnvValidationError, loadEnv } from '@payetam/config';
import { registerCookies } from './admin/cookie.setup';
import { registerSecurityHeaders } from './common/security-headers';
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

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    bufferLogs: true,
  });

  // The admin panel authenticates with a cookie (ADR-0010), and a Fastify plugin
  // has to be registered before the instance boots — which is why this one thing
  // cannot live in AppModule the way the guard and the filter do.
  await registerCookies(app);
  registerSecurityHeaders(app, env.NODE_ENV === 'production');

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
  app.enableShutdownHooks();

  // 0.0.0.0 so the process is reachable from outside its container. Exposure is
  // controlled by nginx and the firewall, not by binding to localhost.
  await app.listen(env.API_PORT, '0.0.0.0');

  new Logger('Bootstrap').log(
    `API listening on port ${env.API_PORT} (env=${env.NODE_ENV}, tz=${env.APP_TIMEZONE})`,
  );
}

void bootstrap();
