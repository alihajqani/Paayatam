import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { DiscoveryService } from './discovery.service';
import { PostgresSearchProvider } from './postgres-search.provider';
import { SEARCH_PROVIDER } from './search-provider';

/**
 * Discovery (plan §3.3, ADR-0012).
 *
 * The provider is bound to its token here and nowhere else, which is the whole
 * point of the seam: swapping in Meilisearch behind a feature flag is a change
 * to this one line, not to `DiscoveryService`.
 */
@Module({
  imports: [CatalogModule],
  providers: [DiscoveryService, { provide: SEARCH_PROVIDER, useClass: PostgresSearchProvider }],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
