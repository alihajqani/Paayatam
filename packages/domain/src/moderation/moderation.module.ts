import { Module } from '@nestjs/common';
import { BlacklistService } from './blacklist.service';
import { ModerationService } from './moderation.service';

/**
 * Auto-moderation (plan §3.3, ADR-0012).
 *
 * M4 ships the normalizer, blacklist matching and case creation. Reports, the
 * report threshold and the human review workflow are M12; the re-scan job on a
 * blacklist bump rides the `moderation` queue and lands with the workers.
 */
@Module({
  providers: [BlacklistService, ModerationService],
  exports: [BlacklistService, ModerationService],
})
export class ModerationModule {}
