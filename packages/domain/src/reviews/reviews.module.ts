import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module';
import { EconomyModule } from '../economy/economy.module';
import { ModerationModule } from '../moderation/moderation.module';
import { ReviewService } from './review.service';
// AuditModule and OutboxModule are @Global, so they need no import here.

/**
 * Blind reviews (plan §3.3, ADR-0011).
 *
 * `EconomyModule` for both halves of what a review moves: the reviewer's coins on
 * submission, and the reviewee's Trust Score at reveal. Reviews depend on the
 * economy and never the other way round — a ledger knows nothing about ratings.
 *
 * `ModerationModule` because a review comment is public free text about another
 * person, and it gets the same blacklist an event description does (§4.6).
 */
@Module({
  imports: [CatalogModule, EconomyModule, ModerationModule],
  providers: [ReviewService],
  exports: [ReviewService],
})
export class ReviewsModule {}
