import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { HelpGuideService } from './help-guide.service';
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
  providers: [CatalogService, SettingsService, HelpGuideService],
  exports: [CatalogService, SettingsService, HelpGuideService],
})
export class CatalogModule {}
