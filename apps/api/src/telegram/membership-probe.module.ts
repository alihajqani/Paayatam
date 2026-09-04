import { Global, Module } from '@nestjs/common';
import { MEMBERSHIP_PROBE } from '@payetam/domain';
import { TelegramMembershipProbe } from './membership.probe';

/**
 * The membership probe, where `ChannelMembershipService` can actually see it.
 *
 * ── The bug this module exists to fix ───────────────────────────────────────
 *
 * `MEMBERSHIP_PROBE` was provided in `AppModule`'s own `providers` array, with a
 * comment saying that `ChannelMembershipService` would resolve it there. **Nest
 * does not work that way.** A provider is visible to a class declared in the
 * same module, or exported by a module that class's module imports — and
 * `ChannelMembershipService` is declared in `ChannelModule`, which imports
 * `CatalogModule` and nothing else. The root module's providers were invisible
 * to it.
 *
 * This is `PROJECT_MEMORY` §7 trap 1 a second time — "Nest scopes providers to
 * the declaring module, so a root import is not enough" — and this instance was
 * *quieter* than the first, because the injection is `@Optional()`. Nothing
 * failed to boot. The probe was simply always `undefined`, so `probeFor`
 * answered `{ kind: 'UNKNOWN', reason: 'NO_PROBE' }` for every channel, every
 * outcome except an authoritative `NOT_MEMBER` fails open by design, and the
 * mandatory-membership requirement therefore **let everybody through, on every
 * surface, since M22**. An operator who switched it on and watched nothing
 * happen was reading the feature correctly.
 *
 * ── Why `@Global()` and not an import in `ChannelModule` ────────────────────
 *
 * Because the dependency only points one way. `ChannelModule` lives in
 * `@payetam/domain`, which imports no HTTP framework and no grammY; the probe is
 * the one class in the product allowed to call Telegram synchronously and it
 * lives in `apps/api`. A domain module cannot import it without inverting the
 * layering the whole repository is built on — which is exactly why the port is a
 * symbol and the injection is `@Optional()` in the first place.
 *
 * `@Global()` is how every other cross-cutting port here is published:
 * `PrismaModule`, `ClockModule`, `EnvModule`, `RedisModule` and the metrics
 * registry are all global for the same reason. A deployment that imports this
 * module has a probe; the worker and every test do not, and get `UNKNOWN`, which
 * fails open exactly as before.
 */
@Global()
@Module({
  providers: [
    TelegramMembershipProbe,
    { provide: MEMBERSHIP_PROBE, useExisting: TelegramMembershipProbe },
  ],
  exports: [TelegramMembershipProbe, MEMBERSHIP_PROBE],
})
export class MembershipProbeModule {}
