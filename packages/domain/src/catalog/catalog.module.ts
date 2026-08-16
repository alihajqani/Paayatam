import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { SettingsService } from './settings.service';

/**
 * Catalog: cities, districts, categories, interests, and the `app_setting`
 * policy numbers (plan §3.3).
 *
 * Settings live here rather than in `platform` because they are product policy,
 * not infrastructure — the same admin screen that edits the interest list edits
 * the onboarding reward.
 */
@Module({
  providers: [CatalogService, SettingsService],
  exports: [CatalogService, SettingsService],
})
export class CatalogModule {}
