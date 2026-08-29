import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';

/**
 * The worker's dependency graph resolves (M22 phase 13).
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 *
 * M22 wired the channel-membership gate into `EventService`,
 * `ParticipationService` and `InvitationService` — and did not add
 * `ChannelModule` to the three modules that declare them. Nest scopes providers
 * to the module that declares them, so importing both modules into the *root* is
 * not enough: the consuming module has to import the providing one.
 *
 * Nothing caught it. Unit tests construct services with `new`, integration tests
 * assemble them by hand, and the only thing that boots a real graph is the API's
 * response-leak scan. The worker had no equivalent at all. The symptom would have
 * been **both processes failing to start on deploy** — not a failing request, a
 * container that never becomes healthy.
 *
 * ── Why `preview: true` ──────────────────────────────────────────────────────
 *
 * It resolves the whole graph and instantiates **nothing**. That matters here
 * more than it usually would: `Processors` registers BullMQ consumers in
 * `onModuleInit`, and a test that booted the worker for real would start
 * pulling live jobs off the queue. Preview mode still raises "can't resolve
 * dependencies" — verified by removing the fix and watching this fail — so it
 * catches exactly the class of bug it is here for, and touches no database, no
 * Redis and no queue.
 */
describe('the worker application module', () => {
  it('resolves every provider it declares', async () => {
    const context = await NestFactory.createApplicationContext(AppModule, {
      preview: true,
      logger: false,
      abortOnError: false,
    });

    await expect(context.close()).resolves.not.toThrow();
  });
});
