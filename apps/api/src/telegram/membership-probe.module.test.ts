import { Global, Module, type ModuleMetadata, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MEMBERSHIP_PROBE } from '@payetam/domain';
import { ENV, RedisService } from '@payetam/platform';
import { describe, expect, it } from 'vitest';
import { MembershipProbeModule } from './membership-probe.module';

/**
 * The probe reaches a module that only imports it (v0.8.1).
 *
 * ── What was broken, and why nothing caught it ──────────────────────────────
 *
 * `MEMBERSHIP_PROBE` was registered in `AppModule`'s `providers` array.
 * `ChannelMembershipService` is declared in `ChannelModule`, which imports
 * `CatalogModule` and nothing else, so it never saw the token — Nest scopes
 * providers to the declaring module (`PROJECT_MEMORY` §7 trap 1). The injection
 * is `@Optional()`, so the graph resolved, the API booted, `app.module.test.ts`
 * passed, and the probe was `undefined` at every call site. Every channel then
 * answered `UNKNOWN/NO_PROBE`, which fails open by design — so the mandatory
 * membership requirement admitted everybody.
 *
 * ── What this test asserts ──────────────────────────────────────────────────
 *
 * The **shape**, behaviourally: a consumer declared in its own module, injecting
 * the port optionally exactly as `ChannelMembershipService` does, gets a probe.
 * Booting the real `ChannelModule` here would need Postgres and a clock and
 * would test the catalogue rather than the wiring; the leaf below is the same
 * injection in the same relationship to the same module, and it fails for the
 * same reason the real one did.
 *
 * The counterpart case is asserted too — a root-module provider does *not* cross
 * the boundary — because that is the fact the old comment in `app.module.ts` got
 * wrong, and a test that only proves the fix works would let somebody "simplify"
 * it straight back.
 */

/**
 * The modules are declared as plain classes and decorated by hand.
 *
 * Decorator *syntax* in a file the unit project transforms is what the harness
 * refuses; `Module({...})(Klass)` is the same call the syntax compiles to, and it
 * keeps this test in one file next to the module it is about.
 */
function asModule<T extends Type>(target: T, metadata: ModuleMetadata, global = false): T {
  Module(metadata)(target);
  if (global) Global()(target);
  return target;
}

/** Everything `TelegramMembershipProbe` needs, and nothing that talks to anything. */
class StubPlatformModule {}
asModule(
  StubPlatformModule,
  {
    providers: [
      { provide: ENV, useValue: { TELEGRAM_BOT_TOKEN: undefined } },
      { provide: RedisService, useValue: { client: {} } },
    ],
    exports: [ENV, RedisService],
  },
  true,
);

const CONSUMER = Symbol('CONSUMER');

/** `ChannelMembershipService`'s injection, in a module of its own. */
function consumerModule(): Type {
  return asModule(class ConsumerModule {}, {
    providers: [
      {
        provide: CONSUMER,
        useFactory: (probe: unknown) => ({ probe }),
        inject: [{ token: MEMBERSHIP_PROBE, optional: true }],
      },
    ],
    exports: [CONSUMER],
  });
}

async function probeSeenBy(root: Type): Promise<boolean> {
  const context = await NestFactory.createApplicationContext(root, { logger: false });
  const consumer = context.get<{ probe?: unknown }>(CONSUMER, { strict: false });
  const seen = consumer.probe !== undefined;
  await context.close();
  return seen;
}

describe('the membership probe module', () => {
  it('publishes the port to a module that declares its own consumer', async () => {
    const root = asModule(class RootModule {}, {
      imports: [StubPlatformModule, MembershipProbeModule, consumerModule()],
    });

    await expect(probeSeenBy(root)).resolves.toBe(true);
  });

  it('would not have, as a provider on the root module', async () => {
    const root = asModule(class RootModule {}, {
      imports: [StubPlatformModule, consumerModule()],
      providers: [{ provide: MEMBERSHIP_PROBE, useValue: { check: () => undefined } }],
    });

    await expect(probeSeenBy(root)).resolves.toBe(false);
  });
});
