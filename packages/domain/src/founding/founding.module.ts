import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EconomyModule } from '../economy/economy.module';
import { FoundingService } from './founding.service';

/**
 * The launch campaign (v0.9.0).
 *
 * `CatalogModule` for `SettingsService` and `EconomyModule` for `CoinService`,
 * declared here rather than imported into the root: Nest scopes providers to the
 * module that declares them, and a provider reachable from the root graph but
 * not from this one resolves to `undefined` at request time rather than failing
 * at startup. `apps/{api,worker}/src/app.module.test.ts` builds both real graphs
 * and exists to catch exactly that.
 */
@Module({
  imports: [CatalogModule, EconomyModule],
  providers: [FoundingService],
  exports: [FoundingService],
})
export class FoundingModule {}
