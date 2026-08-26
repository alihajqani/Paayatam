import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';

/**
 * The API's dependency graph resolves (M22 phase 13).
 *
 * The companion to `apps/worker/src/app.module.test.ts`, and the same story: M22
 * added a service dependency across a module boundary without adding the import,
 * and the failure mode is a container that never starts rather than a request
 * that fails.
 *
 * The response-leak scan boots this same module and would also have caught it —
 * but it is an integration test that needs a database, takes minutes, and is
 * about something else entirely. A graph that does not resolve should fail in
 * seconds, in the unit suite, next to the thing that broke it.
 *
 * `preview: true` resolves without instantiating, so this needs no Postgres, no
 * Redis and no Telegram token.
 */
describe('the API application module', () => {
  it('resolves every provider it declares', async () => {
    const context = await NestFactory.createApplicationContext(AppModule, {
      preview: true,
      logger: false,
      abortOnError: false,
    });

    await expect(context.close()).resolves.not.toThrow();
  });
});
