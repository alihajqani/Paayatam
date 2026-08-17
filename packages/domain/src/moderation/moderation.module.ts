import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { BlacklistService } from './blacklist.service';
import { ModerationService } from './moderation.service';
import { ReportService } from './report.service';

/**
 * Auto-moderation (plan §3.3, ADR-0012).
 *
 * M4 shipped the normalizer, blacklist matching and case creation; M12 adds
 * reports and the threshold that acts on them. The human review workflow lives in
 * `adminaccess`, because deciding a case is an authorised admin action rather than
 * a moderation primitive — and the re-scan job on a blacklist bump rides the
 * `moderation` queue and lands with the workers.
 *
 * `CatalogModule` for `SettingsService`: the report threshold is a policy number,
 * so it is read from `app_setting` like every other one.
 */
@Module({
  imports: [CatalogModule],
  providers: [BlacklistService, ModerationService, ReportService],
  exports: [BlacklistService, ModerationService, ReportService],
})
export class ModerationModule {}
